import {test,expect} from '@playwright/test';

test('已完成 RCA 的发送预览、假设和证据展示',async({page,request})=>{
  const runId=process.env.E2E_ANALYST_RUN_ID;
  test.skip(!runId,'Use a pre-accepted local synthetic RCA run; this browser check makes no model calls');
  const reports=await (await request.get('/api/runs/'+runId+'/diagnoses')).json();
  expect(reports.some((report:{mode?:string})=>report.mode==='analyst_rca')).toBeTruthy();
  await page.goto('/runs/'+runId);
  const latestRca=page.locator('.report-view').filter({has:page.getByRole('heading',{name:'待验证的根因假设'})}).first();
  await expect(latestRca.getByRole('heading',{name:'待验证的根因假设'})).toBeVisible();
  await expect(latestRca.getByText('建议验证 · 尚未执行')).toBeVisible();
  await page.getByRole('button',{name:'查看 RCA 发送内容'}).click();
  await expect(page.getByRole('heading',{name:/即将发送给/})).toBeVisible();
  await expect(page.locator('.analyst-preview pre')).toContainText('selected_subtrajectory');
  let submitted:{preview_sha256?:string;hgt_diagnosis_id?:string}|null=null;
  await page.route('**/api/runs/'+runId+'/analyst-jobs',async route=>{
    submitted=route.request().postDataJSON();
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job_id:'synthetic-browser-job',mode:'analyst_rca',state:'queued',error:null,input_snapshot_hash:'fixture',input_evidence_id:'fixture',created_at:new Date().toISOString()})});
  });
  await page.getByRole('button',{name:'确认并运行 RCA'}).click();
  await expect.poll(()=>submitted).not.toBeNull();
  expect(submitted!.preview_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(submitted!.hgt_diagnosis_id).toBeTruthy();
  await latestRca.locator('.evidence-chip.resolved').first().click();
  await expect(page.getByRole('tab',{name:'原始证据',exact:true})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:'../../.local/screenshots/v03-analyst-mobile.png',fullPage:true});
});
