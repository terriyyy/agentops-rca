import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function create(request:APIRequestContext,goal:string,taskId?:string,status?:string,exitCode=0){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const response=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal,sample_kind:'synthetic',...(taskId?{task_id:taskId}:{})}});
  expect(response.ok()).toBeTruthy();const run=await response.json();
  const events=[{event_id:randomUUID(),producer_id:'history',producer_seq:1,occurred_at:'2026-10-04T00:00:00Z',kind:status?'verification':'event',name:status?'OUTCOME_EVIDENCE':'RUN_START',...(status?{input:{status,source:'fixture-check',basis:'expected result'}}:{})}];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events}})).ok()).toBeTruthy();
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:exitCode,producers:{history:1}}})).ok()).toBeTruthy();
  return run;
}
async function fixture(request:APIRequestContext){const goal='Task History验收 '+randomUUID().slice(0,5);const a=await create(request,goal,undefined,'failed');const b=await create(request,goal,a.task_id,'passed');const c=await create(request,goal,a.task_id,undefined,1);return {goal,a,b,c};}

test('多轮事实独立，选择两轮确实传到对比页，键盘倒序不改变前后关系',async({page,request})=>{
  const {a,b,c}=await fixture(request);let paid=0;await page.route('**/api/runs/*/analyst-jobs',route=>{paid++;return route.abort();});
  await page.goto('/tasks/'+a.task_id);
  const rows=page.locator('.history-run-table tbody tr');
  await expect(rows).toHaveCount(3);await expect(rows.nth(0)).toContainText('执行完成');await expect(rows.nth(0)).toContainText('验收未通过');
  await expect(rows.nth(1)).toContainText('验收通过');await expect(rows.nth(2)).toContainText('执行失败');await expect(rows.nth(2)).toContainText('验收未知');
  await expect(page.getByRole('checkbox',{name:'选择第 1 次运行'})).toBeChecked();await expect(page.getByRole('checkbox',{name:'选择第 3 次运行'})).toBeChecked();
  await page.getByRole('checkbox',{name:'选择第 2 次运行'}).click();
  await expect(page.getByRole('status')).toContainText('请先取消一项');
  await expect(page.getByRole('checkbox',{name:'选择第 2 次运行'})).not.toBeChecked();
  await page.getByRole('checkbox',{name:'选择第 1 次运行'}).uncheck();await page.getByRole('checkbox',{name:'选择第 2 次运行'}).check();
  await page.getByRole('button',{name:'较早在前',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await expect(rows.first()).toContainText('第 3 次运行');await expect(rows.first()).toContainText('验收通过 → 本轮');
  await page.getByRole('link',{name:'比较两次运行',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'基准运行'})).toHaveValue(b.run_id);await expect(page.getByRole('combobox',{name:'对照运行'})).toHaveValue(c.run_id);
  await expect(page.locator('.comparison')).toContainText('验收通过');await expect(page.locator('.comparison')).toContainText('验收未知');
  expect(paid).toBe(0);
});

test('新增轮次和刷新失败保留选择及排序，明确最新入口不把新轮次自动选入',async({page,request})=>{
  const {goal,a,c}=await fixture(request);await page.goto('/tasks/'+a.task_id);
  await page.getByRole('button',{name:'较新在前',exact:true}).click();
  const d=await create(request,goal,a.task_id,'passed');
  await expect(page.locator('.history-run-table tbody tr')).toHaveCount(4,{timeout:7000});
  await expect(page.getByRole('checkbox',{name:'选择第 1 次运行'})).toBeChecked();await expect(page.getByRole('checkbox',{name:'选择第 3 次运行'})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'选择第 4 次运行'})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'较新在前',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('link',{name:'打开最新运行',exact:true})).toHaveAttribute('href','/runs/'+d.run_id);
  await page.route('**/api/tasks/'+a.task_id,route=>route.fulfill({status:503,json:{detail:'controlled outage'}}));
  await expect(page.getByRole('alert')).toContainText('刷新失败，保留上次记录',{timeout:7000});
  await expect(page.locator('.history-run-table tbody tr')).toHaveCount(4);
  await expect(page.getByRole('link',{name:'比较两次运行',exact:true})).toHaveAttribute('href',`/tasks/${a.task_id}/compare?left=${a.run_id}&right=${c.run_id}`);
});

