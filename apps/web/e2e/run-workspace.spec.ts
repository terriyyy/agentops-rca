import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function create(request:APIRequestContext,goal:string){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const result=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal,sample_kind:'synthetic'}});
  expect(result.ok()).toBeTruthy();return {...await result.json(),headers};
}
function event(seq:number,extra:Record<string,unknown>={}){
  return {event_id:randomUUID(),producer_id:'ui',producer_seq:seq,occurred_at:new Date(Date.UTC(2026,8,28,0,0,seq)).toISOString(),kind:'log',name:'event-'+seq,output:'record '+seq,...extra};
}

test('跨页证据定位、选择保持、失败日志和桌面工作区',async({page,request})=>{
  const run=await create(request,'跨页调查工作台验收');
  const items=Array.from({length:62},(_,i)=>event(i+1));
  items[55]=event(56,{kind:'tool_call',name:'run_tests',correlation_id:'unique-test',input:{command:'pytest'},output:null});
  items[56]=event(57,{kind:'tool_return',name:'run_tests',correlation_id:'unique-test',ok:false,duration_ms:1000,error_signature:'AssertionError: expected 2',output:{returncode:1,stderr:'AssertionError: expected 2',stdout:'one test failed'}});
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:62}}})).ok()).toBeTruthy();
  const all=await (await request.get(`/api/runs/${run.run_id}/events?limit=100`)).json();
  const target=all.items[56];
  // Controlled report data exercises the UI; no algorithm or model invocation.
  const report={diagnosis_id:'ui-hypothesis',mode:'analyst_rca',origin:'recomputed',format:'ui-fixture',source_algorithm:'synthetic-ui-fixture',model_status:'ready',model_reason:null,raw_evidence_id:target.evidence_id,summary:'待验证：工具测试返回失败。',findings:[{title:'检查测试输出',severity:'warn',description:'仅用于界面交互验收',evidence:[{evidence_id:target.evidence_id,event_id:target.event_id,resolution_status:'resolved',label:'run_tests'}]}],graph:null,guidance:null,verification_suggestion:'尚未执行',boundary:'合成界面夹具'};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));
  let modelPosts=0;
  await page.route('**/api/runs/*/analyst-jobs',route=>{modelPosts++;return route.abort();});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  await expect(page.locator('.console-event.selected')).toContainText('run_tests');
  await expect(page.locator('.console-states')).toContainText('执行完成');await expect(page.locator('.console-states')).toContainText('验收未知');
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  await page.locator('.console-event').first().click();
  const before=await page.locator('.execution-scroll').evaluate(el=>el.scrollTop);
  await page.locator('.console-event').nth(1).click();
  expect(await page.locator('.execution-scroll').evaluate(el=>el.scrollTop)).toBe(before);
  await page.getByRole('tab',{name:/^根因假设/}).click();
  await expect(page.locator('.full-report')).not.toHaveAttribute('open');
  await page.locator('.hypothesis-evidence .evidence-chip.resolved').click();
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',all.items[55].event_id);
  await expect(page.locator('.source-code')).toContainText('expected 2');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(page.locator('.selected-error')).toContainText('AssertionError');
  await expect(page.locator('.event-facts').first()).toContainText('pytest');
  await expect(page.locator('.event-origin-links .evidence-location')).toHaveCount(2);
  await page.locator('.execution-item.failed .inline-failure>button').click();
  await expect(page.locator('.inline-failure pre')).toContainText('expected 2');
  await page.getByLabel('搜索事件').fill('event-1');
  await expect(page.locator('.workspace-notice').filter({hasText:'选中事件不在当前'})).toBeVisible();
  await page.getByRole('button',{name:'定位并显示'}).click();
  await expect(page.getByLabel('搜索事件')).toHaveValue('');
  await expect(page.locator('.console-event.selected')).toBeVisible();
  await page.screenshot({path:'../../.local/screenshots/v04-console-failed-1366.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight)).toBeTruthy();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  const height=await page.locator('.run-dock').evaluate(el=>el.getBoundingClientRect().height);
  await page.getByRole('separator',{name:'调整调查面板高度'}).focus();await page.keyboard.press('ArrowUp');
  expect(await page.locator('.run-dock').evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(height);
  await page.getByRole('tab',{name:'技术详情'}).click();
  await expect(page.locator('.technical-group')).toHaveCount(3);
  await expect(page.locator('.technical-group[open]')).toHaveCount(0);
  await expect(page.locator('.diagnosis-job')).toHaveCount(0);
  expect(modelPosts).toBe(0);expect(errors).toEqual([]);
});

test('真实父子关系与时间区间才绘制，普通日志不成为子 Span',async({page,request})=>{
  const run=await create(request,'真实关系与时间展示验收');
  const items=[event(1,{kind:'event',name:'RUN_START',source_span_id:'actual-root'}),event(2,{kind:'tool_call',name:'read_file',source_span_id:'actual-child',parent_source_id:'actual-root',correlation_id:'file',output:null}),event(3,{name:'stdout'}),event(4,{kind:'tool_return',name:'read_file',correlation_id:'file',ok:true,duration_ms:2000}),event(5,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'passed',source:'deterministic-check',basis:'assert output'},output:null})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:5}}});
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.execution-caption')).toContainText('来源关系树');
  await expect(page.locator('.duration-bar')).toHaveCount(1);
  const child=page.getByRole('button',{name:'选择工具执行 2 read_file',exact:true});
  expect(await child.locator('.console-event-name').evaluate(el=>getComputedStyle(el).paddingLeft)).toBe('12px');
  const log=page.getByRole('button',{name:'选择事件 3 stdout',exact:true});
  expect(await log.locator('.console-event-name').evaluate(el=>getComputedStyle(el).paddingLeft)).toBe('0px');
  await page.getByRole('button',{name:'收起子事件'}).click();await expect(child).toHaveCount(0);await expect(log).toBeVisible();
  await page.getByRole('button',{name:'展开子事件'}).click();await child.click();await expect(page.locator('.event-inspector')).toContainText('read_file');
  await page.getByRole('tab',{name:/^独立验收/}).click();await expect(page.locator('.outcomes')).toContainText('deterministic-check');
  await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:'../../.local/screenshots/v04-console-passed-1920.png'});
});

