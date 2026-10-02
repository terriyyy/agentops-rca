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
  await expect(page.locator('.console-states>div').first().locator('.tone-complete')).toContainText('执行完成');
  await expect(page.locator('.console-states>button').first().locator('.tone-unknown')).toContainText('验收未知');
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  await page.locator('.console-event').first().click();
  const before=await page.locator('.execution-scroll').evaluate(el=>el.scrollTop);
  await page.locator('.console-event').nth(1).click();
  expect(await page.locator('.execution-scroll').evaluate(el=>el.scrollTop)).toBe(before);
  await page.getByRole('tab',{name:/^原因分析/}).click();
  await expect(page.locator('.full-report')).not.toHaveAttribute('open');
  await page.locator('.hypothesis-evidence .evidence-chip.resolved').click();
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',all.items[55].event_id);
  await expect(page.locator('.execution-item.failed.referenced .console-event.selected')).toHaveCount(1);
  expect(await page.locator('.execution-item.failed .duration-bar').evaluate(el=>getComputedStyle(el,'::after').content)).not.toBe('none');
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
  await page.getByRole('button',{name:'更多资料',exact:true}).click();
  await expect(page.locator('.technical-group')).toHaveCount(3);
  await expect(page.locator('.technical-group[open]')).toHaveCount(0);
  await expect(page.locator('.technical-group[open]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'更多资料',exact:true})).toBeFocused();
  expect(modelPosts).toBe(0);expect(errors).toEqual([]);
});

test('真实父子关系与时间区间才绘制，普通日志不成为子 Span',async({page,request})=>{
  const run=await create(request,'真实关系与时间展示验收');
  const items=[event(1,{kind:'event',name:'RUN_START',source_span_id:'actual-root'}),event(2,{kind:'tool_call',name:'read_file',source_span_id:'actual-child',parent_source_id:'actual-root',correlation_id:'file',output:null}),event(3,{name:'stdout'}),event(4,{kind:'tool_return',name:'read_file',correlation_id:'file',ok:true,duration_ms:2000}),event(5,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'passed',source:'deterministic-check',basis:'assert output'},output:null})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:5}}});
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.execution-caption')).toContainText('来源关系树');
  await expect(page.locator('.duration-bar')).toHaveCount(1);
  await expect(page.locator('.ruler-tick')).toHaveCount(5);
  await expect(page.locator('.time-ruler')).toContainText('0 ms');
  await expect(page.locator('.time-ruler')).toContainText('4 s');
  const child=page.getByRole('button',{name:'选择工具执行 2 read_file',exact:true});
  expect(await child.locator('.duration-bar').evaluate(el=>({start:(el as HTMLElement).style.left,duration:(el as HTMLElement).style.width}))).toEqual({start:'25%',duration:'50%'});
  await expect(page.locator('.timeline-guides .timeline-gridline')).toHaveCount(5);
  await expect(child.locator('.timeline-gridline')).toHaveCount(0);
  expect(await child.locator('.event-timing').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const alignment=await page.evaluate(()=>({ruler:document.querySelector('.time-ruler')!.getBoundingClientRect().left,row:document.querySelector('.event-timing')!.getBoundingClientRect().left}));
  expect(Math.abs(alignment.ruler-alignment.row)).toBeLessThan(1);
  expect(await child.locator('.trace-tree-branch').evaluate(el=>el.getBoundingClientRect().width)).toBe(14);
  const log=page.getByRole('button',{name:'选择事件 3 stdout',exact:true});
  await expect(log.locator('.trace-tree-branch')).toHaveCount(0);
  await expect(log.locator('.time-point')).toHaveCount(1);
  await page.getByRole('button',{name:'收起子事件'}).click();await expect(child).toHaveCount(0);await expect(log).toBeVisible();
  await page.getByRole('button',{name:'展开子事件'}).click();await child.click();await expect(page.locator('.event-inspector')).toContainText('read_file');
  await page.getByRole('tab',{name:/^任务检查/}).click();await expect(page.locator('.outcomes')).toContainText('deterministic-check');
  await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:'../../.local/screenshots/v04-console-passed-1920.png'});
});

