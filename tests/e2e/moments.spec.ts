import { expect, test, type Page } from '@playwright/test';

/**
 * 朋友圈生成链路（第 42 轮全面核验补缺）：ensureTodayMoment 是"AI 人设"的
 * 核心管线——事实清单生产、LLM 结构化消费、数字白名单拒编造、本地兜底。
 * 此前该管线零 e2e；这里用真实浏览器 + 拦截 LLM 端点锁三件事：
 *  1. 本地兜底：打开朋友圈自动生成，数字来自真实记录、好友纪律在线；
 *  2. LLM 正常路径：结构化 JSON（text/cards/comments）被采用并渲染；
 *  3. LLM 编数字：白名单拒收整条退回本地模板——"她不许自己编数字"的
 *     出处清单承诺必须有牙齿。
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

const seed = async (page: Page, opts: { records: unknown[]; profile?: unknown }) => {
  await page.addInitScript(({ recs, prof }: { recs: string; prof: string }) => {
    localStorage.setItem('somnacare_sleep_records', recs);
    if (prof) localStorage.setItem('somnacare_user_profile', prof);
    localStorage.setItem('somnacare_onboarded_v1', '1');
    sessionStorage.clear();
  }, { recs: JSON.stringify(opts.records), prof: opts.profile ? JSON.stringify(opts.profile) : '' });
};

const openMoments = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: 'AI顾问' }).click();
  await page.getByText('大肥鱼的朋友圈').first().click();
  // overlay 挂载即自动生成（ensureTodayMoment）——"数据来源"条款出现 = 链路活着
  await expect(page.getByText('她不许自己编数字').first()).toBeVisible({ timeout: 15000 });
};

const readStore = (page: Page, key: string): Promise<any> =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);

test('本地兜底：打开朋友圈自动生成，数字真实、好友纪律在线', async ({ page }) => {
  await seed(page, { records: [mkRecord(dstr(0), '00:20', '08:20', 92)] });
  await openMoments(page);
  await page.waitForTimeout(1200);

  // 落库数据纪律：评论 ≤2、好友在册、绝不盗用"本鱼"自称
  const moments = await readStore(page, 'somnacare_pet_moments');
  const today = (moments as any[]).find((m) => !m.postcardId);
  expect(today).toBeTruthy();
  expect(today.text).toContain('92');   // 数字来自真实记录
  expect((today.comments ?? []).length).toBeLessThanOrEqual(2);
  for (const c of today.comments ?? []) {
    expect(['楼下Claude', '美国豆包Gemini', '被压榨的Qwen', '被蒸馏的Kimi', '意难平的豆包姐姐']).toContain(c.friend);
    expect(c.text).not.toContain('本鱼');
  }
  // UI：事实清单（数据来源）可见——出处承诺展示
  await expect(page.getByText('她不许自己编数字').first()).toBeVisible();
});

test('LLM 正常路径：结构化返回被采用并渲染', async ({ page }) => {
  await seed(page, {
    records: [mkRecord(dstr(0), '00:20', '08:20', 92)],
    profile: { aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-chat' } },
  });
  // 数字 8/0/92 均出自事实清单（时长 8 小时 0 分 + 评分 92）——白名单放行
  await page.route('https://api.deepseek.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      text: '昨晚 8 小时 0 分拿下 92 分，哼，算你识相 😊',
      cards: ['data'],
      comments: [{ friend: '楼下Claude', text: '恕我直言，92 分的含金量，明天请继续保持。' }],
    }) } }] }),
  }));
  await openMoments(page);

  // 断言圈进 overlay 的 dialog——偏好页隐藏的"傲娇播报预览"也有相近文案，
  // 不圈范围会撞 hidden 元素（首跑实证）
  const overlay = page.getByRole('dialog', { name: '大肥鱼的朋友圈' });
  await expect(overlay.getByText('算你识相')).toBeVisible({ timeout: 15000 });
  const moments = await readStore(page, 'somnacare_pet_moments');
  const today = (moments as any[]).find((m) => !m.postcardId && String(m.text).includes('算你识相'));
  expect(today?.comments?.[0]?.friend).toBe('楼下Claude');
  expect(today?.cards).toContain('data');
});

test('LLM 编数字：数字白名单拒收整条，回退本地模板', async ({ page }) => {
  await seed(page, {
    records: [mkRecord(dstr(0), '00:20', '08:20', 92)],
    profile: { aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-chat' } },
  });
  // 99 / 3.5 / 88 都不在事实清单（评分 92、时长 8 小时 0 分）——必须整条拒收
  await page.route('https://api.deepseek.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      text: '昨晚 99 分，深睡 3.5 小时，效率 88%，梦游去了月球！',
      cards: ['data'],
      comments: [{ friend: '楼下Claude', text: '恕我直言，99 分的传说我信了。' }],
    }) } }] }),
  }));
  await openMoments(page);

  // 本地模板接管（≥80 分档的"再夸你最后一句"），编造的 99 分绝不出现
  const overlay = page.getByRole('dialog', { name: '大肥鱼的朋友圈' });
  await expect(overlay.getByText(/再夸你最后一句/)).toBeVisible({ timeout: 15000 });
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain('99 分');
  const moments = await readStore(page, 'somnacare_pet_moments');
  const today = (moments as any[]).find((m) => !m.postcardId);
  expect(String(today?.text)).not.toContain('99');
  expect(String(today?.text)).toContain('92');
});