test('关联缺失或重复时保留调用与返回原始事件',async({page,request})=>{
  const run=await create(request,'不猜测调用返回关系');
  const items=[
    event(1,{kind:'tool_call',name:'unlinked',input:{command:'one'}}),
    event(2,{kind:'tool_return',name:'unlinked',output:{returncode:0}}),
    event(3,{kind:'tool_call',name:'ambiguous',correlation_id:'duplicate'}),
    event(4,{kind:'tool_call',name:'ambiguous',correlation_id:'duplicate'}),
    event(5,{kind:'tool_return',name:'ambiguous',correlation_id:'duplicate'}),
  ];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:5}}});
  await page.goto('/runs/'+run.run_id);
  await expect(page.locator('.console-event')).toHaveCount(5);
  await expect(page.locator('.console-event-name small').filter({hasText:'Tool Execution'})).toHaveCount(0);
  await expect(page.locator('.toolbar-count')).toContainText('5 步 · 5 原始事件');
});

test('只有验收失败、运行中和 unknown 不伪装成工具失败或任务通过',async({page,request})=>{
  const run=await create(request,'独立验收失败场景');
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.console-states')).toContainText('执行中');await expect(page.locator('.console-states')).toContainText('验收未知');
  await page.getByRole('tab',{name:/^根因假设/}).click();await expect(page.getByRole('button',{name:'运行 HGT 定位'})).toBeDisabled();
  const items=[event(1,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'external-check',basis:'expected file missing'},output:null})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:1}}});await page.reload();
  await expect(page.locator('.console-states')).toContainText('执行完成');await expect(page.locator('.console-states')).toContainText('验收未通过');
  await expect(page.locator('.execution-item.failed')).toHaveCount(0);await expect(page.locator('.event-inspector')).toContainText('未记录失败执行事件');
  await expect(page.getByRole('tab',{name:/^独立验收/})).toHaveAttribute('aria-selected','true');
  await page.screenshot({path:'../../.local/screenshots/v04-console-validation-only.png'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  const unknown=await create(request,'未知验收与采集缺失');await request.post(`/api/live/runs/${unknown.run_id}/finish`,{headers:unknown.headers,data:{exit_code:4,producers:{},dropped:1}});
  await page.goto('/runs/'+unknown.run_id);await expect(page.locator('.console-states')).toContainText('执行失败');await expect(page.locator('.console-states')).toContainText('验收未知');await expect(page.locator('.console-states')).toContainText('不完整');
});

