import { expect, test } from '@playwright/test';
import {
  dstr,
  mkRecord,
  mkRecordWithStages,
  mockNativeUsage,
  navTo,
  NIGHT_SCHEMA,
  openAt,
  pad,
  seed,
  synthEvents,
  watchErrors,
} from './_journeyHelpers';

// ─────────────────────────────────────────────────────────────
// 旅程 1：晨间核心流（冷启动 → 自动卡 → 确认 → 全下游联动）
// ─────────────────────────────────────────────────────────────
test('旅程1 晨间：07:50 冷启动自动出卡 → 确认 → 趋势/能量/影子全联动', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 自动卡出现且时刻按 15 分钟桶量化
  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const cardText = await page.evaluate(() => document.body.innerText);
  expect(cardText).toMatch(/2[23]:[0-5]\d/);
  expect(cardText).toMatch(/0[67]:[0-2]\d/);
  expect(cardText).toMatch(/放下/);
  expect(cardText).toMatch(/拿起/);

  // 确认 → 小结 → 关闭
  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible();
  await page.getByRole('button', { name: '确定并查看详情' }).click();
  // 首条记录可能攒够旅行能量触发明信片弹窗（两阶段：拆信封 → 收进图鉴）。
  // 真实用户会先拆开再稍后再看——不处理会把后续导航全挡住
  await page.waitForTimeout(400);
  const openEnvelope = page.getByRole('button', { name: /拆开信封/ });
  if (await openEnvelope.count()) {
    await openEnvelope.click();
    const tripLater = page.getByRole('button', { name: /收进图鉴，稍后再看/ });
    await expect(tripLater).toBeVisible();
    await tripLater.click();
  }

  // 落库：date=夜归属（昨天）、来源 usage
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.recordSource === 'usage');
  expect(landed?.date).toBe(dstr(-1, fixed));
  expect(landed?.bedtime).toMatch(/^2[23]:/);

  // 趋势页：昨晚卡与历史列表都出现新记录
  await navTo(page, '趋势');
  await expect(page.getByText(/近 1 晚|近 2 晚|近 3 晚/)).toBeVisible();

  // 旅行能量：countedScores 记入该夜（night 键 = date）
  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || 'null'));
  expect(travel?.countedScores?.[dstr(-1, fixed)]).toBeGreaterThan(0);

  // 影子诊断：该夜已回填 confirmed
  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.outcome?.type).toBe('confirmed');

  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 2：已有记录 / 已处理 / 还在睡 → 都不应乱弹卡
// ─────────────────────────────────────────────────────────────
test('旅程2 晨间反向：已有记录/已忽略/凌晨还在睡 → 均不出卡', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 30, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:05'),
    mkRecord(dstr(-2, fixed), '23:30', '07:00'),
    mkRecord(dstr(-3, fixed), '00:10', '07:10'),
    mkRecord(dstr(-4, fixed), '23:00', '07:20'),
  ], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  // 昨夜的记录已存在 → gate 4 → 无卡
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('旅程3 凌晨：03:30 打开（还在睡）→ 不出卡且页面正常', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(3, 30, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:30', firstActive: '07:30', nightPickups: 0 }],
  });
  await seed(page, [mkRecord(dstr(-2, fixed), '00:20', '07:20')]);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  await expect(page.getByText('该睡了')).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 4：手动补录边界（默认昨晚 / 16h 截断 / 相同时间拦截）
