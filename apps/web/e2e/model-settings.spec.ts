import {test,expect,type APIRequestContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';

async function reset(request:APIRequestContext){const value=await(await request.get('/api/settings/rca-model')).json();await request.delete('/api/settings/rca-model',{data:{expected_revision:value.revision}});}

test('连接创建编辑删除持久化，密码不回填且保存不调用模型',async({page,request})=>{
  await reset(request);let modelJobs=0;
  page.on('request',r=>{if(r.method()==='POST'&&/analyst-jobs|diagnosis-jobs/.test(r.url()))modelJobs++});
  await page.goto('/system');await page.getByRole('link',{name:'管理模型连接'}).click();
  await expect(page.getByRole('heading',{name:'模型连接',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'添加连接',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'添加模型连接'});
  await dialog.getByLabel('连接名称',{exact:true}).fill('团队测试代理');
  await dialog.getByLabel(/服务地址/).fill('https://fixture.example/v1');
  await dialog.locator('input[type=password]').fill('browser-fixture-private-key');
  await dialog.getByLabel('默认分析模型',{exact:true}).fill('fixture-model');
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(page.locator('.model-connection-row')).toContainText('fixture-model');
  await expect(page.locator('.model-call-status')).toHaveText('已保存 · 尚未验证');
  const response=await request.get('/api/settings/rca-model');expect(response.headers()['cache-control']).toBe('no-store');
  expect(JSON.stringify(await response.json())).not.toContain('browser-fixture-private-key');
  await page.reload();await expect(page.locator('.model-connection-row')).toContainText('团队测试代理');
  const edit=page.getByRole('button',{name:'编辑模型连接',exact:true});await edit.click();
  const editor=page.getByRole('dialog',{name:'编辑模型连接'});
  await expect(editor.locator('input[type=password]')).toHaveValue('');
  await editor.getByLabel('默认分析模型',{exact:true}).fill('fixture-model-b');
  await editor.getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(page.locator('.model-connection-row')).toContainText('fixture-model-b');
  await edit.click();await editor.getByLabel(/服务地址/).fill('https://other.example/v1');
  await expect(editor.locator('input[type=password]')).toHaveAttribute('required','');
  await editor.getByRole('button',{name:'保存配置',exact:true}).click();await expect(editor).toBeVisible();
  await editor.getByRole('button',{name:'取消',exact:true}).click();await expect(edit).toBeFocused();
  await page.getByRole('button',{name:'删除模型连接'}).click();
  await page.getByRole('dialog',{name:'删除模型连接？'}).getByRole('button',{name:'确认删除'}).click();
  await expect(page.locator('.model-empty')).toBeVisible();await page.reload();await expect(page.locator('.model-empty')).toBeVisible();
  expect(modelJobs).toBe(0);expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('browser-fixture-private-key');
});

test('配置加载失败支持重试，窄屏与弹窗键盘焦点可用',async({page,request})=>{
  await reset(request);
  await page.route('**/api/settings/rca-model',r=>r.fulfill({status:503,json:{detail:'读取失败'}}));
  await page.goto('/settings/models');await expect(page.getByRole('alert')).toContainText('读取失败');await expect(page.getByRole('button',{name:'添加连接',exact:true})).toBeDisabled();
  await page.unroute('**/api/settings/rca-model');await page.getByRole('button',{name:'重新读取'}).click();
  for(const width of [1440,1366,390]){
    await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    const trigger=page.getByRole('button',{name:'添加连接',exact:true});await trigger.click();
    const dialog=page.getByRole('dialog',{name:'添加模型连接'});await expect(dialog).toBeVisible();
    const bounds=await dialog.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
    await expect(dialog.getByRole('button',{name:'保存配置'})).toBeVisible();
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toBeFocused();
  }
});

test('并发编辑冲突保留表单并清楚提示，密钥不会作为错误显示',async({page,request})=>{
  await reset(request);await page.goto('/settings/models');await page.getByRole('button',{name:'添加连接',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('连接名称',{exact:true}).fill('draft');await dialog.getByLabel(/服务地址/).fill('https://fixture.example/v1');await dialog.locator('input[type=password]').fill('draft-private-key');await dialog.getByLabel('默认分析模型',{exact:true}).fill('draft-model');
  const current=await(await request.get('/api/settings/rca-model')).json();
  await request.put('/api/settings/rca-model',{data:{name:'another-tab',base_url:'https://fixture.example/v1',model:'another-model',api_key:'another-private-key',expected_revision:current.revision}});
  await dialog.getByRole('button',{name:'保存配置'}).click();await expect(dialog.getByRole('alert')).toContainText('模型配置已被修改');await expect(dialog.getByRole('alert')).not.toContainText('draft-private-key');
  await expect(dialog.getByLabel('默认分析模型',{exact:true})).toHaveValue('draft-model');await page.keyboard.press('Escape');await reset(request);
});

test('Run 显示动态模型与实际发送目标，配置改变关闭旧预览，不创建作业',async({page,request})=>{
  const token=randomUUID()+randomUUID(),headers={Authorization:'Bearer '+token};
  const run=await(await request.post('/api/live/runs',{data:{request_id:randomUUID(),write_token:token,goal:'模型连接联动夹具',sample_kind:'synthetic'}})).json();
  const events=[{kind:'tool_call',name:'test',correlation_id:'call'},{kind:'tool_return',name:'test',correlation_id:'call',ok:false,output:{returncode:1}}].map((item,index)=>({...item,event_id:randomUUID(),producer_id:'fixture',producer_seq:index+1,occurred_at:new Date(Date.UTC(2026,9,5,1,0,index)).toISOString()}));
  await request.post(`/api/live/runs/${run.run_id}/events`,{headers,data:{events}});await request.post(`/api/live/runs/${run.run_id}/finish`,{headers,data:{exit_code:0,producers:{fixture:2}}});
  let revision='revision-a',posts=0;page.on('request',r=>{if(r.method()==='POST')posts++});
  await page.route('**/api/diagnosis/capabilities',r=>r.fulfill({json:{status:'ready',hgt:'ready',analyst:'configured',model:'my-model',provider:'我的连接',base_url:'https://fixture.example/v1',config_revision:revision,reason:'fixture'}}));
  await page.route(`**/api/runs/${run.run_id}/diagnosis-jobs`,r=>r.fulfill({json:[{job_id:'fixture',mode:'offline_hgt',state:'succeeded',created_at:'2026-10-05',error:null}]}));
  await page.route(`**/api/runs/${run.run_id}/analyst-preview`,r=>r.fulfill({json:{model:'my-model',provider:'我的连接',base_url:'https://fixture.example/v1',config_revision:'revision-a',prompt:{candidate:'fixture'},request:{model:'my-model',messages:[{role:'system',content:'Fixture instruction'},{role:'user',content:'Fixture evidence'}],max_tokens:2500},prompt_sha256:'a'.repeat(64),preview_sha256:'b'.repeat(64),hgt_diagnosis_id:'fixture',prompt_bytes:250,truncated:false}}));
  await page.goto('/runs/'+run.run_id);await page.locator('.run-analysis-trigger').click();
  await expect(page.locator('.analysis-model-connection')).toContainText('我的连接 / my-model');
  await expect(page.getByRole('link',{name:'管理连接',exact:true})).toHaveAttribute('href','/settings/models');
  await page.getByRole('button',{name:'预览并分析原因',exact:true}).click();
  await expect(page.getByRole('region',{name:'模型发送预览'})).toContainText('https://fixture.example/v1/chat/completions');
  await expect(page.locator('.analyst-preview pre')).toContainText('Fixture instruction');
  revision='revision-b';await expect(page.getByRole('region',{name:'模型发送预览'})).toHaveCount(0,{timeout:7000});
  await expect(page.getByRole('alert')).toContainText('模型连接已更改');expect(posts).toBe(0);
});
