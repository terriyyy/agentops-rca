import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const fixture = path.resolve('../../tests/fixtures/demo');

test('导入 → 两轮对照 → 诊断证据 → 验收证据 → 去重', async ({page}) => {
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/imports');
  const manifest=JSON.parse(fs.readFileSync(path.join(fixture,'manifest.json'),'utf8'));
  manifest.source_namespace=`e2e/workbench/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.getByLabel('导入清单',{exact:true}).setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
  const names = [...new Set(manifest.runs.flatMap((r:Record<string,string>)=>['telemetry','report','outcome','feedback'].map(key=>r[key]).filter(Boolean)))] as string[];
  await page.getByLabel('数据文件',{exact:true}).setInputFiles(names.map(name=>path.join(fixture,name)));
  await page.getByRole('button',{name:'校验并导入',exact:true}).click();
  await expect(page.getByRole('status')).toContainText(/导入完成|记录已存在/);
  await page.getByRole('link',{name:'打开任务',exact:true}).click();
  await expect(page.getByRole('heading',{level:1})).toContainText('修复矩阵写入逻辑');
  await expect(page.locator('.run-card').first()).toContainText('合成演示');
  await page.getByRole('link',{name:'比较两次运行',exact:true}).click();
  await expect(page.locator('.comparison')).toContainText('验收未通过');
  await expect(page.locator('.comparison')).toContainText('验收通过');
  await page.screenshot({path:'../../.local/screenshots/comparison.png',fullPage:true});
  await page.getByRole('link',{name:'查看运行详情',exact:true}).first().click();
  await page.getByRole('tab',{name:/^原因分析/}).click();
  await page.locator('.evidence-chip.resolved').first().click();
  await expect(page.getByRole('tab',{name:'原始证据',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.source-code')).toContainText('shared-test');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab',{name:/^任务检查/}).click();
  await page.getByRole('button',{name:'查看检查记录',exact:true}).click();
  await expect(page.locator('.source-code')).toContainText('synthetic_test_harness');
  await page.getByRole('button',{name:'关闭证据',exact:true}).click();
  await expect(page.locator('.execution-pane')).toBeVisible();
  await expect(page.locator('.duration-bar')).toHaveCount(0); // Fixture timestamps and recorded durations disagree.
  await page.getByLabel('搜索事件').fill('assertion_failed');
  await expect(page.locator('.trace-row')).toHaveCount(1);
  await page.getByRole('link',{name:'运行工作台',exact:true}).click();
  await expect(page.getByRole('heading',{name:'需要处理',exact:false})).toBeVisible();
  await expect(page.locator('.workbench-run').filter({hasText:'修复矩阵写入逻辑'}).first()).toBeVisible();
  await page.screenshot({path:'../../.local/screenshots/workbench.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'运行工作台',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:'../../.local/screenshots/mobile.png',fullPage:true});
  expect(errors).toEqual([]);
});

test('非法文件会给出可读错误且不产生新任务',async({page})=>{
  await page.goto('/imports');
  await page.getByLabel('导入清单',{exact:true}).setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from('{"runs":[]}')});
  await page.getByLabel('数据文件',{exact:true}).setInputFiles({name:'trace.jsonl',mimeType:'text/plain',buffer:Buffer.from('{}')});
  await page.getByRole('button',{name:'校验并导入',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('清单字段不符合契约');
});

test('真实 SymPy 记录的页面与证据验收',async({page,request})=>{
  test.skip(!process.env.E2E_REAL,'只有本机已导入真实数据时才运行');
  const tasks=await (await request.get('/api/tasks')).json();
  const task=tasks.find((t:{external_id:string})=>t.external_id==='sympy__sympy-13031');
  expect(task).toBeTruthy();
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/tasks');
  await expect(page.getByRole('heading',{name:'任务历程',exact:true})).toBeVisible();
  await page.screenshot({path:'../../.local/screenshots/real-workbench.png',fullPage:true});
  await page.goto('/tasks/'+task.id+'/compare');
  await expect(page.locator('.comparison')).toContainText('验收未通过');
  await expect(page.locator('.comparison')).toContainText('验收通过');
  await page.getByRole('link',{name:'查看运行详情',exact:true}).first().click();
  await expect(page.locator('.hypothesis-evidence')).toBeVisible();
  await page.locator('.evidence-chip.resolved').first().click();
  await expect(page.locator('.source-code')).toContainText('tool_return');
  await page.screenshot({path:'../../.local/screenshots/real-evidence.png',fullPage:true});
  await page.keyboard.press('Escape');
  await expect(page.locator('.execution-pane')).toBeVisible();
  await expect(page.locator('.trace-row')).toHaveCount(50);
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.locator('.trace-position').first()).toContainText('051');
  expect(errors).toEqual([]);
});
