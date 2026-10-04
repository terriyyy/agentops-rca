import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function fixture(request:APIRequestContext){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const created=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'Run级分析侧面板验收',sample_kind:'synthetic'}});
  expect(created.ok()).toBeTruthy();const run=await created.json();
  const items=[
    {kind:'tool_call',name:'list_labels',correlation_id:'exact',input:{scope:'mailbox'}},
    {kind:'tool_return',name:'list_labels',correlation_id:'exact',ok:true,duration_ms:1000,output:{labels:['inbox']}},
    {kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'external-check',basis:'expected label missing'}},
  ].map((e,i)=>({event_id:randomUUID(),producer_id:'ui',producer_seq:i+1,occurred_at:new Date(Date.UTC(2026,9,4,0,0,i+1)).toISOString(),...e}));
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:0,producers:{ui:3}}});
  const events=(await (await request.get(`/api/runs/${run.run_id}/events`)).json()).items;
  return {run,events};
}

test('RCA使用完整侧面板，成功证据不变成失败，摘要节选与完整原文可追溯',async({page,request})=>{
  const {run,events}=await fixture(request);
  const summary='现有证据无法确定实际根因。'+('具体说明保留原始报告表达，不根据关键词重写结论；'.repeat(18));
  const report={diagnosis_id:'side-fixture',mode:'analyst_rca',origin:'recomputed',format:'fixture',source_algorithm:'fixture',model_status:'ready',model_reason:null,raw_evidence_id:events[0].evidence_id,summary,findings:[{title:'引用成功执行的记录',severity:'info',description:'引用并不意味着失败',evidence:events.slice(0,2).map((e:Record<string,string>)=>({evidence_id:e.evidence_id,event_id:e.event_id,resolution_status:'resolved',label:'成功工具原件'}))}],graph:null,guidance:null,boundary:'成功反馈不足以确定后续任务失败的原因。',verification_suggestion:'核对外部检查记录并在本机重新验证。'};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));
  await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'unavailable',analyst:'unconfigured',reason:'UI fixture'}}));
  let posts=0;await page.route('**/api/runs/*/analyst-jobs',route=>{posts++;return route.abort();});await page.route('**/api/runs/*/diagnosis-jobs',route=>route.request().method()==='POST'?(posts++,route.abort()):route.fulfill({json:[]}));
  await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  await expect(page.locator('#check-panel')).toBeVisible();await expect(page.locator('.console-states')).toContainText('执行完成');await expect(page.locator('.console-states')).toContainText('验收未通过');
  await page.locator('.console-event').first().click();
  const selected=await page.locator('.console-event.selected').getAttribute('data-event-id');
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();const range=await page.locator('.time-ruler').getAttribute('data-view-end');
  await page.locator('.console-header .run-analysis-trigger').click();
  await expect(page.locator('.run-investigation')).toBeVisible();expect((await page.locator('.run-investigation').boundingBox())!.height).toBeGreaterThan(400);
  await expect(page.locator('.run-dock')).toHaveCount(0);await expect(page.locator('.hypothesis-statement')).toHaveText('现有证据无法确定实际根因。');await expect(page.locator('.excerpt-label')).toHaveText('摘要原文节选');
  await expect(page.locator('.analysis-result-heading')).toContainText('待验证');await expect(page.locator('.analysis-evidence-row')).toHaveCount(1);await expect(page.locator('.evidence-row-heading .passed')).toHaveText('成功');await expect(page.locator('.evidence-row-links .evidence-chip')).toHaveCount(2);await expect(page.locator('.execution-item.failed')).toHaveCount(0);
  const evidenceRect=(await page.locator('.analysis-evidence-row').boundingBox())!,readingRect=(await page.locator('.analysis-reading').boundingBox())!;
  expect(evidenceRect.y+evidenceRect.height).toBeLessThanOrEqual(readingRect.y+readingRect.height);
  await expect(page.locator('.analysis-limits')).not.toHaveAttribute('open');
  await page.getByRole('button',{name:'展开摘要原文',exact:true}).click();await expect(page.locator('.hypothesis-statement')).toHaveText(summary);await page.getByRole('button',{name:'收起摘要原文',exact:true}).click();
  await page.getByRole('button',{name:'查看完整报告',exact:true}).click();await expect(page.getByRole('dialog')).toContainText(summary);await expect(page.getByRole('dialog')).toContainText(report.boundary);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'关闭运行调查',exact:true}).click();await expect(page.locator('.event-inspector')).toBeVisible();await expect(page.locator('.console-header .run-analysis-trigger')).toBeFocused();await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);expect(await page.locator('.time-ruler').getAttribute('data-view-end')).toBe(range);
  for(const [width,height] of [[1440,1000],[1366,768],[390,844]]){await page.setViewportSize({width,height});await page.locator('.run-analysis-trigger').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();if(width>=1366)expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBeTruthy();await page.getByRole('button',{name:'关闭运行调查',exact:true}).click();}
  expect(posts).toBe(0);
});

