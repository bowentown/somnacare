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
// 旅程30 评估报告直连云端（第 91 轮）：APK 内没有 server.ts，唯一路径
// `POST /api/sleep/analyze` 必然 404 → 报告此前永远退化成本地规则引擎，
// 与 README"三种引擎自由切换"的承诺不符。这里断言自配 Key 时请求真的
// 打到 api.deepseek.com（短路直连分支即红），且提示词走共用构造器、密钥不进请求体。
// ─────────────────────────────────────────────────────────────
test('旅程30 评估报告直连云端：自配 Key 时真打 DeepSeek（不再永远退化本地规则）', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.clock.install({ time: fixed });
  await seed(page, [mkRecord(dstr(-1, fixed), '23:30', '07:30', 88)], {
    somnacare_record_date_schema: 'night-v1',
    somnacare_user_profile: JSON.stringify({
      name: '评估者', age: 32, targetHours: 8,
      aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-pro' },
    }),
  });

  let analysisHit = 0;
  let sentBody: any = null;
  await page.route('https://api.deepseek.com/**', (route) => {
    if (!(route.request().postData() || '').includes('睡眠医学与昼夜节律专家顾问')) {
      // 非评估请求（桌宠/朋友圈）：本用例不关心，给空内容让它走本地兜底
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    analysisHit++;
    sentBody = route.request().postDataJSON();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        chronotype: '温和中庸型',
        chronotypeDescription: '节律稳定，无需大改。',
        overallHealthGrade: '良好 A',
        scoreSummary: '整体稳定，继续维持。',
        clinicalMetricsAnalysis: {
          durationAssessment: '时长达标。', deepSleepAssessment: '深睡在参考区间。',
          remSleepAssessment: 'REM 正常。', efficiencyAssessment: '效率良好。',
          sleepLatencyAssessment: '潜伏期正常。',
        },
        identifiedIssues: ['睡前屏幕偏多'],
        personalizedRecommendations: [{ timeWindow: '睡前减速期', action: '提前放下手机', detail: '睡前 30 分钟离屏。', impact: '缩短入睡潜伏期' }],
        mindsetAffirmation: '今晚也好好睡。',
      }) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } }),
    });
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, 'AI顾问');
  await page.getByRole('button', { name: /睡眠医学完整评估/ }).click();
  await page.getByRole('button', { name: '生成评估' }).click();

  // 报告真的产出（按钮文案只有 analysis 落定后才变"刷新评估"）
  await expect(page.getByRole('button', { name: '刷新评估' })).toBeVisible({ timeout: 15000 });
  expect(analysisHit).toBe(1);
  // 直连分支真的跑了：来源标签带模型名（初始标签只有"DeepSeek"，无括号）
  await expect(page.getByText(/模型：DeepSeek \(deepseek-pro\)/)).toBeVisible();
  // 模型名与服务端 normalizeDeepSeekModel 同口径（文档推荐名直发）
  expect(sentBody?.model).toBe('deepseek-v4-pro');
  // 提示词走共用构造器（system 段是评估契约）
  expect(String(sentBody?.messages?.[0]?.content)).toContain('睡眠医学与昼夜节律专家顾问');
  expect(sentBody?.response_format?.type).toBe('json_object');
  // 隐私口径（第 33 轮）：密钥绝不进请求体
  expect(JSON.stringify(sentBody)).not.toContain('sk-test');
  await expect(page.getByText(/整体稳定，继续维持/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程31 无 Key 不出网（离线优先边界）：未自配云端 API Key 时不得发起任何
// 云端或 /api/sleep/* 请求，直接由本地临床规则引擎生成报告且来源标签诚实。
// ─────────────────────────────────────────────────────────────
test('旅程31 无 Key：评估完全不出网、直走本地临床规则引擎且标签诚实', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.clock.install({ time: fixed });
  await seed(page, [mkRecord(dstr(-1, fixed), '23:30', '07:30', 88)], {
    somnacare_record_date_schema: 'night-v1',
    somnacare_user_profile: JSON.stringify({ name: '无钥者', age: 30, targetHours: 8 }),
  });

  let cloudHits = 0;
  let serverHits = 0;
  await page.route('https://api.deepseek.com/**', (route) => { cloudHits++; return route.abort(); });
  await page.route('**/api/sleep/**', (route) => { serverHits++; return route.abort(); });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await navTo(page, 'AI顾问');
  await page.getByRole('button', { name: /睡眠医学完整评估/ }).click();
  await page.getByRole('button', { name: '生成评估' }).click();

  await expect(page.getByRole('button', { name: '刷新评估' })).toBeVisible({ timeout: 15000 });
  expect(cloudHits).toBe(0);
  expect(serverHits).toBe(0);
  await expect(page.getByText(/模型：本地临床规则引擎/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 旅程32 缓存命中的来源标签（第 97 轮）：报告缓存此前只存报告、不存来源，
// 12h 内重开命中缓存时标签会退回【初始值】——有 Key 的用户初始值就是
// "DeepSeek"，于是一份服务端降级成规则引擎出的报告会被标成 DeepSeek
// （反向亦然）。这里锁住"来源随报告一起缓存与还原"。
// ─────────────────────────────────────────────────────────────
test('旅程32 报告缓存命中：来源标签随缓存还原（不退回初始值）', async ({ page }) => {
  const errors = watchErrors(page);
  const fixed = new Date();
  fixed.setHours(9, 0, 0, 0);
  await page.clock.install({ time: fixed });
  // 配了 Key → 走直连（第 91 轮）。页面【初始】标签只有 "DeepSeek"（无括号），
  // 直连成功后是 "DeepSeek (deepseek-flash)"——这个差别正好用来验缓存还原。
  await seed(page, [mkRecord(dstr(-1, fixed), '23:30', '07:30', 98)], {
    somnacare_record_date_schema: 'night-v1',
    somnacare_user_profile: JSON.stringify({
      name: '缓存用户', age: 30, targetHours: 8,
      aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-flash' },
    }),
  });

  let analysisHits = 0;
  await page.route('https://api.deepseek.com/**', (route) => {
    if (!(route.request().postData() || '').includes('睡眠医学与昼夜节律专家顾问')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    analysisHits++;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        chronotype: '温和中庸型', chronotypeDescription: '稳定。', overallHealthGrade: '良好 A',
        scoreSummary: '缓存标签测试报告。',
        clinicalMetricsAnalysis: {
          durationAssessment: 'a', deepSleepAssessment: 'b', remSleepAssessment: 'c',
          efficiencyAssessment: 'd', sleepLatencyAssessment: 'e',
        },
        identifiedIssues: ['x'], personalizedRecommendations: [], mindsetAffirmation: 'y',
      }) } }] }),
    });
  });

  const openAi = async () => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4200);
    await navTo(page, 'AI顾问');
    await page.getByRole('button', { name: /睡眠医学完整评估/ }).click();
  };

  // 第一次：真直连 → 标签带上模型名（区别于初始值）
  await openAi();
  await page.getByRole('button', { name: '生成评估' }).click();
  await expect(page.getByText(/缓存标签测试报告/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/模型：DeepSeek \(deepseek-flash\)/)).toBeVisible();
  expect(analysisHits).toBe(1);

  // 第二次：重载后命中 12h 缓存（不再请求）→ 标签必须仍带模型名，
  // 不能退回初始的 "DeepSeek"（那会把直连结果说成来源不明）
  await openAi();
  await page.getByRole('button', { name: '生成评估' }).click();
  await expect(page.getByText(/缓存标签测试报告/)).toBeVisible({ timeout: 15000 });
  expect(analysisHits).toBe(1);                                  // 走缓存，没有第二个请求
  await expect(page.getByText(/模型：DeepSeek \(deepseek-flash\)/)).toBeVisible();
  expect(errors).toEqual([]);
});
