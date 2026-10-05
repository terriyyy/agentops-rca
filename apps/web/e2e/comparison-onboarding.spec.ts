import {test,expect} from '@playwright/test';

const run=(id:string,attempt:number,outcome:string)=>({run_id:id,task_id:'compare-fixture',attempt_index:attempt,external_run_id:id,created_at:'2026-10-04T00:00:00Z',origin:'live',sample_kind:'synthetic',execution_status:'completed',outcome_status:outcome,capture_integrity:'complete',event_count:3,tool_call_count:1,confirmed_pairs:1,failed_tool_count:0,insight:{failure_signals:outcome==='failed'?[{title:'规则未通过',kind:'outcome',event_id:null,evidence_id:'check-evidence'}]:[],diagnosis:{state:'none',report_count:0,featured_report:null,latest_job:null}}});
const task={id:'compare-fixture',namespace:'fixture',external_id:'comparison',goal:'UI 对比验收',runs:[run('first',1,'failed'),run('second',2,'passed')]};
async function mockCompare(page:import('@playwright/test').Page){await page.route('**/api/tasks/compare-fixture',route=>route.fulfill({json:task}));await page.route('**/api/runs/*/outcomes',route=>route.fulfill({json:[{outcome_id:'check',status:route.request().url().includes('first')?'failed':'passed',source:'fixture-rule',summary:'固定规则检查',basis:{expected:5},authoritative:true,evidence_id:'check-evidence'}]}));}

test('对比交换可分享刷新、只显示事实变化，证据关闭恢复触发焦点',async({page})=>{
  let writes=0;page.on('request',request=>{if(request.method()==='POST')writes++});await mockCompare(page);
  await page.route('**/api/evidence/check-evidence',route=>route.fulfill({json:{evidence_id:'check-evidence',filename:'check.json',line:null,json_pointer:null,resolution_status:'resolved',sha256:'fixture-hash',content:{expected:5},event_id:null}}));
  await page.goto('/tasks/compare-fixture/compare');await expect(page.locator('.comparison')).toContainText('2 项事实变化');
  await page.getByRole('button',{name:'交换两次运行'}).click();await expect(page).toHaveURL(/left=second&right=first/);await page.reload();
  await expect(page.getByRole('combobox',{name:'基准运行'})).toHaveValue('second');await expect(page.getByRole('combobox',{name:'对照运行'})).toHaveValue('first');
  await page.getByRole('checkbox',{name:'仅看变化'}).check();await expect(page.locator('.comparison>table tbody tr')).toHaveCount(2);await expect(page.locator('.comparison>table')).not.toContainText('执行状态');
  const detail=page.locator('.comparison-run-detail').first();await detail.getByText('检查依据与原始记录').click();const trigger=detail.getByRole('button',{name:'查看原始检查记录'});await trigger.click();await expect(page.getByRole('dialog',{name:'原始证据'})).toContainText('expected');await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
  for(const width of [1366,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}expect(writes).toBe(0);
});

test('同一运行选择不比较；未知检查、缺失采集和已有假设不互相代替',async({page})=>{
  await mockCompare(page);const unknown=structuredClone(task);unknown.runs[1].outcome_status='unknown';unknown.runs[1].capture_integrity='unknown';unknown.runs[1].insight.diagnosis={state:'hypothesis',report_count:1,featured_report:null,latest_job:null};
  await page.route('**/api/tasks/compare-fixture',route=>route.fulfill({json:unknown}));await page.goto('/tasks/compare-fixture/compare');
  await expect(page.locator('.comparison')).toContainText('验收未知');await expect(page.locator('.comparison')).toContainText('采集情况未知');await expect(page.locator('.comparison')).toContainText('待验证假设');await expect(page.locator('.comparison')).toContainText('执行完成');
  await page.getByRole('combobox',{name:'基准运行'}).selectOption('second');await expect(page.locator('.comparison')).toHaveCount(0);await expect(page.locator('.notice')).toContainText('同一次运行');
});

test('清单预览、逐个移除、重复文件保护、载入历史不显示空数据',async({page})=>{
  let finish:()=>void=()=>{};const wait=new Promise<void>(resolve=>finish=resolve);await page.route('**/api/imports',async route=>{await wait;await route.fulfill({json:[]})});await page.goto('/imports');await expect(page.getByRole('status')).toContainText('正在读取导入记录');await expect(page.getByText('还没有导入记录')).toHaveCount(0);finish();
  const manifest={goal:'准备测试',runs:[{attempt_index:1,run_key:'one',telemetry:'trace.jsonl'}]};await page.getByLabel('导入清单',{exact:true}).setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
  await expect(page.locator('.setup-manifest-preview')).toContainText('准备测试');await expect(page.locator('.setup-file-warning')).toContainText('trace.jsonl');
  const file={name:'trace.jsonl',mimeType:'text/plain',buffer:Buffer.from('{}')};await page.getByLabel('数据文件',{exact:true}).setInputFiles(file);await expect(page.locator('.setup-file-warning')).toHaveCount(0);
  await page.getByLabel('数据文件',{exact:true}).setInputFiles(file);await expect(page.getByRole('alert')).toContainText('文件名重复');await expect(page.getByRole('button',{name:'校验并导入',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'移除文件 trace.jsonl',exact:true}).last().click();await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByRole('button',{name:'校验并导入',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'校验并导入',exact:true})).toHaveCSS('opacity','1');await page.getByRole('button',{name:'移除导入清单'}).click();await expect(page.getByRole('button',{name:'校验并导入',exact:true})).toBeDisabled();
  for(const width of [1366,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}
});

test('导入忙碌不能改变文件；错误可重试，更换文件清除旧结果',async({page})=>{
  await page.route('**/api/imports',route=>route.fulfill({json:[]}));await page.goto('/imports');
  await page.getByLabel('导入清单',{exact:true}).setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from('{}')});await page.getByLabel('数据文件',{exact:true}).setInputFiles({name:'trace.jsonl',mimeType:'text/plain',buffer:Buffer.from('{}')});
  let finish:()=>void=()=>{};const wait=new Promise<void>(resolve=>finish=resolve);await page.route('**/api/imports',async route=>{if(route.request().method()==='POST'){await wait;await route.fulfill({status:422,json:{detail:'清单字段不符合契约'}});}else await route.fulfill({json:[]});});
  await page.getByRole('button',{name:'校验并导入',exact:true}).click();await expect(page.getByLabel('数据文件',{exact:true})).toBeDisabled();await expect(page.getByLabel('导入清单',{exact:true})).toBeDisabled();finish();await expect(page.getByRole('alert')).toContainText('清单字段不符合契约');
  await page.getByLabel('导入清单',{exact:true}).setInputFiles({name:'new.json',mimeType:'application/json',buffer:Buffer.from('{}')});await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByRole('button',{name:'校验并导入',exact:true})).toBeEnabled();
});

