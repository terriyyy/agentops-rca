import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function create(request:APIRequestContext,finished=true,extraCount=0){
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const result=await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'步骤筛选与调查交互验收',sample_kind:'synthetic'}});
  expect(result.ok()).toBeTruthy();const run=await result.json();
  const event=(seq:number,extra:Record<string,unknown>={})=>({event_id:randomUUID(),producer_id:'u4-ui',producer_seq:seq,occurred_at:new Date(Date.UTC(2026,9,4,0,0,seq)).toISOString(),kind:'log',name:'log-'+seq,output:'plain log',...extra});
  const items=[event(1,{kind:'event',name:'RUN_START'}),event(2),event(3,{kind:'tool_call',name:'read_file',correlation_id:'file',input:{path:'hello.txt'}}),event(4,{kind:'tool_return',name:'read_file',correlation_id:'file',ok:true,duration_ms:1000,output:{text:'hello'}}),event(5,{kind:'llm',name:'LLM_RESPONSE',duration_ms:800,output:'model result'}),event(6,{error_signature:'logged_error'}),event(7,{kind:'verification',name:'OUTCOME_EVIDENCE',input:{status:'passed',source:'fixture-check',basis:'assert output'},output:null}),...Array.from({length:extraCount},(_,i)=>event(i+8,{kind:'event',name:'step-'+(i+8)}))];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events:items}})).ok()).toBeTruthy();
  if(finished)expect((await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:0,producers:{'u4-ui':items.length}}})).ok()).toBeTruthy();
  const all=await(await request.get(`/api/runs/${run.run_id}/events?limit=100`)).json();
  return {...run,headers,items:all.items,event};
}

