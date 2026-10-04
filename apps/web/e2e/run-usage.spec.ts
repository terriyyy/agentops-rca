import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function create(request:APIRequestContext){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const result=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'用量摘要交互验收',sample_kind:'synthetic'}});
  expect(result.ok()).toBeTruthy();return {...await result.json(),headers};
}
function event(seq:number,extra:Record<string,unknown>={}){
  return {event_id:randomUUID(),producer_id:'usage-ui',producer_seq:seq,occurred_at:new Date(Date.UTC(2026,9,4,0,0,seq)).toISOString(),kind:'llm',name:'LLM_REQUEST',...extra};
}

test('模型去重计数、用量覆盖、摘要筛选与明细定位',async({page,request})=>{
  const run=await create(request);
  const items=[event(1,{correlation_id:'first',input:{model:'test-model'}}),
    event(2,{correlation_id:'first',name:'LLM_RESPONSE',duration_ms:1000,output:{model:'test-model',usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120},content:'first result'}}),
    event(3,{kind:'tool_call',name:'read_file',correlation_id:'tool',input:{path:'fixture.txt'}}),
    event(4,{kind:'tool_return',name:'read_file',correlation_id:'tool',ok:true,duration_ms:1000,output:{text:'read result'}}),
    event(5,{correlation_id:'second',input:{model:'test-model'}}),
    event(6,{correlation_id:'second',name:'LLM_RESPONSE',output:{model:'test-model',content:'no usage supplied'}})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{'usage-ui':6}}})).ok()).toBeTruthy();
  const metrics=await (await request.get(`/api/runs/${run.run_id}/metrics`)).json();
  let paidRequests=0;await page.route('**/api/runs/*/analyst-jobs',route=>{paidRequests++;return route.abort();});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  const strip=page.getByRole('region',{name:'本次运行用量'});
  await expect(strip.getByRole('button',{name:/模型调用/})).toContainText('2');
  await expect(strip.getByRole('button',{name:/工具调用/})).toContainText('1');
  await expect(strip.getByRole('button',{name:/已记录 Token/})).toContainText('120');
  await expect(strip).toContainText('1/2 响应有总用量');
  await strip.getByRole('button',{name:/模型调用/}).click();
  await expect(page.getByRole('combobox',{name:'事件类型'})).toHaveValue('llm');
  await expect(page.locator('.console-event')).toHaveCount(4);
  await page.getByRole('button',{name:'选择事件 2 LLM_RESPONSE',exact:true}).click();
  await expect(page.getByRole('region',{name:'选中模型调用用量'})).toContainText('120');
  await strip.getByRole('button',{name:/工具调用/}).click();
  await expect(page.locator('.console-event')).toHaveCount(1);
  await expect(page.locator('.console-event.selected')).toContainText('read_file');
  await strip.getByRole('button',{name:/已记录 Token/}).click();
  const dialog=page.getByRole('dialog',{name:'模型调用与用量'});
  await expect(dialog.locator('tbody tr')).toHaveCount(2);
  await expect(dialog).toContainText('平台 RCA 用量单独保留');
  await dialog.locator('tbody tr').last().getByRole('button').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'事件类型'})).toHaveValue('');
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',metrics.llm.calls[1].event_id);
  await expect(page.getByRole('region',{name:'选中模型调用用量'})).toContainText('此响应未提供用量');
  await page.getByRole('tab',{name:'原始证据',exact:true}).click();
  await expect(page.locator('.source-code')).toContainText('no usage supplied');
  const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:window.innerWidth,trace:document.querySelector('.execution-scroll')!.getBoundingClientRect().height}));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);expect(dimensions.trace).toBeGreaterThan(140);
  expect(paidRequests).toBe(0);expect(errors).toEqual([]);
});

test('运行中用量随采集更新，未知用量不显示零',async({page,request})=>{
  const run=await create(request);await page.goto('/runs/'+run.run_id);
  const strip=page.getByRole('region',{name:'本次运行用量'});
  await expect(strip).toContainText('实时累计');
  await expect(strip.getByRole('button',{name:/已记录 Token/})).toContainText('—');
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:[event(1,{correlation_id:'live',input:{model:'test'}})]}})).ok()).toBeTruthy();
  await expect(strip.getByRole('button',{name:/模型调用/}).locator('.usage-metric-value')).toHaveText('1次');
  await expect(strip).toContainText('1 次待返回');
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:[event(2,{correlation_id:'live',name:'LLM_RESPONSE',output:{usage_metadata:{input_tokens:0,output_tokens:0,total_tokens:0}}})]}})).ok()).toBeTruthy();
  await expect(strip.getByRole('button',{name:/已记录 Token/})).toContainText('0');
  await expect(strip).toContainText('1/1 响应有总用量');
  await expect(strip.getByRole('button',{name:/模型调用/}).locator('.usage-metric-value')).toHaveText('1次');
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{'usage-ui':2}}})).ok()).toBeTruthy();
});