test('单轮不能对比、任务ID复制可重试且不执行，归组资料默认折叠',async({page,request})=>{
  const run=await create(request,'Task single '+randomUUID().slice(0,5),undefined,'failed');
  await page.addInitScript(()=>{let attempts=0;Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{attempts++;if(attempts===1)throw Error('clipboard denied');(window as unknown as {copiedTask:string}).copiedTask=text;}}});});
  let posts=0;page.on('request',req=>{if(req.method()==='POST')posts++;});
  await page.goto('/tasks/'+run.task_id);
  await expect(page.getByRole('button',{name:'比较两次运行',exact:true})).toBeDisabled();
  await expect(page.getByRole('checkbox')).toBeDisabled();await expect(page.locator('.history-change-strip')).toHaveCount(0);
  await expect(page.locator('.history-again')).not.toHaveAttribute('open');await expect(page.locator('.history-technical')).not.toHaveAttribute('open');
  await page.locator('.history-again>summary').click();await expect(page.locator('.history-task-command')).toContainText('--task-id '+run.task_id);
  await page.getByRole('button',{name:'复制任务 ID',exact:true}).click();await expect(page.getByRole('alert')).toContainText('复制失败');
  await page.getByRole('button',{name:'复制任务 ID',exact:true}).click();await expect(page.getByRole('button',{name:'已复制任务 ID',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {copiedTask:string}).copiedTask)).toBe(run.task_id);expect(posts).toBe(0);
  await page.locator('.history-technical>summary').click();await expect(page.locator('.history-technical')).toContainText(run.task_id);
  for(const width of [1366,390]){await page.setViewportSize({width,height:768});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}
  await page.goto('/tasks/'+run.task_id+'/compare');await expect(page.locator('.comparison')).toHaveCount(0);await expect(page.locator('.notice').last()).toContainText('需要两次不同运行');
});

test('未知、历史来源和已有报告独立呈现，空任务仍提供真实入口',async({page,request})=>{
  const base=await create(request,'Task unknown');const task=await (await request.get('/api/tasks/'+base.task_id)).json();
  const run=task.runs[0];run.execution_status='unknown';run.outcome_status='unknown';run.origin='imported';run.capture_integrity='partial';run.insight.diagnosis={state:'hypothesis',report_count:1,report_kinds:['analyst_rca'],featured_report:null,latest_job:{state:'failed',mode:'analyst_rca',job_id:'fixture'}};
  task.namespace='imported/history';
  await page.route('**/api/tasks/'+base.task_id,route=>route.fulfill({json:task}));await page.goto('/tasks/'+base.task_id);
  await expect(page.locator('.history-run-table')).toContainText('执行状态未知');await expect(page.locator('.history-run-table')).toContainText('验收未知');await expect(page.locator('.history-run-table')).toContainText('待验证假设');await expect(page.locator('.history-run-table')).toContainText('最近作业失败');await expect(page.locator('.history-run-table')).toContainText('历史导入');
  await expect(page.getByRole('button',{name:'复制任务 ID'})).toHaveCount(0);
  await page.locator('.history-again>summary').click();await expect(page.locator('.history-again')).toContainText('导入清单');
  task.runs=[];await page.reload();await expect(page.locator('.history-empty-state')).toContainText('还没有运行记录');await expect(page.getByRole('link',{name:'打开最新运行'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'比较两次运行',exact:true})).toBeDisabled();
});

test('对比参数排除其他任务、重复选择，并允许已有合法链接刷新恢复',async({page,request})=>{
  const {a,b}=await fixture(request),foreign=await create(request,'Foreign task');
  await page.goto(`/tasks/${a.task_id}/compare?left=${a.run_id}&right=${foreign.run_id}`);
  await expect(page.locator('.notice').first()).toContainText('链接中的运行选择无效');await expect(page.getByRole('combobox',{name:'对照运行'})).not.toHaveValue(foreign.run_id);
  await page.goto(`/tasks/${a.task_id}/compare?left=${a.run_id}&right=${a.run_id}`);await expect(page.locator('.notice').first()).toContainText('链接中的运行选择无效');
  await page.goto(`/tasks/${a.task_id}/compare?left=${b.run_id}&right=${a.run_id}`);await page.reload();
  await expect(page.getByRole('combobox',{name:'基准运行'})).toHaveValue(b.run_id);await expect(page.getByRole('combobox',{name:'对照运行'})).toHaveValue(a.run_id);
});

test('任务列表搜索清空、来源和未知结果可读；窄屏不丢事实，刷新故障保留列表',async({page,request})=>{
  const goal='Task index '+randomUUID().slice(0,8);const run=await create(request,goal,undefined,undefined,1);
  await page.goto('/tasks');await page.getByRole('textbox',{name:'搜索任务'}).fill(run.task_id);
  await expect(page.locator('.history-task-table tbody tr')).toHaveCount(1);await expect(page.locator('.history-task-table')).toContainText(goal);
  await expect(page.locator('.history-task-table')).toContainText('执行失败');await expect(page.locator('.history-task-table')).toContainText('验收未知');
  await expect(page.locator('.history-task-table')).toContainText('合成演示');
  for(const width of [1366,390]){await page.setViewportSize({width,height:768});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}
  await page.route('**/api/tasks',route=>route.fulfill({status:503,json:{detail:'index unavailable'}}));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('保留上次记录');await expect(page.locator('.history-task-table')).toContainText(goal);
  await page.getByRole('textbox',{name:'搜索任务'}).fill('no such task');await expect(page.locator('.history-empty-state')).toContainText('没有匹配的任务');
  await page.getByRole('button',{name:'清空搜索',exact:true}).click();await expect(page.getByRole('textbox',{name:'搜索任务'})).toHaveValue('');
  await page.unroute('**/api/tasks');await page.route('**/api/tasks',route=>route.fulfill({json:[]}));await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.locator('.history-empty-state')).toContainText('还没有任务记录');
});