// ─────────────────────────────────────────────────────────────
test('旅程4 手动补录：默认昨晚、16h 截断、相同时间被拦', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 9, 0);
  await seed(page, [mkRecord(dstr(-3, fixed), '23:40', '08:10')]);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await page.getByText('晨起手动补录').click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  // 默认日期 = 昨晚（夜归属键）
  const dateInput = page.locator('input[type="date"]');
  await expect(dateInput).toHaveValue(dstr(-1, fixed));
  // 文案随日期动态，不写死"昨晚"
  await expect(page.getByText('昨晚睡前行为习惯')).toBeVisible();

  const timeInputs = page.locator('input[type="time"]');
  // 相同时间 → 内联错误
  await timeInputs.nth(0).fill('07:30');
  await timeInputs.nth(1).fill('07:30');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('就寝与起床时间不能相同')).toBeVisible();

  // 21.5h 长窗 → 保存成功且记录自洽（分期总和 = 时长 + 清醒）
  await timeInputs.nth(0).fill('23:30');
  await timeInputs.nth(1).fill('21:00');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('补录睡眠')).toHaveCount(0);
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.date === dstr(-1, fixed) && r.recordSource === 'manual');
  expect(landed).toBeTruthy();
  expect(landed.durationMinutes).toBeLessThanOrEqual(960);
  const stageSum = (landed.stages ?? []).reduce((a: number, st: any) => a + st.durationMinutes, 0);
  expect(stageSum).toBe(landed.durationMinutes + landed.awakeMinutes);
  expect(landed.latencyEstimated).toBe(true);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 5：删除记录 → 能量回退 + 影子条目清理
// ─────────────────────────────────────────────────────────────
test('旅程5 删除：旅行能量回退 + 影子诊断条目同步清理', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = await openAt(page, 9, 0);
  await seed(page, [
    mkRecord(dstr(-1, fixed), '23:40', '07:30', 92),
    mkRecord(dstr(-2, fixed), '23:30', '07:00', 85),
  ], {
    ...NIGHT_SCHEMA,
    somnacare_travel_state: JSON.stringify({ currentEnergy: 77, countedScores: { [dstr(-1, fixed)]: 92 }, unlockedCardIds: [], goldStars: {} }),
    somnacare_model_shadow: JSON.stringify({ v: 1, entries: [{ date: dstr(-1, fixed), heuristic: { bed: '23:40', wake: '07:30' }, outcome: { type: 'manual', bed: '23:40', wake: '07:30' } }], dropped: 0 }),
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, '趋势');
  await page.getByRole('button', { name: /历史记录/ }).click();
  // 删除弹出夜间主题 alertdialog 确认框
  await page.getByRole('button', { name: new RegExp(`删除 ${dstr(-1, fixed)}`) }).click();
  const deleteDialog = page.getByRole('alertdialog', { name: '删除睡眠记录' });
  await expect(deleteDialog).toBeVisible({ timeout: 5000 });
  await deleteDialog.getByRole('button', { name: '删除' }).click();
  await expect(deleteDialog).toBeHidden({ timeout: 5000 });
  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || '{}'));
  expect(travel.countedScores?.[dstr(-1, fixed)]).toBeUndefined();
  expect(travel.currentEnergy).toBeLessThan(77);
  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  expect((shadow.entries ?? []).some((e: any) => e.date === dstr(-1, fixed))).toBe(false);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 7b：自动卡"改一下" → 手动补录预填 → 修正后落库（manual 真值）