test('默认步骤保留异常日志和检查，全部事件与原始证据仍可访问',async({page,request})=>{
  const run=await create(request);let modelPosts=0;await page.route('**/api/runs/*/analyst-jobs',route=>{modelPosts++;return route.abort();});
  await page.goto('/runs/'+run.run_id);
  await expect(page.getByRole('button',{name:'执行步骤',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.console-event')).toHaveCount(5);
  await expect(page.locator('.console-event').filter({hasText:'logged_error'})).toHaveCount(0);
  await expect(page.locator('.console-event').filter({hasText:'log-6'})).toHaveCount(1);
  await expect(page.locator('.console-event').filter({hasText:'OUTCOME_EVIDENCE'})).toHaveCount(1);
  await expect(page.locator('.toolbar-count')).toContainText('6 步 · 7 原始事件');
  await page.getByLabel('事件类型',{exact:true}).selectOption('log');
  await expect(page.getByRole('button',{name:'全部事件',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.console-event')).toHaveCount(2);
  await page.getByRole('button',{name:'执行步骤',exact:true}).click();
  await page.getByLabel('搜索事件').fill('log-2');await expect(page.locator('.console-event')).toHaveCount(1);
  await page.locator('.console-event').click();await page.getByRole('tab',{name:'原始证据',exact:true}).click();
  await expect(page.locator('.source-code')).toContainText('plain log');
  await page.getByRole('button',{name:'执行步骤',exact:true}).click();
  await expect(page.locator('.workspace-notice').filter({hasText:'选中事件不在当前'})).toBeVisible();
  await page.getByRole('button',{name:'定位并显示'}).click();
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',run.items[1].event_id);
  await expect(page.locator('.duration-bar')).toHaveCount(1); // Only the reliably paired tool has a time interval.
  await expect(page.getByRole('button',{name:'选择事件 5 LLM_RESPONSE',exact:true}).locator('.duration-bar')).toHaveCount(0);
  expect(modelPosts).toBe(0);
});

test('视图偏好按Run保留，定位链接能够找到原始返回且拒绝无效事件',async({page,request})=>{
  const run=await create(request),other=await create(request);
  await page.goto('/runs/'+run.run_id);await page.getByLabel('事件类型',{exact:true}).selectOption('tool');
  await page.getByRole('button',{name:'整轮',exact:true}).click();await page.reload();
  await expect(page.getByLabel('事件类型',{exact:true})).toHaveValue('tool');await expect(page.getByRole('button',{name:'整轮',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.goto('/runs/'+other.run_id);await expect(page.getByLabel('事件类型',{exact:true})).toHaveValue('');
  await page.goto(`/runs/${run.run_id}?event=${run.items[3].event_id}`);
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',run.items[2].event_id);
  await expect(page.locator('.event-origin-links .evidence-location')).toHaveCount(2);
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as any).__copied=value;}}});});
  await page.getByRole('button',{name:'复制事件定位链接'}).click();await expect(page.getByRole('button',{name:'已复制事件定位链接'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__copied)).toContain('event='+run.items[2].event_id);
  await page.goto(`/runs/${run.run_id}?event=not-a-real-event`);
  await expect(page.locator('.workspace-notice').filter({hasText:'定位链接中的事件不属于当前 Run'})).toBeVisible();
  await expect(page.locator('.console-event.selected')).toHaveCount(0);
});

test('上下键连续调查并跨页移动焦点，搜索框不触发选择',async({page,request})=>{
  const run=await create(request,true,54);await page.goto('/runs/'+run.run_id);
  await expect(page.locator('.console-event')).toHaveCount(50);
  const rows=page.locator('.console-event');await rows.first().focus();await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();await expect(rows.nth(1)).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('ArrowDown');await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');await expect(rows.nth(1)).toBeFocused();
  await rows.last().focus();await page.keyboard.press('ArrowDown');
  await expect(page.locator('.execution-footer')).toContainText('2/2');await expect(rows.first()).toBeFocused();
  const selected=await page.locator('.console-event.selected').getAttribute('data-event-id');
  await page.getByLabel('搜索事件').focus();await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('搜索事件')).toBeFocused();await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);
});

test('分栏支持拖动键盘与刷新，1366桌面保持时间轴对齐和可读字号',async({page,request})=>{
  const run=await create(request);await page.setViewportSize({width:1366,height:768});await page.goto('/runs/'+run.run_id);
  const divider=page.getByRole('separator',{name:'调整轨迹与详情宽度'});
  await divider.focus();await page.keyboard.press('ArrowLeft');await expect(divider).toHaveAttribute('aria-valuenow','58');
  const box=(await divider.boundingBox())!;await page.mouse.move(box.x+4,box.y+30);await page.mouse.down();await page.mouse.move(box.x-40,box.y+30);await page.mouse.up();
  const value=Number(await divider.getAttribute('aria-valuenow'));expect(value).toBeLessThan(58);
  await page.reload();await expect(divider).toHaveAttribute('aria-valuenow',String(value));
  await expect(page.locator('.duration-bar')).toHaveCount(1);
  const geometry=await page.evaluate(()=>({ruler:document.querySelector('.time-ruler')!.getBoundingClientRect().left,timing:document.querySelector('.event-timing')!.getBoundingClientRect().left,font:getComputedStyle(document.querySelector('.console-event-name strong')!).fontSize,overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight}));
  expect(Math.abs(geometry.ruler-geometry.timing)).toBeLessThan(1);expect(geometry.font).toBe('15px');expect(geometry.overflow).toBe(false);
});

test('实时暂停保留当前事件，新事件数量提示后可恢复跟随',async({page,request})=>{
  const run=await create(request,false);await page.goto('/runs/'+run.run_id);
  await expect(page.getByRole('button',{name:'暂停跟随',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'选择工具执行 3 read_file',exact:true}).click();
  const selected=await page.locator('.console-event.selected').getAttribute('data-event-id');
  const newItems=[run.event(8),run.event(9,{kind:'event',name:'new-step'})];
  expect((await request.post(`/api/live/runs/${run.run_id}/events`,{headers:run.headers,data:{events:newItems}})).ok()).toBeTruthy();
  await expect(page.getByRole('button',{name:'跟随最新 · 2 条新事件',exact:true})).toBeVisible();
  await expect(page.locator('.console-event.selected')).toHaveAttribute('data-event-id',selected!);
  await page.getByRole('button',{name:'跟随最新 · 2 条新事件',exact:true}).click();
  await expect(page.locator('.console-event.selected')).toContainText('new-step');await expect(page.getByRole('button',{name:'暂停跟随',exact:true})).toBeVisible();
});