test('长 Run 默认按当前页时间窗绘制，可切回整轮真实比例',async({page,request})=>{
  const run=await create(request,'长轨迹时间窗验收');
  const at=(seconds:number)=>new Date(Date.UTC(2026,8,28,0,0,0)+seconds*1000).toISOString();
  const items=Array.from({length:62},(_,i)=>event(i+1,{occurred_at:at(i>5?i+4:i)}));
  items[5]=event(6,{occurred_at:at(5),kind:'tool_call',name:'five_second_tool',correlation_id:'timed-tool',input:{command:'measure'}});
  items[6]=event(7,{occurred_at:at(10),kind:'tool_return',name:'five_second_tool',correlation_id:'timed-tool',duration_ms:5000,ok:true});
  items[61]=event(62,{occurred_at:at(600)});
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:62}}});
  await page.goto('/runs/'+run.run_id);
  await page.getByRole('button',{name:'上一页',exact:true}).click();
  const bar=page.getByRole('button',{name:'选择工具执行 6 five_second_tool',exact:true}).locator('.duration-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByRole('button',{name:'本页'})).toHaveAttribute('aria-pressed','true');
  const localWidth=Number.parseFloat(await bar.evaluate(el=>(el as HTMLElement).style.width));
  expect(localWidth).toBeGreaterThan(8);
  await expect(page.locator('.execution-footer')).toContainText('本页');
  await page.getByRole('button',{name:'整轮'}).click();
  const globalWidth=Number.parseFloat(await bar.evaluate(el=>(el as HTMLElement).style.width));
  expect(globalWidth).toBeLessThan(1);
  expect(localWidth).toBeGreaterThan(globalWidth*10);
  await expect(page.locator('.execution-footer')).toContainText('整轮');
  await page.getByRole('button',{name:'本页'}).click();
  expect(Number.parseFloat(await bar.evaluate(el=>(el as HTMLElement).style.width))).toBeCloseTo(localWidth,4);
  expect(await page.locator('.time-ruler').evaluate(el=>el.getBoundingClientRect().left)).toBeCloseTo(await page.locator('.event-timing').first().evaluate(el=>el.getBoundingClientRect().left),0);
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.locator('.time-ruler')).not.toContainText('0 ms');
  await expect(page.locator('.execution-footer')).toContainText('刻度相对本轮起点');
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
  await expect(page.locator('.duration-bar')).toHaveCount(0);
  await expect(page.locator('.time-point')).toHaveCount(5);
});

test('只有验收失败、运行中和 unknown 不伪装成工具失败或任务通过',async({page,request})=>{
  const run=await create(request,'独立验收失败场景');
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.console-states')).toContainText('执行中');await expect(page.locator('.console-states')).toContainText('验收未知');
  await page.getByRole('tab',{name:/^原因分析/}).click();await expect(page.getByRole('button',{name:'定位异常步骤（本机）'})).toBeDisabled();
  const items=[event(1,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'external-check',basis:'expected file missing'},output:null})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:1}}});await page.reload();
  await expect(page.locator('.console-states')).toContainText('执行完成');await expect(page.locator('.console-states')).toContainText('验收未通过');
  await expect(page.locator('.execution-item.failed')).toHaveCount(0);await expect(page.locator('.event-inspector')).toContainText('未记录失败执行事件');
  await expect(page.getByRole('tab',{name:/^任务检查/})).toHaveAttribute('aria-selected','true');
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
  await expect(page.getByRole('button',{name:'预览并分析原因'})).toBeDisabled();phase='failed';
  await expect(page.locator('.console-states')).toContainText('最近作业失败',{timeout:10000});
  await expect(page.locator('.hypothesis-statement')).toContainText('之前的待验证假设');
  await page.getByRole('button',{name:'预览并分析原因'}).click();await expect(page.locator('.analyst-preview')).toContainText('synthetic preview only');expect(submissions).toHaveLength(0);
  await page.getByRole('tab',{name:/^任务检查/}).click();await expect(page.locator('.console-states')).toContainText('验收未知');
  await page.getByRole('tab',{name:/^原因分析/}).click();await expect(page.locator('.analyst-preview')).toBeVisible();
  await page.getByRole('button',{name:'确认发送并开始分析'}).click();expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({preview_sha256:'c'.repeat(64),hgt_diagnosis_id:'hgt'});
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


