import { expect, test } from '@playwright/test';
import {
  dstr,
  mkRecord,
  mkRecordWithStages,
  mockNativeUsage,
  navTo,
  NIGHT_SCHEMA,
  openAt,
  seed,
  synthEvents,
  watchErrors,
} from './_journeyHelpers';

// ─────────────────────────────────────────────────────────────
// 旅程 15：就诊摘要（I）——预览、切换具体时刻、导出
// ─────────────────────────────────────────────────────────────
test('旅程15 就诊摘要：预览可生成、可切换时刻、可下载', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 10, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:05'),
    mkRecord(dstr(-2, fixed), '23:20', '06:55'),
    mkRecord(dstr(-3, fixed), '00:10', '07:30'),
    mkRecord(dstr(-4, fixed), '23:50', '07:10'),
  ], NIGHT_SCHEMA);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  await page.getByRole('button', { name: '生成就诊摘要' }).click();
  await expect(page.getByRole('img', { name: '就诊摘要预览' })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: '包含具体时刻' }).click();
  await expect(page.getByRole('img', { name: '就诊摘要预览' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '保存 / 分享' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('clinical-summary');
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程24 趋势图可读性：Y 轴刻度 / 分期横带 / 起卧目标窗口
// ─────────────────────────────────────────────────────────────
test('旅程24 趋势图可读性：坐标刻度、分期横带、起卧目标窗口', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:10', '07:10', 88),
    mkRecord(dstr(-2, fixed), '00:20', '08:10', 84),
    mkRecord(dstr(-3, fixed), '23:45', '07:20', 91),
    mkRecord(dstr(-4, fixed), '00:55', '08:40', 73),
    mkRecord(dstr(-5, fixed), '23:20', '07:05', 86),
    mkRecord(dstr(-6, fixed), '23:35', '07:35', 93),
    mkRecord(dstr(-7, fixed), '00:10', '07:50', 82),
  ], {
    ...NIGHT_SCHEMA,
    somnacare_user_profile: JSON.stringify({ targetBedtime: '23:30', targetWakeTime: '07:30' }),
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  // Phase 1 数据诚实重构：默认视图 = 起卧时段（真实测量），分期降为估算 tab
  const trendCard = page.getByText('趋势与结构').locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]');
  await expect(trendCard.getByText('目标 23:30–07:30')).toBeVisible();
  await expect(trendCard.getByText(/\d{2}:\d{2}→\d{2}:\d{2}/).first()).toBeVisible();

  await page.getByRole('button', { name: '得分曲线' }).click();
  const chart = page.getByTestId('score-chart');
  await expect(chart).toBeVisible();
  const axisText = await chart.locator('text').allTextContents();
  expect(axisText).toEqual(expect.arrayContaining(['100', '90', '75', '50']));
  await expect(page.getByText(/均值 \d+/)).toBeVisible();

  await page.getByRole('button', { name: '睡眠分期比例（模型估算，非测量）' }).click();
  await expect(page.getByText('近 7 晚平均')).toBeVisible();
  expect(errors).toEqual([]);
});

// 旅程34 科学建议作息（第 114 轮）：需求+MSFsc → 一键采用，目标/提醒/月历入口同源
test('旅程34 科学建议作息：需求卡一键采用 → 目标落库双入口同源', async ({ page }) => {
  const errors = watchErrors(page);
  // 近 21 晚（恰好 3 个完整周）：睡到自然醒的夜（醒来日=周末）给 02:30→10:30，
  // 工作日 22:50→06:50（全 8h）→ 需求个人化 480（取最近 14 晚中位数）、
  // MSFsc = 自由日睡眠中点 06:30 → 建议 = 01:00–09:00 ≠ 当前 23:30/07:30。
  // ★ 21 而非 12：MSFsc 要求自由日 ≥3——任意 12 晚窗口在周末前后只有 2 个
  //   周末醒来日（2026-11-06 实测挂）；21 个连续醒来日=每个星期几恰好 3 个，
  //   日期鲁棒。注意夜归属：记录 D 的醒来日是 D+1，自由日按 D+1 判。
  const base = new Date();
  base.setHours(21, 0, 0, 0);
  const recs: unknown[] = [];
  for (let i = 1; i <= 21; i++) {
    const wake = new Date(base);
    wake.setDate(wake.getDate() - i + 1);
    const free = wake.getDay() === 0 || wake.getDay() === 6;
    recs.push(mkRecord(dstr(-i, base), free ? '02:30' : '22:50', free ? '10:30' : '06:50', 85));
  }
  await seed(page, recs, NIGHT_SCHEMA);
  await openAt(page, 21, 0);
  await navTo(page, '趋势');

  // 建议按钮出现且带 MSFsc 锚定标注
  const adopt = page.getByRole('button', { name: /按科学建议采用作息/ });
  await expect(adopt).toBeVisible();
  await expect(adopt).toContainText('01:00 – 09:00');
  await expect(adopt).toContainText('MSFsc 锚定');

  // 采用 → 与目标一致 → 按钮消失；档案落库（就寝提醒/深夜救援由既有 watcher 重排）
  await adopt.click();
  await expect(adopt).toHaveCount(0);
  const profile = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_user_profile') || '{}'));
  expect(profile.targetBedtime).toBe('01:00');
  expect(profile.targetWakeTime).toBe('09:00');
  expect(profile.targetDurationHours).toBe(8);

  // 睡眠页作息目标卡：同源建议入口（此时一致 → 不出现），摘要显示新目标
  await navTo(page, '睡眠');
  await expect(page.getByText('01:00 · 8h · 09:00')).toBeVisible();
  expect(errors).toEqual([]);
});

// 旅程36 记录编辑（第 122 轮）：历史行编辑 → 全字段预填 → 幂等保存
//（条数不变、列表/详情同步）；编辑说明在场（分期评分将重算）
test('旅程36 记录编辑：预填全字段 + 幂等保存不产生第二条', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, [mkRecord(dstr(-1), '23:10', '07:10', 92)], NIGHT_SCHEMA);
  await openAt(page, 21, 0);
  await navTo(page, '趋势');

  // 展开历史记录 → 点编辑
  await page.getByRole('button', { name: /历史记录/ }).click();
  await page.getByRole('button', { name: /编辑 2026|编辑 \d{4}-\d{2}-\d{2}/ }).first().click();

  // 编辑模式文案 + 预填（就寝 = 旧值 23:10 而非默认 23:30）
  await expect(page.getByText('编辑记录')).toBeVisible();
  await expect(page.getByText(/编辑将按新时刻重算分期与评分/)).toBeVisible();
  const bedInput = page.locator('input[type="time"]').first();
  await expect(bedInput).toHaveValue('23:10');

  // 改就寝为 22:30 → 保存
  await bedInput.fill('22:30');
  await page.getByRole('button', { name: '保存修改' }).click();

  // 幂等：新时刻在列、旧时刻消失；历史计数徽章仍 1 夜（无第二条）
  await expect(page.getByText('22:30 - 07:10')).toBeVisible();
  await expect(page.getByText('23:10 - 07:10')).toHaveCount(0);
  await expect(page.getByText(/1\s*夜/).first()).toBeVisible();

  // 再次打开补录（非编辑）：标题回"补录睡眠"、默认值回落（editTarget 已清）
  await navTo(page, '睡眠');
  await page.getByRole('button', { name: '手动补录' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});

// 旅程33 睡眠日历交互（第 107 轮重做）：第 106 轮的手绘图零交互，重做后
// react-activity-calendar 点选出当夜详情。锁三条行为链：默认选中最近一夜
//（详情即开即见）、点选切夜详情跟着切、无记录日诚实空态（不冒充 0 分）。
// 第 108 轮追加： sabotaged CSS.supports 模拟冻结版 WebView（不认 color-mix/
// oklab）——第 107 轮真机恶性 bug（库对默认主题做 color-mix 插值再自校验，
// 老 WebView 直接 throw 炸掉趋势分区）在桌面 Chromium 上无法复现，只能靠
// 这种注入模拟；修复后双 scheme 显式满五色，插值路径根本不进。
test('旅程33 睡眠日历：点选日期出当夜详情，无记录日诚实空态', async ({ page }) => {
  const errors = watchErrors(page);
  // 模拟老 WebView：color-mix/oklab 一律"不支持"（先于应用代码执行）
  await page.addInitScript(() => {
    const orig = window.CSS && typeof window.CSS.supports === 'function'
      ? window.CSS.supports.bind(window.CSS)
      : null;
    (window.CSS as any).supports = (...args: unknown[]) => {
      if (args.some((a) => typeof a === 'string' && /color-mix\(|oklab/.test(a))) return false;
      return orig ? orig(...(args as [string])) : false;
    };
  });
  // 三晚记录：92（强）/76（中）/58（弱），再往前留空档给"无记录日"
  await seed(page, [
    mkRecord(dstr(-1), '23:10', '07:10', 92),
    mkRecord(dstr(-2), '23:40', '06:50', 76),
    mkRecord(dstr(-3), '00:20', '08:20', 58),
  ], NIGHT_SCHEMA);

  const base = await openAt(page, 21, 0);
  await navTo(page, '趋势');

  const cal = page.getByTestId('sleep-calendar');
  await expect(cal).toBeVisible();
  await expect(page.getByTestId('rhythm-chart')).toBeVisible();

  const detail = page.getByTestId('calendar-detail');
  // 默认选中最近一夜：详情即开即见。分值会被 v2 口径重算（seed ≠ 展示值），
  // 所以锚定就寝/起床时刻而非分值
  await expect(detail).toContainText('评分');
  await expect(detail).toContainText('就寝 23:10 · 起床 07:10');

  // 一体化（第 113 轮）：点历史行 → 选中夜全局切换，详情/月历同源联动
  await page.getByRole('button', { name: /历史记录/ }).click();
  await page.getByTestId('history-list').getByText(dstr(-2, base)).click();
  await expect(detail).toContainText('就寝 23:40 · 起床 06:50');
  await expect(detail).not.toContainText('就寝 23:10');

  // 月历默认打开在【有数据的那个月】（最近一夜所在月），不是空洞的当前月；
  // 首条记录月即下界。导航可用性按实际月份关系断言（日期滚动鲁棒）：
  // 首夜与最近夜同月 → ‹ 禁用；跨月（如今天 11-03、种子起 10-31）→ ‹ 可用
  const firstD = new Date(base); firstD.setDate(firstD.getDate() - 3);
  const latestD = new Date(base); latestD.setDate(latestD.getDate() - 1);
  const sameMonth = firstD.getMonth() === latestD.getMonth()
    && firstD.getFullYear() === latestD.getFullYear();
  if (sameMonth) {
    await expect(cal.getByRole('button', { name: '上一月' })).toBeDisabled();
  } else {
    await expect(cal.getByRole('button', { name: '上一月' })).toBeEnabled();
  }
  // 下一月：仅当默认视图月不是当前月时可用（最近夜落在当前月 → 已是右界）
  const latestInCurrentMonth = latestD.getMonth() === base.getMonth()
    && latestD.getFullYear() === base.getFullYear();
  if (latestInCurrentMonth) {
    await expect(cal.getByRole('button', { name: '下一月' })).toBeDisabled();
  } else {
    await expect(cal.getByRole('button', { name: '下一月' })).toBeEnabled();
  }

  // 点选前晚 → 详情切换（旧夜的时刻必须消失，不能只是叠加）。
  // ★ 先按 data-view-month 把视图切到目标格所在月（第 135 轮，审查 P0-1）：
  //   每月 1-3 日种子跨月，目标格可能落在相邻月——此前直接点 data-date
  //   假定"目标总在默认视图月里"，冻结 11-01/02/03 确定性失败
  const ensureMonthInView = async (dateKey: string) => {
    const targetMonth = dateKey.slice(0, 7);
    for (let i = 0; i < 3; i++) {
      const current = await cal.getAttribute('data-view-month');
      if (current === targetMonth) return;
      // 月份字符串比较即方向：目标更晚 → 下一月，更早 → 上一月
      await cal.getByRole('button', { name: current! < targetMonth ? '下一月' : '上一月' }).click();
      await page.waitForTimeout(120);
    }
  };
  await ensureMonthInView(dstr(-2, base));
  await cal.locator(`[data-date="${dstr(-2, base)}"]`).click();
  await expect(detail).toContainText('就寝 23:40 · 起床 06:50');
  await expect(detail).not.toContainText('就寝 23:10');

  // 点选无记录日 → 诚实空态。候选从【当前视图月】里现算（读 data-view-month）：
  // 从 28 号往前找第一个不在种子里的日期——任何月份都必然存在（只有 3 条种子）
  const viewMonth = await cal.getAttribute('data-view-month');
  expect(viewMonth).toMatch(/^\d{4}-\d{2}$/);
  const seedKeys = [dstr(-1, base), dstr(-2, base), dstr(-3, base)];
  const [vy, vm] = viewMonth!.split('-').map(Number);
  let missKey = '';
  for (let d = 28; d >= 1; d--) {
    const key = `${viewMonth}-${String(d).padStart(2, '0')}`;
    if (!seedKeys.includes(key)) { missKey = key; break; }
  }
  expect(missKey).not.toBe('');
  await ensureMonthInView(`${vy}-${String(vm).padStart(2, '0')}`);
  await cal.locator(`[data-date="${missKey}"]`).click();
  await expect(detail).toContainText('该日无记录');

  expect(errors).toEqual([]);
});