test('环境配置不冒充调用成功；故障时不显示当前就绪，重试只读',async({page})=>{
  let writes=0;page.on('request',r=>{if(r.method()==='POST')writes++});await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'ready',analyst:'configured',model:'fixture-model',reason:'本机环境已记录'}}));await page.goto('/system');
  await expect(page.locator('.setup-capabilities')).toContainText('已配置 · 尚未调用');await expect(page.locator('.setup-capabilities')).not.toContainText('最近调用成功');await expect(page.locator('.setup-capabilities')).toContainText('提供接入方式');
  await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({status:503,json:{detail:'environment unavailable'}}));await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('alert')).toContainText('保留上次记录');await expect(page.locator('.setup-capabilities')).toContainText('当前状态无法读取');
  await page.unroute('**/api/diagnosis/capabilities');await page.route('**/api/diagnosis/capabilities',route=>route.fulfill({json:{hgt:'unverified',analyst:'last_call_failed',model:'fixture-model',reason:'需重新验证'}}));await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.setup-capabilities')).toContainText('尚未验证');await expect(page.locator('.setup-capabilities')).toContainText('最近调用失败');
  for(const width of [1366,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}expect(writes).toBe(0);
});

test('跨页接入引导保持只读、分段键盘、复制失败切换清除与关闭',async({page})=>{
  let writes=0;page.on('request',r=>{if(r.method()==='POST')writes++});await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied')}}});});await page.goto('/system');await page.getByRole('link',{name:'开始监控',exact:true}).click();await expect(page.getByRole('dialog',{name:'开始监控'})).toBeVisible();
  await page.getByRole('button',{name:'复制命令'}).click();await expect(page.getByRole('alert')).toContainText('复制失败');await page.getByRole('button',{name:'已有 Python Agent'}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('button',{name:'无模型演示',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.locator('.monitor-command')).toContainText('--sample-kind synthetic');await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page).toHaveURL('http://127.0.0.1:8001/');await page.reload();await expect(page.getByRole('dialog')).toHaveCount(0);expect(writes).toBe(0);
});

test('全站状态说明可键盘关闭并恢复焦点；原始证据读取失败可重试',async({page})=>{
  await mockCompare(page);await page.route('**/api/evidence/check-evidence',route=>route.fulfill({status:503,json:{detail:'evidence unavailable'}}));await page.goto('/tasks/compare-fixture/compare');
  const guide=page.getByRole('button',{name:'状态说明',exact:true});await guide.focus();await page.keyboard.press('Enter');await expect(page.locator('#status-guide')).toBeVisible();await expect(page.locator('#status-guide')).toContainText('执行完成不等于任务通过');await expect(page.locator('#status-guide')).toContainText('分析不会改变检查结果');await page.keyboard.press('Escape');await expect(guide).toBeFocused();
  await page.getByRole('button',{name:'查看证据',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('evidence unavailable');await page.unroute('**/api/evidence/check-evidence');await page.route('**/api/evidence/check-evidence',route=>route.fulfill({json:{filename:'check.json',sha256:'hash',content:'original check',resolution_status:'resolved'}}));await page.getByRole('button',{name:'重试读取证据'}).click();await expect(page.locator('.source-code')).toContainText('original check');await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'查看证据',exact:true})).toBeFocused();
  await page.setViewportSize({width:390,height:844});await guide.click();const bounds=await page.locator('#status-guide').boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