test('共享时间轴缩放、平移与聚焦保持真实时间和事件类型',async({page,request})=>{
  const run=await create(request,'线性时间轴导航与可信边界');
  const items=[event(1,{kind:'event',name:'RUN_START'}),event(2,{kind:'tool_call',name:'timed',correlation_id:'exact',output:null}),event(3,{kind:'llm',name:'response',duration_ms:900}),event(4,{kind:'tool_return',name:'timed',correlation_id:'exact',ok:true,duration_ms:2000}),event(5),event(6),event(7,{kind:'tool_call',name:'inconsistent',correlation_id:'bad'}),event(8,{kind:'tool_return',name:'inconsistent',correlation_id:'bad',duration_ms:4000,ok:true}),event(9,{kind:'event',name:'RUN_END'})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}})).ok()).toBeTruthy();
  await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:9}}});
  await page.goto('/runs/'+run.run_id);
  const span=page.getByRole('button',{name:'选择工具执行 2 timed',exact:true});
  const invalid=page.getByRole('button',{name:'选择工具执行 7 inconsistent',exact:true});
  await expect(invalid.locator('.time-point')).toHaveCount(1);await expect(invalid.locator('.duration-bar')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'选择事件 3 response',exact:true}).locator('.time-point')).toHaveCount(1);
  await span.click();
  const base=await page.locator('.time-ruler').evaluate(el=>({start:Number((el as HTMLElement).dataset.viewStart),end:Number((el as HTMLElement).dataset.viewEnd)}));
  expect(await span.locator('.duration-bar').evaluate(el=>(el as HTMLElement).style.width)).toBe('25%');
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();await expect(page.locator('.timeline-zoom')).toHaveText('2×');
  expect(await span.locator('.duration-bar').evaluate(el=>(el as HTMLElement).style.width)).toBe('50%');
  await expect(page.locator('.timeline-offscreen.after')).not.toHaveCount(0);
  await page.getByRole('button',{name:'时间窗向后',exact:true}).click();
  const panned=await page.locator('.time-ruler').evaluate(el=>Number((el as HTMLElement).dataset.viewStart));expect(panned).toBeGreaterThan(base.start);
  await expect(page.locator('.time-ruler')).not.toContainText('0 ms');
  await page.getByRole('button',{name:'适配时间范围',exact:true}).click();await expect(page.locator('.timeline-zoom')).toHaveText('1×');
  expect(await span.locator('.duration-bar').evaluate(el=>(el as HTMLElement).style.width)).toBe('25%');
  await span.dblclick();await expect(page.locator('.timeline-zoom')).not.toHaveText('1×');
  const focused=await page.locator('.time-ruler').evaluate(el=>Number((el as HTMLElement).dataset.viewEnd)-Number((el as HTMLElement).dataset.viewStart));expect(focused).toBe(3000);
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',await span.getAttribute('data-event-id') as string);
  await expect(page.locator('.console-states')).toContainText('验收未知');await expect(page.locator('.event-inspector')).toContainText('Tool Execution');
  await page.getByRole('button',{name:'适配时间范围',exact:true}).click();
  const alignment=await page.evaluate(()=>Array.from(document.querySelectorAll('.time-ruler,.event-timing,.timeline-guides-axis')).map(el=>({left:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width})));
  expect(Math.max(...alignment.map(v=>v.left))-Math.min(...alignment.map(v=>v.left))).toBeLessThan(1);
  expect(Math.max(...alignment.map(v=>v.width))-Math.min(...alignment.map(v=>v.width))).toBeLessThan(1);
});

