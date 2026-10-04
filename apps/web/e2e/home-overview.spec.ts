import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function create(request:APIRequestContext,kind='live'){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const response=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'首页接入验收 '+randomUUID().slice(0,5),sample_kind:kind}});
  expect(response.ok()).toBeTruthy();return {...await response.json(),headers};
}
function event(seq:number,extra:Record<string,unknown>={}){
  return {event_id:randomUUID(),producer_id:'home-ui',producer_seq:seq,occurred_at:new Date(Date.UTC(2026,9,4,0,0,seq)).toISOString(),kind:'llm',name:'LLM_REQUEST',...extra};
}

test('首页来源、实时接入反馈、用量范围及点击联动',async({page,request})=>{
  const run=await create(request);
  let paid=0;await page.route('**/api/runs/*/analyst-jobs',route=>{paid++;return route.abort();});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1366,height:768});await page.goto('/');
  await expect(page.getByRole('combobox',{name:'记录来源'})).toHaveValue('live');
  const feedback=page.getByRole('region',{name:'接入反馈'});
  await expect(feedback).toContainText('等待首条事件');
  await expect(feedback).toContainText('未收到检查记录');
  const items=[event(1,{correlation_id:'model'}),event(2,{name:'LLM_RESPONSE',correlation_id:'model',output:{usage_metadata:{input_tokens:10,output_tokens:2,total_tokens:12}}}),
    event(3,{kind:'tool_call',name:'run_tests',correlation_id:'tool'}),event(4,{kind:'tool_return',name:'run_tests',correlation_id:'tool',ok:false,output:{returncode:1}}),
    event(5,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'fixture-check','basis':'assert expected output'}})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{'home-ui':5}}})).ok()).toBeTruthy();
  await expect(feedback).toContainText('5 条已收到');
  await expect(feedback).toContainText('1 次 · 1 组返回');
  await expect(feedback).toContainText('1/1 响应有总用量');
  await expect(feedback).toContainText('验收未通过');
  await expect(feedback).toContainText('执行完成');
  await expect(feedback).toContainText('事件交付：完整');
  const row=page.locator('.workbench-run[href="/runs/'+run.run_id+'"]');
  await expect(row).toContainText('执行：执行完成');await expect(row).toContainText('验收：验收未通过');
  await page.getByRole('region',{name:'运行概览'}).getByRole('button',{name:/已记录 Token/}).click();
  const dialog=page.getByRole('dialog',{name:'最近运行的用量'});
  await expect(dialog).toContainText('最近 20 次入库记录');
  await dialog.locator('a[href="/runs/'+run.run_id+'"]').click();
  await expect(page).toHaveURL('/runs/'+run.run_id);
  await page.getByRole('link',{name:'运行工作台',exact:true}).click();
  await page.getByRole('combobox',{name:'记录来源'}).selectOption('synthetic');
  await expect(page.getByRole('region',{name:'接入反馈'})).not.toContainText(run.run_id);
  await expect(page.locator('.workbench-run[href="/runs/'+run.run_id+'"]')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  expect(paid).toBe(0);expect(errors).toEqual([]);
});

test('开始监控按需打开、说明真实能力，复制不执行；刷新失败保留旧数据',async({page,request})=>{
  await create(request);
  let executions=0;page.on('request',req=>{if(req.method()==='POST'&&(req.url().endsWith('/api/live/runs')||req.url().endsWith('/analyst-jobs')))executions++;});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{}}});});
  await page.goto('/');
  await expect(page.getByRole('region',{name:'接入反馈'})).toBeVisible();
  await page.getByRole('button',{name:'开始监控',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'开始监控',exact:true});
  await expect(dialog).toContainText('已有 Python Agent');
  await expect(dialog).toContainText('退出码 0 不等于任务通过');
  await expect(dialog).toContainText('对应模型／框架适配');
  await dialog.getByRole('button',{name:'复制命令',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'已复制',exact:true})).toBeVisible();
  expect(executions).toBe(0);
  await dialog.getByRole('button',{name:'无模型演示',exact:true}).click();
  await expect(dialog.locator('.monitor-command')).toContainText('--sample-kind synthetic');
  await expect(dialog).toContainText('示例不调用模型');
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  const old=await page.getByRole('region',{name:'运行概览'}).innerText();
  await page.route('**/api/overview?*',route=>route.fulfill({status:503,json:{detail:'controlled UI outage'}}));
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('刷新失败，保留上次数据');
  await expect(page.getByRole('region',{name:'运行概览'})).toHaveText(old,{useInnerText:true});
});

test('首次为空与来源为空分开，API在线不冒充Agent接入',async({page})=>{
  const empty={running:[],attention:[],recent:[],summary:{source:'live',running:0,attention:0,total_runs:0,all_runs:0,sample:{limit:20,count:0,items:[]},tokens:{value:null,responses:0,with_total:0,uncertain_events:0},feedback:null}};
  await page.route('**/api/overview?*',route=>route.fulfill({json:empty}));await page.goto('/');
  await expect(page.getByRole('heading',{name:'让你的第一次运行出现在这里'})).toBeVisible();
  await expect(page.getByRole('region',{name:'运行概览'}).getByRole('button',{name:/已记录 Token/})).toContainText('—');
  await page.unroute('**/api/overview?*');
  await page.route('**/api/overview?*',route=>route.fulfill({json:{...empty,summary:{...empty.summary,all_runs:3}}}));
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('region',{name:'接入反馈'})).toContainText('API 在线并不表示已有 Agent 上报');
  await expect(page.getByRole('heading',{name:'让你的第一次运行出现在这里'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'查看全部来源',exact:true})).toBeVisible();
});
