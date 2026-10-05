import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 全应用使用流程测试（第 42 轮全面测试）：proposal.spec 锁自动提议链路、
 * smoke.spec 锁渲染几何——这里补上其余四大分区的主要使用路径：
 * 记录（一键就寝/手动补录）、趋势统计、AI 对话、主题、备份往返、护眼，
 * 外加一个"全分区漫游零未捕获错误"的看门狗。
 *
 * 文案定位器来自源码（ManualLogModal/TrendsTab/AIAdvicePanel/EyeCareTab/
 * SettingsTab），改文案时这些用例红是正常的同步提醒。
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const dstr = (off: number, base = new Date()): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const mkRecord = (date: string, bedtime: string, wakeTime: string, score = 86) => ({
  id: 'r-' + date + '-' + bedtime, date, bedtime, wakeTime,
  durationMinutes: 480, deepSleepMinutes: 90, lightSleepMinutes: 300,
  remSleepMinutes: 70, awakeMinutes: 10, sleepScore: score, sleepEfficiency: 91,
  latencyMinutes: 12, wakeCount: 1,
});

/** 预置 N 晚记录（升序写入，App 会重排），跳过开屏引导 */
const seed = async (page: Page, records: unknown[] = []) => {
  await page.addInitScript(({ recs }: { recs: string }) => {
    localStorage.setItem('somnacare_sleep_records', recs);
    localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  }, { recs: JSON.stringify(records) });
};

/** 钉死时钟并打开首页（开屏动画播完）。返回钉住的时刻 */
const openAt = async (page: Page, h: number, m: number): Promise<Date> => {
  const fixed = new Date();
  fixed.setHours(h, m, 0, 0);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  return fixed;
};

/** 未钉时钟的普通打开 */
const open = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
};

const navTo = (page: Page, tab: string) =>
  page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: tab }).click();

const readStore = (page: Page, key: string): Promise<any> =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);

test('一键就寝：开始监测 → 推进 90 分钟 → 结算落库', async ({ page }) => {
  const fixed = await openAt(page, 23, 0);
  await seed(page, [mkRecord(dstr(-1, fixed), '23:40', '08:10')]);
  await open(page);

  await page.getByRole('button', { name: /开始夜间监测/ }).click();
  await expect(page.getByText(/正在实时记录中/)).toBeVisible();
  await page.clock.runFor(90 * 60 * 1000);   // 快进 90 分钟（Date.now 与定时器同步推进）
  await page.getByRole('button', { name: /已醒来/ }).click();

  // 完成小结弹出（90 分钟 → 正常晨安路径或短时记录路径都算链路活着）
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible();
  await page.getByRole('button', { name: '确定并查看详情' }).click();

  const recs = await readStore(page, 'somnacare_sleep_records');
  const landed = (recs as any[]).find((r) => r.recordSource === 'onetap');
  expect(landed).toBeTruthy();
  // durationMinutes = 纯睡眠（卧床窗 − 觉醒段）：90 分钟窗 − 12 分钟缺省入睡
  // 潜伏期 = 78，recordBuilder 的既定口径
  expect(landed.durationMinutes).toBeGreaterThanOrEqual(76);
  expect(landed.durationMinutes).toBeLessThanOrEqual(80);
});

test('晨起手动补录：表单填写 → 保存落库', async ({ page }) => {
  const fixed = await openAt(page, 9, 0);
  const today = dstr(0, fixed);
  await seed(page, [mkRecord(dstr(-1, fixed), '23:40', '08:10')]);
  await open(page);

  await page.getByText('晨起手动补录').click();
  await expect(page.getByText('晨起极速记录 / 真实补录')).toBeVisible();

  const dateInput = page.locator('input[type="date"]');
  await dateInput.fill(today);
  const timeInputs = page.locator('input[type="time"]');
  await timeInputs.nth(0).fill('23:30');
  await timeInputs.nth(1).fill('07:30');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();

  await expect(page.getByText('晨起极速记录 / 真实补录')).toHaveCount(0);   // 弹窗已收
  const recs = await readStore(page, 'somnacare_sleep_records');
  const landed = (recs as any[]).find((r) => r.date === today);
  expect(landed?.bedtime).toBe('23:30');
  expect(landed?.wakeTime).toBe('07:30');
});

test('趋势页：统计卡与历史记录渲染', async ({ page }) => {
  const fixed = new Date();
  const recs = Array.from({ length: 7 }, (_, i) =>
    mkRecord(dstr(-(i + 1), fixed), i % 2 ? '23:30' : '00:10', '07:30', 90 - i * 3));
  await seed(page, recs);
  await open(page);

  await navTo(page, '趋势');
  await expect(page.getByText('趋势与结构')).toBeVisible();
  await expect(page.getByText('近期睡眠小结')).toBeVisible();
  await expect(page.getByText('平均评分')).toBeVisible();
  await expect(page.getByText('日均时长')).toBeVisible();
  await expect(page.getByText('作息规律度')).toBeVisible();
  await expect(page.getByText('历史记录')).toBeVisible();
  // 暂无数据记录是空态文案——有 7 晚数据时绝不能出现
  await expect(page.getByText('暂无数据记录')).toHaveCount(0);
});