test('纯白底面和实心类型色不改变时间几何或失败/选中语义',async({page,request})=>{
  const run=await create(request,'白底与实心Timeline验收');
  const items=[event(1,{kind:'tool_call',name:'read_file',correlation_id:'one',input:{path:'example.py'}}),event(2,{kind:'tool_return',name:'read_file',correlation_id:'one',ok:true,duration_ms:1000}),event(3,{kind:'llm',name:'LLM_RESPONSE',output:'model response'}),event(4,{kind:'tool_call',name:'run_tests',correlation_id:'two'}),event(5,{kind:'tool_return',name:'run_tests',correlation_id:'two',ok:false,duration_ms:1000,error_signature:'assertion_failed'}),event(6,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'passed',source:'fixture-check',basis:'assert result'},output:null})];
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}});await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:6}}});
  await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  const normal=page.getByRole('button',{name:'选择工具执行 1 read_file',exact:true}),failed=page.getByRole('button',{name:'选择工具执行 4 run_tests',exact:true}),llm=page.getByRole('button',{name:'选择事件 3 LLM_RESPONSE',exact:true});
  const style=(locator:ReturnType<typeof page.locator>)=>locator.evaluate(el=>({color:getComputedStyle(el).backgroundColor,opacity:getComputedStyle(el).opacity,left:(el as HTMLElement).style.left,width:(el as HTMLElement).style.width}));
  const original=await style(normal.locator('.duration-bar'));expect(original.color).toBe('rgb(37, 99, 235)');expect(original.opacity).toBe('1');
  await normal.click();expect(await style(normal.locator('.duration-bar'))).toEqual(original);
  await failed.click();expect((await style(failed.locator('.duration-bar'))).color).toBe('rgb(220, 38, 38)');
  await llm.click();expect((await style(llm.locator('.time-point'))).color).toBe('rgb(147, 51, 234)');await expect(llm.locator('.duration-bar')).toHaveCount(0);
  await expect(page.locator('.console-states')).toContainText('验收通过');await expect(page.locator('.console-states')).toContainText('执行完成');
  for(const width of [1366,1920]){
    await page.setViewportSize({width,height:width===1366?768:1080});
    expect(await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('.run-console'),document.querySelector('.execution-columns')].map(el=>getComputedStyle(el!).backgroundColor))).toEqual(Array(4).fill('rgb(255, 255, 255)'));
    expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`../../.local/screenshots/analysis-types-${width}.png`});
  }
});

