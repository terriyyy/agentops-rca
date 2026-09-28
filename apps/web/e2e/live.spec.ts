import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const root=path.resolve('../..');
const python=path.join(root,'.venv/Scripts/python.exe');

test('CLI → 工具开始先于结束 → 实时轨迹 → 验收证据 → 刷新恢复',async({page,request,baseURL})=>{
  const child=spawn(python,['-m','agentops_cli.cli','run','--server',baseURL!,'--sample-kind','synthetic','--goal','浏览器现场闭环','--spool-dir',path.join(root,'.local/browser-spool'),'--',python,'examples/local_agent.py','--fail','--delay','4','--tool-delay','3'],{cwd:root,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let output='';child.stdout.on('data',chunk=>output+=chunk.toString());
  const completion=new Promise<number|null>(resolve=>child.on('exit',resolve));
  try{
    await expect.poll(()=>output.match(/\/runs\/([a-f0-9]+)/)?.[1]).toBeTruthy();
    const id=output.match(/\/runs\/([a-f0-9]+)/)![1];
    await page.goto('/runs/'+id);
    await expect(page.locator('.live-monitor')).toContainText('网页实时连接');
    await page.getByRole('button',{name:'查看实时轨迹'}).click();
    await expect(page.locator('.trace-row').filter({hasText:'write_solution'}).first()).toBeVisible();
    expect(await page.locator('.trace-row').filter({hasText:'write_solution'}).filter({hasText:'tool_return'}).count()).toBe(0);
    expect((await (await request.get('/api/runs/'+id)).json()).execution_status).toBe('running');
    await page.getByRole('button',{name:'暂停跟随',exact:true}).click();
    await expect(page.getByText('已暂停跟随 · 可查看旧记录')).toBeVisible();
    expect(await completion).toBe(0);
    await expect(page.locator('.run-status')).toContainText('完整');
    await expect(page.locator('.run-status')).toContainText('执行完成');
    await expect(page.locator('.run-status')).toContainText('验收未通过');
    await page.getByRole('button',{name:'追溯验收记录',exact:true}).click();
    await expect(page.locator('.source-code')).toContainText('python-assertion');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('.run-status')).toContainText('完整');
    await page.screenshot({path:'../../.local/screenshots/v02-live.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:'../../.local/screenshots/v02-live-mobile.png',fullPage:true});
  } finally {if(child.exitCode===null)child.kill();}
});

test('SSE 浏览器重连、分页跟随与 100 条事件显示延迟',async({page,request,context})=>{
  test.setTimeout(90000);
  const token=randomUUID()+randomUUID();
  const headers={Authorization:'Bearer '+token};
  const created=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'合成协议延迟检查',sample_kind:'synthetic'}});
  expect(created.ok()).toBeTruthy();
  const {run_id:id}=await created.json();
  await page.goto('/runs/'+id);
  await expect(page.locator('.live-monitor')).toContainText('网页实时连接');
  await page.getByRole('button',{name:'查看实时轨迹'}).click();
  // Record first DOM appearance for each protocol event, rather than API timing.
  await page.evaluate(()=>{
    const measurements:Record<string,number>={};
    (window as any).__measurements=measurements;
    new MutationObserver(()=>document.querySelectorAll('.trace-row strong').forEach(el=>{
      const text=el.textContent||'';
      if(text.startsWith('latency-')&&measurements[text]===undefined)measurements[text]=Date.now();
    })).observe(document.body,{subtree:true,childList:true});
  });
  const samples:number[]=[];
  let seq=0;
  async function batch(size:number,prefix:string){
    const sent=Date.now();
    const events=Array.from({length:size},()=>({event_id:randomUUID(),producer_id:'browser',producer_seq:++seq,occurred_at:new Date(sent).toISOString(),kind:'log',name:prefix+seq,output:'synthetic protocol fixture'}));
    expect((await request.post(`/api/live/runs/${id}/events`,{headers,data:{events}})).ok()).toBeTruthy();
    await expect(page.locator('.trace-row').filter({hasText:prefix+seq})).toBeVisible();
    if(prefix==='latency-'){
      const values=await page.evaluate(()=> (window as any).__measurements);
      for(const e of events){expect(values[e.name]).toBeDefined();samples.push(values[e.name]-sent);}
    }
  }
  for(let i=0;i<10;i++)await batch(10,'latency-');
  await context.setOffline(true);
  await batchWhileOffline();
  async function batchWhileOffline(){
    const e={event_id:randomUUID(),producer_id:'browser',producer_seq:++seq,occurred_at:new Date().toISOString(),kind:'log',name:'after-offline',output:'retained'};
    expect((await request.post(`/api/live/runs/${id}/events`,{headers,data:{events:[e]}})).ok()).toBeTruthy();
  }
  await context.setOffline(false);
  await expect(page.locator('.trace-row').filter({hasText:'after-offline'})).toBeVisible({timeout:15000});
  expect(await page.locator('.trace-row').filter({hasText:'after-offline'}).count()).toBe(1);
  await request.post(`/api/live/runs/${id}/finish`,{headers,data:{exit_code:0,producers:{browser:seq}}});
  const sorted=[...samples].sort((a,b)=>a-b);const p95=sorted[Math.ceil(sorted.length*.95)-1];
  fs.mkdirSync(path.join(root,'.local'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local/live-latency.json'),JSON.stringify({sample_count:samples.length,p95_ms:p95,max_ms:Math.max(...samples),source:'synthetic events → HTTP ingest → SSE → Edge DOM',samples},null,2));
  expect(samples.length).toBe(100);expect(p95).toBeLessThanOrEqual(2000);
});