// ─────────────────────────────────────────────────────────────
test('旅程7b 改一下：卡片预填到补录弹窗 → 修正后以 manual 落库', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  const events = synthEvents(fixed);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  // 只放一晚历史（<3 晚 → 先验缺省，模型可能 prior-mismatch 放行启发式）
  await seed(page, [mkRecord(dstr(-3, fixed), '23:30', '07:00')], NIGHT_SCHEMA);
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  // 卡内断言（第 135 轮，审查 P1-5）：body.innerText 的跨行/跨元素正则会命中
  // 其它分区的"HH:MM 放下"行——收进 wind-down-card 并拆成两条独立断言
  const card = page.getByTestId('wind-down-card');
  await expect(card).toContainText('放下');
  await expect(card).toContainText(/\d{2}:\d{2}/);

  await page.getByRole('button', { name: '改一下' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  // 预填日期 = 夜归属（昨天）；改醒来时间后保存
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(-1, fixed));
  await page.locator('input[type="time"]').nth(1).fill('08:10');
  await page.getByRole('button', { name: /保存记录并更新睡眠趋势/ }).click();
  await expect(page.getByText('补录睡眠')).toHaveCount(0);

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = recs.find((r: any) => r.date === dstr(-1, fixed) && r.recordSource === 'manual');
  expect(landed?.wakeTime).toBe('08:10');
  // 卡片已被处理，不再出现
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 10：±15 分钟微调（B）——卡上直接挪，确认后落库与影子都留痕
// ─────────────────────────────────────────────────────────────
test('旅程10 微调：卡上把起床推迟 15 分钟 → 记录与影子同步', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  const wakeCell = page.getByRole('button', { name: '起床推迟15分钟' }).locator('..');
  const before = (await wakeCell.innerText()).match(/(\d{2}):(\d{2})/);
  expect(before).toBeTruthy();
  const [bh, bm] = [Number(before![1]), Number(before![2])];
  const expected = `${pad(Math.floor(((bh * 60 + bm + 15) % 1440) / 60))}:${pad((bm + 15) % 60)}`;

  await page.getByRole('button', { name: '起床推迟15分钟' }).click();
  await expect.poll(() => wakeCell.innerText()).toContain(expected);

  await page.getByRole('button', { name: /记为这次就寝/ }).click();
  const okBtn = page.getByRole('button', { name: '确定并查看详情' });
  if (await okBtn.count()) await okBtn.click();

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = (recs as any[]).find((r) => r.recordSource === 'usage');
  expect(landed?.wakeTime).toBe(expected);

  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.adjust?.wake).toBe(15);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 11：否定标注（F）——「不是我的睡眠」不写记录，只留负样本
// ─────────────────────────────────────────────────────────────
test('旅程11 否定：点「不是我的睡眠」→ 不落库、负样本与统计可见', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 30, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await page.getByRole('button', { name: '不是我的睡眠' }).click();
  await expect(page.getByText('昨晚的手机使用')).toHaveCount(0);

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  expect((recs as any[]).length).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(dstr(-1, fixed));

  const shadow = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_model_shadow') || '{"entries":[]}'));
  const entry = (shadow.entries ?? []).find((e: any) => e.date === dstr(-1, fixed));
  expect(entry?.negative).toBe(true);

  await navTo(page, '偏好');
  await page.getByRole('button', { name: /数据备份与诊断/ }).click();
  await expect(page.getByText(/否定 1 晚/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 13：时段自适应（G）——早上补昨晚、午后记小睡
// ─────────────────────────────────────────────────────────────
test('旅程13 早上主按钮：09:00「补录昨晚睡眠」→ 预填昨晚与目标时刻', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, []);
  const fixed = await openAt(page, 9, 0);
  await expect(page.getByText('早安')).toBeVisible();
  await page.getByRole('button', { name: '补录昨晚睡眠' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(-1, fixed));
  await expect(page.locator('input[type="time"]').nth(0)).toHaveValue('23:30');
  await expect(page.locator('input[type="time"]').nth(1)).toHaveValue('07:30');
  expect(errors).toEqual([]);
});

test('旅程14 午后主按钮：14:00「记录一次小睡」→ 预填刚才的 40 分钟', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page, []);
  const fixed = await openAt(page, 14, 0);
  await expect(page.getByText('午后小睡')).toBeVisible();
  await page.getByRole('button', { name: '记录一次小睡' }).click();
  await expect(page.getByText('补录睡眠')).toBeVisible();
  await expect(page.locator('input[type="date"]')).toHaveValue(dstr(0, fixed));
  await expect(page.locator('input[type="time"]').nth(0)).toHaveValue('13:20');
  await expect(page.locator('input[type="time"]').nth(1)).toHaveValue('14:00');
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程 17：通知确认（A）——自动档挂通知，动作回来即落库
// ─────────────────────────────────────────────────────────────
test('旅程17 通知确认：通知栏「确认记录」动作 → 无需点卡即完成记录', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(7, 50, 0, 0);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [{ date: dstr(-1, fixed), lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }],
  });
  await seed(page, [], {
    somnacare_user_profile: JSON.stringify({
      name: '测试', age: 30, sleepRecordMode: 'auto', chronotype: 'night',
      targetBedtime: '23:30', targetWakeTime: '07:30', targetDurationHours: 8,
      brightnessLevel: 100, warmthFilter: false, alarms: [], smartAlarmEnabled: true,
      smartWakeWindowMinutes: 20, soundDetectionSensitivity: 'medium',
    }),
  });
  await page.addInitScript(() => {
    const scheduled: any[] = [];
    let cb: ((e: any) => void) | null = null;
    (window as any).__proposalScheduled = scheduled;
    (window as any).__proposalActionReady = false;
    (window as any).__fireProposalAction = (actionId: string, date: string) => {
      cb?.({ actionId, notification: { extra: { proposalDate: date } } });
    };
    (window as any).Capacitor.Plugins.LocalNotifications = {
      checkPermissions: async () => ({ display: 'granted' }),
      requestPermissions: async () => ({ display: 'granted' }),
      registerActionTypes: async () => {},
      addListener: async (_e: string, fn: (e: any) => void) => {
        cb = fn;
        (window as any).__proposalActionReady = true;
        return { remove() {} };
      },
      createChannel: async () => {},
      schedule: async (o: any) => { scheduled.push(...o.notifications); },
      cancel: async () => {},
      getPending: async () => ({ notifications: [] }),
    };
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await expect(page.getByText('昨晚的手机使用')).toBeVisible();
  await page.waitForFunction(() => (window as any).__proposalActionReady === true);
  await page.waitForFunction(() => ((window as any).__proposalScheduled ?? []).length > 0);
  const scheduled = await page.evaluate(() => (window as any).__proposalScheduled);
  expect(scheduled[0]?.actionTypeId).toBe('somnacare-proposal-actions');
  expect(scheduled[0]?.extra?.proposalDate).toBe(dstr(-1, fixed));

  await page.evaluate((d) => (window as any).__fireProposalAction('confirm', d), dstr(-1, fixed));
  await expect(page.getByText(/晨安！恭喜完成睡眠|记录完毕/)).toBeVisible({ timeout: 8000 });
  const okBtn = page.getByRole('button', { name: '确定并查看详情' });
  if (await okBtn.count()) await okBtn.click();

  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  const landed = (recs as any[]).find((r) => r.recordSource === 'usage');
  expect(landed).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('somnacare_proposal_handled'))).toBe(dstr(-1, fixed));
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程20 删除撤销：5 秒内恢复记录与能量账
// ─────────────────────────────────────────────────────────────
test('旅程20 删除撤销：恢复记录 + 能量只补实际扣掉的差额', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(10, 0, 0, 0);
  const date = dstr(-1, fixed);
  await seed(page, [mkRecord(date, '23:40', '07:10', 92)], {
    ...NIGHT_SCHEMA,
    somnacare_travel_state: JSON.stringify({
      currentEnergy: 50, countedScores: { [date]: 98 },
      unlockedCardIds: [], goldStars: {}, pendingArrival: null,
    }),
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  await navTo(page, '趋势');
  await page.getByRole('button', { name: /历史记录/ }).click();
  await page.getByRole('button', { name: new RegExp(`删除 ${date}`) }).click();
  const deleteDialog = page.getByRole('alertdialog', { name: '删除睡眠记录' });
  await expect(deleteDialog).toBeVisible({ timeout: 5000 });
  await deleteDialog.getByRole('button', { name: '删除' }).click();
  await expect(deleteDialog).toBeHidden({ timeout: 5000 });

  await expect(page.getByRole('button', { name: '撤销' })).toBeVisible();
  await page.getByRole('button', { name: '撤销' }).click();

  const travel = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_travel_state') || '{}'));
  expect(travel.countedScores?.[date]).toBe(98);   // 记录经 v2 重打分后的当前分
  expect(travel.currentEnergy).toBe(50);   // 删除时被 max(0) 截断，撤销不能凭空补分
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('somnacare_sleep_records') || '[]'));
  expect((recs as any[]).some((r) => r.date === date)).toBe(true);
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程25 睡前一小时（第 86 轮）：链路 e2e 覆盖——此前零覆盖，mock 缺方法
// 使卡片在全部既有用例中永远不可达
// ─────────────────────────────────────────────────────────────
test('旅程25 睡前一小时：真实应用名渲染 + 总分钟合计 + 放下时刻', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 0, 0, 0);
  const events = synthEvents(fixed);
  // 昨夜 00:47 放下（fixed - 7h13m）
  const windowEnd = fixed.getTime() - (7 * 3600 + 13 * 60) * 1000;
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:47', firstActive: '07:02', nightPickups: 0 }],
    windDown: {
      nightKey: dstr(-1, fixed),   // 夜间作息昨夜键（卡片渲染即证明键取值正确）
      apps: [
        { pkg: 'com.tencent.sgame', label: '王者荣耀', minutes: 25 },
        { pkg: 'com.tencent.mm', label: '微信', minutes: 12 },
      ],
      windowEnd,
    },
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  const card = page.getByTestId('winddown-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('放下手机前的一小时')).toBeVisible();
  // 总分钟 = 25 + 12；放下时刻 = 00:47
  await expect(card.getByText('37')).toBeVisible();
  await expect(card.getByText('分钟还在亮屏')).toBeVisible();
  await expect(card.getByText('00:47 放下')).toBeVisible();
  await expect(card.getByText('王者荣耀')).toBeVisible();
  await expect(card.getByText('微信')).toBeVisible();
  // 37 分钟 < 55 → 不出现"几乎没停过"提示（不造因果断言）
  await expect(card.getByText(/几乎没停过/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// 旅程35 睡债接入睡前一小时（第 115 轮）：个人基线欠债 ≥1h → 量化文案；
// 基线未个人化（零记录）→ 诚实缺省不出现
test('旅程35 睡债睡前建议：个人基线欠债出量化文案', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 0, 0, 0);
  const events = synthEvents(fixed);
  const windowEnd = fixed.getTime() - (7 * 3600 + 13 * 60) * 1000;
  // 7 晚：5 晚 7h + 2 晚 5h → 中位数基线 420 → 睡债 = 2×(420−300) = 240 分钟
  const recs: unknown[] = [];
  for (let i = 1; i <= 7; i++) {
    const dur = i <= 2 ? 300 : 420;
    recs.push({ ...mkRecord(dstr(-i, fixed), '23:00', '07:00', 70), durationMinutes: dur });
  }
  await seed(page, recs, NIGHT_SCHEMA);
  await mockNativeUsage(page, {
    events,
    usageDays: [{ date: dstr(-1, fixed), lastActive: '00:47', firstActive: '07:02', nightPickups: 0 }],
    windDown: { nightKey: dstr(-1, fixed), apps: [
      { pkg: 'com.tencent.mm', label: '微信', minutes: 25 },
      { pkg: 'com.tencent.sgame', label: '王者荣耀', minutes: 12 },
    ], windowEnd },
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  const card = page.getByTestId('winddown-card');
  await expect(card).toBeVisible();
  const debt = card.getByTestId('winddown-debt');
  await expect(debt).toBeVisible();
  await expect(debt).toContainText('睡债');
  await expect(debt).toContainText('提前 30 分钟');
  // 37 分钟 < 55：55 分文案与债文案互不干扰
  await expect(card.getByText(/几乎没停过/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('旅程35b 睡债睡前建议：零记录基线未个人化 → 诚实缺省', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(8, 0, 0, 0);
  await seed(page, [], NIGHT_SCHEMA);
  await mockNativeUsage(page, {
    events: synthEvents(fixed),
    usageDays: [],
    windDown: { nightKey: dstr(-1, fixed), apps: [
      { pkg: 'com.tencent.mm', label: '微信', minutes: 40 },
    ], windowEnd: fixed.getTime() - (7 * 3600 + 13 * 60) * 1000 },
  });
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  const card = page.getByTestId('winddown-card');
  await expect(card).toBeVisible();
  // 无记录 → 基线未个人化 → 债文案绝不出现（不拿默认 8h 编造睡债）
  await expect(card.getByTestId('winddown-debt')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// 旅程37 关怀通知（第 124 轮）：断记召回（missedDays ≥2 → 本周一条）+
// 晨间确认（开监测即排次日 09:00）。LocalNotifications 用注入 stub 捕获
// schedule/cancel 参数——真实调度在真机，这里锁的是【调度语义】。
test('旅程37 关怀通知：断记召回排本周一条 + 晨间确认随开监测落位', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(22, 0, 0, 0);
  // 先建 Capacitor 框架 mock，再覆盖 LocalNotifications 为捕获 stub
  await mockNativeUsage(page, { events: [], usageDays: [] });
  // 注入 LocalNotifications stub：记录 schedule/cancel 调用（在 mockNativeUsage 之后覆盖）
  await page.addInitScript(() => {
    const w = window as any;
    const install = () => {
      if (!w.Capacitor?.Plugins) return;
      w.__notif = [];
      w.__notifCancel = [];
      const impl = {
        checkPermissions: async () => ({ display: 'granted' }),
        getPending: async () => ({ notifications: [] }),
        createChannel: async () => ({}),
        registerActionTypes: async () => ({}),
        schedule: async (args: any) => { w.__notif.push(args); },
        cancel: async (args: any) => { w.__notifCancel.push(args); },
      };
      w.Capacitor.Plugins.LocalNotifications = new Proxy(impl, {
        get: (t, p) => (t as Record<string | symbol, unknown>)[p as string],
      });
    };
    install();
    document.addEventListener('DOMContentLoaded', install);
  });
  // 断记场景：最后一条记录在 5 天前（missedDays=5，hasNights=true）
  await seed(page, [mkRecord(dstr(-5, fixed), '23:00', '07:00', 80)], NIGHT_SCHEMA);
  // 假时钟定在 22:00（晚间相位 → 「开始夜间监测」在位）。此前怀疑 clock
  // 冻结 passive effects 系误判——根因是复用了旧 dev server（reuseExisting
  // Server 遇遗留进程），杀掉后 effects 正常。
  await page.clock.install({ time: fixed });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);

  // 召回已排：本周一条，21:00（10:00 打开 → 今天 21:00），渠道 somnacare-care
  const diag = await page.evaluate(() => ({
    hasCap: !!(window as any).Capacitor,
    hasStub: !!(window as any).Capacitor?.Plugins?.LocalNotifications,
    notifLen: ((window as any).__notif ?? []).length,
    notifs: (window as any).__notif ?? [],
  }));
  const notifs = diag.notifs;
  console.log('[sched]', JSON.stringify(notifs.flatMap((n: any) => n.notifications).map((x: any) => ({ k: x.extra?.kind, id: x.id }))));
  const cancels = await page.evaluate(() => (window as any).__notifCancel ?? []);
  console.log('[cancel]', JSON.stringify(cancels));
  const recalls = notifs.flatMap((n: any) => n.notifications).filter((x: any) => x.extra?.kind === 'recall');
  expect(recalls.length).toBe(1);   // 周键先占位：StrictMode 双调也只排一条
  const recall = recalls[0];
  expect(recall.channelId).toBe('somnacare-care');
  expect(new Date(recall.schedule.at).getHours()).toBe(21);

  // 晨间确认：开一次夜间监测（晚 22:00 场景更贴实际，但 10:00 点按也排——次日 09:00）
  await navTo(page, '睡眠');
  await page.getByRole('button', { name: /开始夜间监测/ }).click();
  await page.waitForTimeout(600);
  const notifs2 = await page.evaluate(() => (window as any).__notif ?? []);
  const morning = notifs2.flatMap((n: any) => n.notifications).find((x: any) => x.extra?.kind === 'morning-confirm');
  expect(morning).toBeTruthy();
  expect(new Date(morning.schedule.at).getHours()).toBe(9);

  expect(errors).toEqual([]);
});