test('分析记录与完整报告按需读取，保留选择/时间窗及全部原件引用',async({page,request})=>{
  const run=await create(request,'分析记录与完整原文验收');const items=[event(1,{kind:'tool_call',name:'run_tests',correlation_id:'test'}),event(2,{kind:'tool_return',name:'run_tests',correlation_id:'test',duration_ms:1000,ok:false,error_signature:'assertion_failed'}),event(3),event(4),event(5)];
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}});await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:5}}});
  const all=(await (await request.get(`/api/runs/${run.run_id}/events`)).json()).items;
  const report={diagnosis_id:'new',mode:'analyst_rca',origin:'recomputed',format:'fixture',source_algorithm:'ui-fixture',model_status:'ready',model_reason:null,raw_evidence_id:all[1].evidence_id,summary:'尚不能确定具体根因；不能将断言失败直接认定为实现错误。'.repeat(12),boundary:'不能把检查通过视为根因已经证实。',findings:[{title:'引用',severity:'warn',description:'待验证',evidence:all.map((e:Record<string,string>)=>({evidence_id:e.evidence_id,event_id:e.event_id,resolution_status:'resolved',label:'事件 '+e.event_id}))}],graph:null,guidance:null,verification_suggestion:'先核对原始检查，不在平台执行命令。'};
  const old={...report,diagnosis_id:'old',mode:undefined,origin:'imported',summary:'历史来源提供的分析原文。'};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report,old]}));let posts=0;
  await page.route('**/api/runs/*/analyst-jobs',route=>{posts++;return route.abort();});await page.route('**/api/runs/*/diagnosis-jobs',route=>route.request().method()==='POST'?(posts++,route.abort()):route.fulfill({json:[]}));
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();
  await expect(page.locator('.console-states')).not.toContainText('尚未诊断');await expect(page.locator('.hypothesis-evidence')).toContainText('#01 run_tests · 调用参数');await expect(page.locator('.hypothesis-evidence')).toContainText('#02 run_tests · 返回 · 失败');
  await page.getByRole('button',{name:'查看其余 2 条证据'}).click();await expect(page.locator('.hypothesis-evidence .evidence-chip')).toHaveCount(5);
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();const windowBefore=await page.locator('.time-ruler').getAttribute('data-view-start');const selection=await page.locator('.console-event.selected').getAttribute('data-event-id');
  await page.getByRole('button',{name:'查看完整报告',exact:true}).click();await expect(page.getByRole('dialog')).toContainText(report.summary);await expect(page.getByRole('dialog')).toContainText(report.boundary);
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'查看完整报告',exact:true})).toBeFocused();expect(await page.locator('.time-ruler').getAttribute('data-view-start')).toBe(windowBefore);await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selection!);
  await page.getByRole('button',{name:/^分析记录/}).click();await expect(page.getByRole('dialog')).toContainText('2 份报告');await page.locator('.analysis-history-row').filter({hasText:'历史来源提供'}).click();
  await expect(page.locator('.hypothesis-statement')).toHaveText(old.summary);await expect(page.locator('.analysis-result-heading')).toContainText('历史分析');
  await page.waitForResponse(response=>response.url().endsWith('/diagnosis-jobs'));await expect(page.locator('.hypothesis-statement')).toHaveText(old.summary);
  await page.getByRole('button',{name:'更多资料',exact:true}).click();await expect(page.locator('.technical-group')).toHaveCount(3);await page.keyboard.press('Escape');expect(posts).toBe(0);
});

test('定位必须手动启动，关闭和过期预览不发送，重新预览后才可人工确认',async({page,request})=>{
  const run=await create(request,'定位与过期预览确认验收');const items=[event(1,{kind:'tool_call',name:'run_tests',correlation_id:'exact'}),event(2,{kind:'tool_return',name:'run_tests',correlation_id:'exact',ok:false,error_signature:'failed',duration_ms:1000})];
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}});await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:2}}});
  let located=false,localPosts=0,modelPosts=0,previewReads=0;const evidence=(await (await request.get(`/api/runs/${run.run_id}/events`)).json()).items[0];
  const job={job_id:'hgt-fixture',mode:'offline_hgt',state:'succeeded',error:null,input_snapshot_hash:'a'.repeat(64),input_evidence_id:evidence.evidence_id,created_at:new Date().toISOString()};
  await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'ready',analyst:'configured',model:'fixture-model',reason:'UI Mock'}}));
  await page.route(`**/api/runs/${run.run_id}/diagnosis-jobs`,route=>{if(route.request().method()==='POST'){localPosts++;located=true;return route.fulfill({json:job});}return route.fulfill({json:located?[job]:[]});});
  await page.route(`**/api/runs/${run.run_id}/analyst-preview`,route=>{previewReads++;return route.fulfill({json:{prompt:{actual_payload:'visible mock data'},prompt_sha256:'b'.repeat(64),preview_sha256:'c'.repeat(64),prompt_bytes:80,hgt_diagnosis_id:job.job_id,model:'fixture-model',provider:'mock',truncated:true}});});
  await page.route(`**/api/runs/${run.run_id}/analyst-jobs`,route=>{modelPosts++;if(modelPosts===1)return route.fulfill({status:409,json:{detail:'发送预览已变化，请重新查看后再运行'}});expect(route.request().postDataJSON()).toMatchObject({preview_sha256:'c'.repeat(64),hgt_diagnosis_id:job.job_id});return route.fulfill({json:{...job,job_id:'model-fixture',mode:'analyst_rca',state:'queued'}});});
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();await expect(page.getByRole('button',{name:'预览并分析原因',exact:true})).toBeDisabled();expect(localPosts).toBe(0);expect(modelPosts).toBe(0);
  await page.getByRole('button',{name:'定位异常步骤（本机）',exact:true}).click();await expect(page.getByRole('button',{name:'预览并分析原因',exact:true})).toBeEnabled();expect(localPosts).toBe(1);
  await page.getByRole('button',{name:'预览并分析原因',exact:true}).click();await expect(page.locator('.analyst-preview')).toContainText('visible mock data');await expect(page.locator('.analyst-preview')).toContainText('已截断');await page.getByRole('button',{name:'关闭预览',exact:true}).click();expect(modelPosts).toBe(0);
  await page.getByRole('button',{name:'预览并分析原因',exact:true}).click();await page.getByRole('button',{name:'确认发送并开始分析',exact:true}).click();await expect(page.locator('.analyst-preview')).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('预览已变化');expect(modelPosts).toBe(1);
  await page.getByRole('button',{name:'预览并分析原因',exact:true}).click();await expect(page.locator('.analyst-preview')).toBeVisible();expect(previewReads).toBe(3);expect(modelPosts).toBe(1);
  await page.getByRole('button',{name:'确认发送并开始分析',exact:true}).dblclick();expect(modelPosts).toBe(2);await expect(page.locator('.analysis-active')).toContainText('原因分析');
});

