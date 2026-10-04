import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function fixture(request:APIRequestContext){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const created=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'Run控件交互验收',sample_kind:'synthetic'}});
  expect(created.ok()).toBeTruthy();const run=await created.json();
  const input={command:'python '+('long-path/'.repeat(35))+'tests.py',arguments:['--verbose','--check']};
  const items=[
    {kind:'tool_call',name:'run_tests',correlation_id:'test',input},
    {kind:'tool_return',name:'run_tests',correlation_id:'test',ok:false,duration_ms:1000,error_signature:'AssertionError: expected 2',output:{returncode:1,stderr:'Traceback\nAssertionError: expected 2\n',stdout:'one test failed'}},
    {kind:'tool_call',name:'read_file',correlation_id:'read',input:{command:'read',path:'test.py'}},
    {kind:'tool_return',name:'read_file',correlation_id:'read',ok:true,output:'hello'},
    {kind:'log',name:'stdout',output:'plain log\nsecond line'},
    {kind:'tool_call',name:'unpaired_call',input:{path:'unpaired'}},
    {kind:'event',name:'RUN_END'},
  ].map((item,index)=>({event_id:randomUUID(),producer_id:'controls',producer_seq:index+1,occurred_at:new Date(Date.UTC(2026,9,4,1,0,index)).toISOString(),...item}));
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events:items}})).ok()).toBeTruthy();
  expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:0,producers:{controls:items.length}}})).ok()).toBeTruthy();
  return {run,input};
}

test('条件标签准确计数，可逐项移除和清空，保留选中步骤与视图',async({page,request})=>{
  const {run}=await fixture(request);let modelPosts=0;await page.route('**/api/runs/*/analyst-jobs',route=>{modelPosts++;return route.abort();});
  await page.goto('/runs/'+run.run_id);await expect(page.locator('.duration-bar')).toHaveCount(2);
  await page.getByLabel('事件类型',{exact:true}).selectOption('tool');await page.getByLabel('搜索事件').fill('command');
  await page.getByRole('button',{name:/仅异常/}).click();
  await expect(page.locator('.trace-filter-count')).toHaveText('匹配 1 / 5 步');await expect(page.locator('.filter-chip')).toHaveCount(3);
  await page.locator('.console-event').click();const selected=await page.locator('.console-event.selected').getAttribute('data-event-id');
  await page.getByRole('button',{name:'移除仅异常筛选',exact:true}).click();await expect(page.locator('.trace-filter-count')).toHaveText('匹配 2 / 5 步');
  await page.getByRole('button',{name:'移除搜索条件',exact:true}).click();await expect(page.locator('.trace-filter-count')).toHaveText('匹配 3 / 5 步');
  await page.getByRole('button',{name:'清空筛选',exact:true}).click();await expect(page.locator('.trace-filter-strip')).toHaveCount(0);
  await expect(page.getByLabel('事件类型',{exact:true})).toHaveValue('');await expect(page.getByLabel('搜索事件')).toHaveValue('');
  await expect(page.getByRole('button',{name:'全部事件',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);await expect(page.locator('.time-point')).toHaveCount(3);
  expect(modelPosts).toBe(0);
});

test('分段控件支持方向键，时间轴导航缩放与适配仍使用真实坐标',async({page,request})=>{
  const {run}=await fixture(request);await page.goto('/runs/'+run.run_id);
  await page.getByRole('button',{name:'执行步骤',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button',{name:'全部事件',exact:true})).toBeFocused();await expect(page.locator('.console-event')).toHaveCount(5);
  await page.keyboard.press('Home');await expect(page.getByRole('button',{name:'执行步骤',exact:true})).toBeFocused();await expect(page.locator('.console-event')).toHaveCount(4);
  await page.getByRole('button',{name:'本页',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('button',{name:'整轮',exact:true})).toHaveAttribute('aria-pressed','true');
  const initial=await page.locator('.time-ruler').getAttribute('data-view-end');
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();await expect(page.locator('.timeline-zoom')).toHaveText('2×');
  await page.getByRole('button',{name:'适配时间范围',exact:true}).click();await expect(page.locator('.timeline-zoom')).toHaveText('1×');
  await expect(page.locator('.time-ruler')).toHaveAttribute('data-view-end',initial!);
});

test('代码换行、行号、复制与展开不改变原文、事件选择或时间窗',async({page,request})=>{
  const {run,input}=await fixture(request);await page.goto('/runs/'+run.run_id);
  await page.getByRole('button',{name:'选择工具执行 1 run_tests',exact:true}).click();
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as any).__copied=value;}}});});
  const viewer=page.getByRole('group',{name:'Call / Arguments 阅读工具',exact:true});
  await expect(viewer.locator('.code-line')).toHaveCount(7);
  const geometry=await viewer.locator('pre').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth,rows:[...el.querySelectorAll('.code-line')].map(row=>row.getBoundingClientRect().top)}));
  expect(geometry.rows[1]).toBeGreaterThan(geometry.rows[0]);expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width+1);
  await viewer.getByRole('button',{name:'显示行号',exact:true}).click();await expect(viewer.locator('.code-line-number')).toHaveCount(7);
  await viewer.getByRole('button',{name:'复制内容',exact:true}).click();await expect(viewer.getByRole('button',{name:'已复制内容',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__copied)).toBe(JSON.stringify(input,null,2));
  await viewer.getByRole('button',{name:'自动换行',exact:true}).click();expect(await viewer.locator('pre').evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await page.getByRole('button',{name:'放大时间轴',exact:true}).click();const end=await page.locator('.time-ruler').getAttribute('data-view-end'),selected=await page.locator('.console-event.selected').getAttribute('data-event-id');
  const expand=viewer.getByRole('button',{name:'展开阅读',exact:true});await expand.click();const dialog=page.getByRole('dialog',{name:'展开阅读 Call / Arguments',exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toContainText(input.command);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(expand).toBeFocused();
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);await expect(page.locator('.time-ruler')).toHaveAttribute('data-view-end',end!);
});

test('复制失败可重试；1366和窄屏布局不溢出，原始证据仍可读取',async({page,request})=>{
  const {run}=await fixture(request);await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  const viewer=page.getByRole('group',{name:'错误内容 阅读工具',exact:true});
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{if(!(window as any).__allowCopy)throw new Error('denied');}}});});
  await viewer.getByRole('button',{name:'复制内容',exact:true}).click();await expect(viewer.getByRole('alert')).toContainText('未能复制');
  await page.evaluate(()=>{(window as any).__allowCopy=true;});await viewer.getByRole('button',{name:'重试',exact:true}).click();await expect(viewer.getByRole('alert')).toHaveCount(0);
  await page.getByRole('tab',{name:'原始证据',exact:true}).click();await expect(page.locator('.source-code')).toContainText('run_tests');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight)).toBe(false);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
