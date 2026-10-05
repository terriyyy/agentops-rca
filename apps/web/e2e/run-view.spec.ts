import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function fixture(request:APIRequestContext){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const response=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'Run视图控制第二批验收',sample_kind:'synthetic'}});
  expect(response.ok()).toBeTruthy();const run=await response.json();
  const items=[{kind:'tool_call',name:'read_file',correlation_id:'read',input:{path:'file.py'}},{kind:'tool_return',name:'read_file',correlation_id:'read',ok:true,output:'hello'},
    ...Array.from({length:18},(_,index)=>({kind:'event',name:'step-'+index})),
    {kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'fixture-check',basis:'expected two lines'}}
  ].map((item,index)=>({event_id:randomUUID(),producer_id:'view',producer_seq:index+1,occurred_at:new Date(Date.UTC(2026,9,4,1,0,index)).toISOString(),...item}));
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events:items}});
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:0,producers:{view:items.length}}});
  const events=(await(await request.get(`/api/runs/${run.run_id}/events`)).json()).items;
  return {run,events};
}
async function settings(page:Page){await page.getByRole('button',{name:'视图设置',exact:true}).click();const menu=page.getByRole('dialog',{name:'运行视图设置',exact:true});await expect(menu).toBeVisible();return menu;}

test('专注模式保留选中筛选时间窗及分栏，退出与离开Run恢复导航',async({page,request})=>{
  const {run}=await fixture(request);await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  await page.getByRole('button',{name:'选择工具执行 1 read_file',exact:true}).click();await page.getByLabel('事件类型',{exact:true}).selectOption('tool');
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();
  const state={id:await page.locator('.console-event.selected').getAttribute('data-event-id'),start:await page.locator('.time-ruler').getAttribute('data-view-start'),end:await page.locator('.time-ruler').getAttribute('data-view-end'),split:await page.getByRole('separator').getAttribute('aria-valuenow'),width:(await page.locator('.execution-pane').boundingBox())!.width};
  await (await settings(page)).getByRole('button',{name:'专注模式',exact:true}).click();await expect(page.locator('.sidebar')).toBeHidden();await expect(page.getByRole('button',{name:'退出专注',exact:true})).toBeVisible();
  expect((await page.locator('.execution-pane').boundingBox())!.width).toBeGreaterThan(state.width);await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',state.id!);
  await expect(page.getByLabel('事件类型',{exact:true})).toHaveValue('tool');await expect(page.locator('.time-ruler')).toHaveAttribute('data-view-start',state.start!);await expect(page.locator('.time-ruler')).toHaveAttribute('data-view-end',state.end!);await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow',state.split!);
  await page.getByRole('button',{name:'退出专注',exact:true}).click();await expect(page.locator('.sidebar')).toBeVisible();await expect(page.getByRole('button',{name:'视图设置',exact:true})).toBeFocused();
  await (await settings(page)).getByRole('button',{name:'专注模式',exact:true}).click();await page.getByRole('link',{name:'返回运行工作台',exact:true}).click();await expect(page.locator('.sidebar')).toBeVisible();await expect(page.locator('.run-focus')).toHaveCount(0);
  await page.locator('.sidebar').getByRole('link',{name:'任务历程',exact:true}).click();await expect(page.getByRole('button',{name:'视图设置',exact:true})).toHaveCount(0);
});

test('舒适与紧凑有实际密度差异，偏好会话保留且不改变条形时间和事实',async({page,request})=>{
  const {run}=await fixture(request);await page.goto('/runs/'+run.run_id);await page.locator('.console-event').first().click();
  const initial=await page.locator('.console-event').first().evaluate(el=>({height:getComputedStyle(el).height,font:getComputedStyle(el.querySelector('strong')!).fontSize}));expect(initial.height).toBe('52px');expect(initial.font).toBe('15px');
  const bar=await page.locator('.duration-bar').getAttribute('style'),statuses=await page.locator('.console-states').textContent();
  const menu=await settings(page);await expect(menu.getByRole('button',{name:'舒适',exact:true})).toBeFocused();await page.keyboard.press('ArrowRight');
  await expect(menu.getByRole('button',{name:'紧凑',exact:true})).toBeFocused();await expect(page.locator('.run-console')).toHaveClass(/density-compact/);
  expect(await page.locator('.console-event').first().evaluate(el=>getComputedStyle(el).height)).toBe('36px');expect(await page.locator('.console-event-name strong').first().evaluate(el=>parseInt(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  await expect(page.locator('.duration-bar')).toHaveAttribute('style',bar!);expect(await page.locator('.console-states').textContent()).toBe(statuses);
  await page.keyboard.press('Escape');await page.reload();await expect(page.locator('.run-console')).toHaveClass(/density-compact/);await expect(page.locator('.sidebar')).toBeVisible();
  await (await settings(page)).getByRole('button',{name:'舒适',exact:true}).click();await expect(page.locator('.run-console')).toHaveClass(/density-comfortable/);
});

test('设置支持外部关闭、Esc焦点恢复，保留原因分析；无存储和窄屏仍可操作',async({page,request})=>{
  const {run}=await fixture(request);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('storage blocked');};Storage.prototype.setItem=()=>{throw new Error('storage blocked');};});
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();await settings(page);await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'运行视图设置',exact:true})).toBeHidden();await expect(page.getByRole('button',{name:'视图设置',exact:true})).toBeFocused();await expect(page.locator('#analysis-panel')).toBeVisible();
  await settings(page);await page.locator('.topbar>div:first-child>strong').click();await expect(page.getByRole('dialog',{name:'运行视图设置',exact:true})).toBeHidden();await expect(page.locator('#analysis-panel')).toBeVisible();
  await page.setViewportSize({width:390,height:844});await (await settings(page)).getByRole('button',{name:'紧凑',exact:true}).click();await expect(page.locator('.run-console')).toHaveClass(/density-compact/);
  const rect=(await page.getByRole('dialog',{name:'运行视图设置',exact:true}).boundingBox())!;expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'专注模式',exact:true}).click();await expect(page.locator('.sidebar')).toBeHidden();expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);expect(errors).toEqual([]);
});

test('仅可靠事件定位产生短暂提示，原件仍可追溯且诊断不改变检查结果',async({page,request})=>{
  const {run,events}=await fixture(request);const report={diagnosis_id:'view-fixture',mode:'analyst_rca',origin:'recomputed',format:'fixture',source_algorithm:'fixture',model_status:'ready',model_reason:null,raw_evidence_id:events[0].evidence_id,summary:'当前证据不足以确定原因。',findings:[{title:'工具记录',severity:'info',description:'引用成功工具',evidence:[{evidence_id:events[0].evidence_id,event_id:events[0].event_id,resolution_status:'resolved',label:'read_file'}]}],graph:null,guidance:null,boundary:null,verification_suggestion:null};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));let posts=0;await page.route('**/api/runs/*/analyst-jobs',route=>{posts++;return route.abort();});
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();await page.getByRole('button',{name:'#01 read_file · 调用参数',exact:true}).click();
  await expect(page.locator('.console-event.located')).toHaveAttribute('data-event-id',events[0].event_id);await expect(page.locator('.peek-scroll .source-code')).toContainText('file.py');
  await expect(page.locator('.console-states')).toContainText('验收未通过');await expect(page.locator('.execution-item.failed')).toHaveCount(0);
  await expect(page.locator('.console-event.located')).toHaveCount(0);expect(posts).toBe(0);
});