test('原件检查与事件详情可返回分析，滚动位置保持且任务检查独立',async({page,request})=>{
  const {run,events}=await fixture(request);
  const report={diagnosis_id:'evidence-navigation',mode:'analyst_rca',origin:'recomputed',format:'fixture',source_algorithm:'fixture',model_status:'ready',model_reason:null,raw_evidence_id:events[0].evidence_id,summary:'还不能确定原因。',findings:[{title:'查看原件',severity:'info',description:'保持真实配对',evidence:events.slice(0,2).map((e:Record<string,string>)=>({evidence_id:e.evidence_id,event_id:e.event_id,resolution_status:'resolved',label:'工具证据'}))}],graph:null,guidance:null,verification_suggestion:'在终端重新执行检查。'.repeat(70)};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'unavailable',analyst:'unconfigured',reason:'fixture'}}));
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();
  await page.locator('.analysis-reading').evaluate(el=>{el.scrollTop=25;});const before=await page.locator('.analysis-reading').evaluate(el=>el.scrollTop);
  await page.getByRole('button',{name:'#02 list_labels · 返回',exact:true}).click();await expect(page.locator('.peek-scroll .source-code')).toContainText('inbox');await expect(page.locator('.peek-scroll [role=status]')).toHaveText('已定位报告引用的执行事件');await expect(page.locator('.run-investigation')).toBeVisible();await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',events[0].event_id);await expect(page.locator('.event-inspector')).toBeHidden();
  await page.getByRole('button',{name:'返回原因分析',exact:true}).click();await expect(page.getByRole('button',{name:'#02 list_labels · 返回',exact:true})).toBeFocused();expect(await page.locator('.analysis-reading').evaluate(el=>el.scrollTop)).toBe(before);await expect(page.locator('.analysis-evidence-row.active')).toHaveCount(1);
  await page.getByRole('button',{name:'#01 list_labels · 调用参数',exact:true}).click();await page.getByRole('button',{name:'查看事件详情',exact:true}).click();await expect(page.locator('.event-inspector')).toBeVisible();await expect(page.locator('.event-inspector .event-value').first()).toContainText('mailbox');await page.getByRole('button',{name:'返回原因分析',exact:true}).click();await expect(page.locator('#analysis-panel')).toBeVisible();
  await page.getByRole('tab',{name:/^任务检查/}).click();await expect(page.locator('#check-panel')).toContainText('expected label missing');await expect(page.locator('#check-panel')).toContainText('external-check');await expect(page.locator('#check-panel')).toContainText('平台未复跑');await expect(page.locator('.console-states')).toContainText('验收未通过');
  await page.getByRole('tab',{name:/^原因分析/}).click();await expect(page.locator('.hypothesis-statement')).toHaveText(report.summary);expect(await page.locator('.analysis-reading').evaluate(el=>el.scrollTop)).toBe(before);
  // A delayed evidence response must not replace a newer user selection.
  const original=await (await request.get('/api/evidence/'+events[0].evidence_id)).json();
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/evidence/'+events[0].evidence_id,async route=>{await pending;await route.fulfill({json:original});});
  await page.getByRole('button',{name:'#01 list_labels · 调用参数',exact:true}).click();await expect(page.locator('.peek-scroll')).toContainText('定位证据');
  await page.getByRole('button',{name:'关闭运行调查',exact:true}).click();await page.locator('.console-event').last().click();
  const response=page.waitForResponse(r=>r.url().endsWith('/evidence/'+events[0].evidence_id));release();await response;
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',events[2].event_id);await expect(page.locator('.run-investigation')).toBeHidden();await expect(page.locator('.event-inspector .inspector-tabs [aria-selected=true]')).toHaveText('详情');
});


test('结构化检查依据默认收起，原字段与原件保留且不改变失败结果',async({page,request})=>{
  const {run,events}=await fixture(request);
  const basis={checks:[{name:'label assertion',expected:2,actual:1,query:'SELECT COUNT(*) FROM labels'}],source_details:'完整原字段'};
  await page.route(`**/api/runs/${run.run_id}/outcomes`,route=>route.fulfill({json:[{outcome_id:'structured-check',status:'failed',source:'database-check',basis,summary:'标签数量与检查预期不一致。',authoritative:true,evidence_id:events[2].evidence_id,reward:null,source_kind:'outcome'}]}));
  await page.goto('/runs/'+run.run_id);await expect(page.locator('#check-panel')).toBeVisible();await expect(page.locator('.check-basis')).not.toHaveAttribute('open');await expect(page.locator('.check-row>summary')).not.toContainText('SELECT');await expect(page.locator('.check-record')).toContainText('标签数量');await expect(page.locator('.console-states')).toContainText('验收未通过');
  await page.locator('.check-basis>summary').click();await expect(page.locator('.check-basis pre')).toHaveText(JSON.stringify(basis,null,2));await page.getByRole('button',{name:'查看检查记录',exact:true}).click();await expect(page.locator('.peek-scroll .source-code')).toContainText('expected label missing');
});