test('AI 顾问：本地兜底对话应答 + 新对话', async ({ page }) => {
  await seed(page, [mkRecord(dstr(-1), '23:30', '07:30')]);
  await open(page);
  await navTo(page, 'AI顾问');

  await page.getByPlaceholder('输入睡眠疑问...').fill('最近总是半夜醒来怎么办');
  await page.getByRole('button', { name: '发送睡眠疑问' }).click();

  // 无 Key 环境 → 服务端本地规则引擎按话题兜底（"半夜易醒"→ 应对指南）
  await expect(page.getByText(/应对指南/).first()).toBeVisible({ timeout: 15000 });

  // 新对话：清空当前会话且不崩
  await page.getByRole('button', { name: /新对话/ }).click();
  await expect(page.getByText('最近总是半夜醒来怎么办')).toHaveCount(0);
});

test('主题切换：下拉选择 → 刷新后持久', async ({ page }) => {
  await seed(page, []);
  await open(page);
  await navTo(page, '偏好');
  await page.getByText('界面主题').click();     // 展开主题下拉
  await page.getByRole('button', { name: /深空纯黑/ }).click();
  // 选中后：头部显示当前主题 + 选项行标"✓ 使用中"（两处同文，用角色区分）
  await expect(page.getByRole('button', { name: /深空纯黑 \(OLED\) ✓ 使用中/ })).toBeVisible();

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '偏好');
  // 刷新后仍是所选拨主题（头部下拉收起态即显示主题名）
  await expect(page.getByRole('button', { name: /界面主题 深空纯黑 \(OLED\)/ })).toBeVisible();
});

test('备份往返：导出 JSON → 导入恢复 → 记录无损', async ({ page }) => {
  const fixed = new Date();
  const recs3 = [mkRecord(dstr(-1, fixed), '23:30', '07:30'), mkRecord(dstr(-2, fixed), '00:10', '07:40'), mkRecord(dstr(-3, fixed), '23:50', '07:20')];
  await seed(page, recs3);
  await open(page);
  await navTo(page, '偏好');

  const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
  await page.getByRole('button', { name: /导出 JSON 备份/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  // 备份文件形状（backup.ts）：{ app, schema, exportedAt, records, profile, ... }——records 在顶层
  const backup = JSON.parse(readFileSync(path, 'utf-8'));
  expect(backup.records.length).toBe(3);
  expect(backup.app).toBe('somnacare');

  // 导入同一份文件（原生 confirm → 自动接受）。导入入口是包着 hidden
  // file input 的 label——直接对 input 设文件，无需点击 label
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('input[type="file"]', path);
  await page.waitForTimeout(1200);

  const after = await readStore(page, 'somnacare_sleep_records');
  expect((after as any[]).length).toBe(3);   // 往返无损
});

test('护眼开关：开启 → 刷新后保持', async ({ page }) => {
  await seed(page, []);
  await open(page);
  await navTo(page, '护眼');
  const toggle = page.getByRole('checkbox', { name: '开启或关闭护眼滤镜', exact: true });
  // ★ 不能对 sr-only 输入 force click：五分区是常驻滑动轨道，切 tab 后轨道
  // 仍在缓动，force 跳过稳定性检查会按陈旧坐标点进相邻分区（矩阵实验实证）。
  // 点击包裹它的可见 label——自动等待滑动稳定，且 label 原生联动 checkbox
  const toggleLabel = page.locator('label').filter({ has: toggle });
  await toggleLabel.click();
  await expect(toggle).toBeChecked({ timeout: 5000 });

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '护眼');
  await expect(page.getByRole('checkbox', { name: '开启或关闭护眼滤镜', exact: true })).toBeChecked();
});

test('全分区漫游：零未捕获错误（React 开发警告除外）', async ({ page }) => {
  const fixed = new Date();
  const recs = Array.from({ length: 5 }, (_, i) => mkRecord(dstr(-(i + 1), fixed), '23:30', '07:30'));
  await seed(page, recs);
  await open(page);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  for (const tab of ['趋势', 'AI顾问', '护眼', '偏好', '睡眠']) {
    await navTo(page, tab);
    await page.waitForTimeout(900);
  }

  // 未捕获异常一票否决；React 开发警告（console.error 形态）单列容忍——
  // 它们是 dev build 的提示而非运行时故障
  expect(pageErrors, '未捕获异常').toEqual([]);
  const realErrors = consoleErrors.filter((t) => !/^Warning:/.test(t));
  expect(realErrors, '非警告类 console.error').toEqual([]);
});