test('检查冲突、缺采集和未解析引用保持独立，不由历史报告填补事实',async({page,request})=>{
  const run=await create(request,'检查冲突与缺失证据边界');
  const items=[event(1,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'passed',source:'check-a',basis:'expected file exists'},output:null}),event(2,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'failed',source:'check-b',basis:'expected file exists'},output:null})];
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:items}});await request.post(`/api/live/runs/${run.run_id}/finish`,{headers:run.headers,data:{exit_code:0,producers:{ui:2},dropped:1}});
  const evidence=(await (await request.get(`/api/runs/${run.run_id}/events`)).json()).items[0];
  const report={diagnosis_id:'history',origin:'imported',format:'fixture',source_algorithm:'fixture',model_status:'unknown',model_reason:null,raw_evidence_id:evidence.evidence_id,summary:'历史报告不能证明本次检查通过。',findings:[{title:'历史引用',description:'不能唯一定位',severity:'warn',evidence:[{evidence_id:'ambiguous-ref',event_id:null,resolution_status:'ambiguous',label:'源文件行号 9'}]}],graph:null,guidance:null};
  await page.route(`**/api/runs/${run.run_id}/diagnoses`,route=>route.fulfill({json:[report]}));await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'ready',analyst:'unconfigured',reason:'No model configuration'}}));
  await page.route('**/api/evidence/ambiguous-ref',route=>route.fulfill({json:{evidence_id:'ambiguous-ref',event_id:null,filename:'history.json',line:9,resolution_status:'ambiguous',json_pointer:null,sha256:'a'.repeat(64),content:{raw_reference:'two source candidates'}}}));
  let posts=0;await page.route('**/api/runs/*/analyst-jobs',route=>{posts++;return route.abort();});
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();
  await expect(page.locator('.console-states')).toContainText('执行完成');await expect(page.locator('.console-states')).toContainText('验收未知');await expect(page.locator('.console-states')).toContainText('不完整');
  await expect(page.getByRole('button',{name:'定位异常步骤（本机）',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'预览并分析原因',exact:true})).toBeDisabled();await expect(page.locator('.diagnosis-controls')).toContainText('模型分析未配置');
  await page.locator('.hypothesis-evidence .evidence-chip').click();await expect(page.locator('.source-code')).toContainText('two source candidates');await expect(page.locator('.console-event.selected')).toHaveCount(0);await expect(page.locator('.execution-item.failed')).toHaveCount(0);
  await page.getByRole('tab',{name:/^任务检查/}).click();await expect(page.locator('.check-conflict')).toContainText('检查记录存在冲突');await expect(page.locator('.check-row')).toHaveCount(2);await expect(page.locator('.check-heading')).toContainText('未知');expect(posts).toBe(0);
});