test('历史时间与关系缺失保持平铺，导入时间不成为执行时间',async({page,request})=>{
  const root=path.resolve('../../tests/fixtures/demo');const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  manifest.source_namespace='ui-no-time/'+randomUUID();
  const names=[...new Set(manifest.runs.flatMap((r:Record<string,string>)=>['telemetry','report','outcome','feedback'].map(key=>r[key]).filter(Boolean)))] as string[];
  const multipart:Record<string,unknown>={manifest:{name:'manifest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))}};
  // Multipart supports repeated files through an array supplied by the browser upload.
  await page.goto('/imports');await page.getByLabel('导入清单',{exact:true}).setInputFiles(multipart.manifest as {name:string;mimeType:string;buffer:Buffer});
  await page.getByLabel('数据文件',{exact:true}).setInputFiles(names.map(name=>{
    let text=fs.readFileSync(path.join(root,name),'utf8');if(name.endsWith('.jsonl'))text=text.trim().split('\n').map(line=>{const e=JSON.parse(line);delete e.ts;return JSON.stringify(e);}).join('\n');
    return {name,mimeType:'text/plain',buffer:Buffer.from(text)};
  }));
  await page.getByRole('button',{name:'校验并导入'}).click();await page.getByRole('link',{name:'打开任务',exact:true}).click();
  const task=await (await request.get('/api/tasks/'+page.url().split('/').at(-1))).json();await page.goto('/runs/'+task.runs[0].run_id);
  await expect(page.locator('.trace-row')).toHaveCount(7);await expect(page.locator('.toolbar-count')).toContainText('10 原始事件');await expect(page.locator('.execution-caption')).toContainText('时序事件列表');await expect(page.locator('.execution-footer')).toContainText('无可靠时间尺度');
  await expect(page.locator('.event-timing')).toHaveCount(0);await expect(page.getByRole('button',{name:'收起子事件'})).toHaveCount(0);
});

test('诊断进行中保留旧假设，RCA 预览与人工确认在切换面板后仍有效',async({page,request})=>{
  const run=await create(request,'诊断状态与模型确认验收');
  const items=[event(1)];await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}});
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:1}}});
  const raw=await (await request.get(`/api/runs/${run.run_id}`)).json();
  const evidence=(await (await request.get(`/api/runs/${run.run_id}/events`)).json()).items[0];
  const report={diagnosis_id:'prior-hypothesis',mode:'analyst_rca',origin:'recomputed',source_algorithm:'synthetic-ui-fixture',format:'fixture',model_status:'ready',model_reason:null,raw_evidence_id:evidence.evidence_id,summary:'之前的待验证假设仍然保留。',findings:[],graph:null,guidance:null,verification_suggestion:'检查建议尚未执行'};
  let phase='running',submissions:unknown[]=[];
  await page.route(`**/api/runs/${run.run_id}`,route=>route.fulfill({json:{...raw,insight:{...raw.insight,diagnosis:{state:phase==='running'?'running':'hypothesis',report_count:1,report_kinds:['hypothesis'],featured_report:{diagnosis_id:report.diagnosis_id,kind:'hypothesis',summary:report.summary,origin:'recomputed'},latest_job:{job_id:'latest',mode:'analyst_rca',state:phase,error:phase==='failed'?'synthetic-failure':null}}}}}));
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));
  await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'ready',analyst:'configured',model:'synthetic-model',reason:'仅用于 UI 验收'}}));
  const baseJob={input_snapshot_hash:'a'.repeat(64),input_evidence_id:evidence.evidence_id,created_at:new Date().toISOString(),error:null};
  await page.route(`**/api/runs/${run.run_id}/diagnosis-jobs`,route=>route.fulfill({json:[{...baseJob,job_id:'latest',mode:'analyst_rca',state:phase},{...baseJob,job_id:'hgt',mode:'offline_hgt',state:'succeeded'}]}));
  await page.route(`**/api/runs/${run.run_id}/analyst-preview`,route=>route.fulfill({json:{prompt:{selected_subtrajectory:'synthetic preview only'},prompt_sha256:'b'.repeat(64),preview_sha256:'c'.repeat(64),prompt_bytes:80,hgt_diagnosis_id:'hgt',model:'synthetic-model',provider:'mock',truncated:false}}));
  await page.route(`**/api/runs/${run.run_id}/analyst-jobs`,route=>{submissions.push(route.request().postDataJSON());return route.fulfill({json:{...baseJob,job_id:'mock-submit',mode:'analyst_rca',state:'queued'}});});
  await page.goto('/runs/'+run.run_id);
  await expect(page.locator('.console-states')).toContainText('诊断作业进行中');await expect(page.locator('.hypothesis-statement')).toContainText('之前的待验证假设');
  await expect(page.getByRole('button',{name:'查看 RCA 发送内容'})).toBeDisabled();phase='failed';
  await expect(page.locator('.console-states')).toContainText('最近作业失败',{timeout:10000});
  await expect(page.locator('.hypothesis-statement')).toContainText('之前的待验证假设');
  await page.getByRole('button',{name:'查看 RCA 发送内容'}).click();await expect(page.locator('.analyst-preview')).toContainText('synthetic preview only');expect(submissions).toHaveLength(0);
  await page.getByRole('tab',{name:/^独立验收/}).click();await expect(page.locator('.console-states')).toContainText('验收未知');
  await page.getByRole('tab',{name:/^根因假设/}).click();await expect(page.locator('.analyst-preview')).toBeVisible();
  await page.getByRole('button',{name:'确认并运行 RCA'}).click();expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({preview_sha256:'c'.repeat(64),hgt_diagnosis_id:'hgt'});
});

test('历史轨迹后续批次加载完成不会夺走用户选择',async({page,request})=>{
  const run=await create(request,'渐进加载选择保持');
  const items=Array.from({length:201},(_,i)=>event(i+1));
  for(let i=0;i<items.length;i+=100)expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items.slice(i,i+100)}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:201}}});
  let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/runs/${run.run_id}/events?offset=200&limit=200`,async route=>{await delayed;await route.continue();});
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.console-event')).toHaveCount(50);
  await page.locator('.console-event').nth(2).click();const selected=await page.locator('.console-event.selected').getAttribute('data-event-id');release();
  await expect(page.locator('.toolbar-count')).toContainText('201');await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);
});
