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

/** 不进朋友圈的普通打开（漫游到指定底栏分区）。 */
const open = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
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
  const usageKinds: string[] = [];
  page.on('console', (msg) => {
    // kind 在 Playwright 的对象预览里会被吞（探针实证），必须用 args 的
    // jsonValue 反序列化拿——同步 text() 拿不到
    if (msg.text().startsWith('[llm usage]') && msg.args()[1]) {
      msg.args()[1].jsonValue()
        .then((obj) => usageKinds.push(String(obj?.kind)))
        .catch(() => { /* 句柄失效忽略 */ });
    }
  });
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
    }) } }], usage: { prompt_tokens: 120, completion_tokens: 40, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 } }),
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
  // 用量对账日志（kind=moments）：四条模型链路全部可归因（第 45 轮用户反馈命中率归因）
  expect(usageKinds).toContain('moments');
});

test('语录时间纪律：缓存里写死钟点的台词被过滤（用户实测回归）', async ({ page }) => {  // 用户实测：23:24 播出"23:30 到了"。缓存 20h 的 LLM 语录里含钟点的台词
  // 必须在显示层被过滤——对已缓存旧语料立即生效
  await seed(page, {
    records: [mkRecord(dstr(0), '00:20', '08:20', 92)],
    // getCachedLlmSay 对非 LLM 档位返回 null（撤 Key 不吃云端缓存）——
    // 测试缓存过滤必须配一个有 Key 的档案
    profile: { aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-chat' } },
  });
  await page.addInitScript(() => {
    localStorage.setItem('somnacare_pet_say_llm', JSON.stringify({
      at: Date.now(),
      lines: [
        '23:30 到了，肥鱼都睡了你还醒着',
        '昨晚你把睡眠记录藏哪了，交出来',
        '100分是空气打的，系统都不好意思',
      ],
    }));
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4200);
  await page.getByRole('navigation', { name: '主标签栏' }).getByRole('button', { name: '偏好' }).click();
  // 预览在 <details> 折叠面板里——innerText 不含折叠内容，先展开再断言
  await page.getByText(/傲娇播报预览/).click();
  await page.waitForTimeout(400);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain('23:30 到了');                       // 钟点台词消失
  expect(text).toContain('昨晚你把睡眠记录藏哪了');               // 干净台词保留
  expect(text).toContain('100分是空气打的');                     // 非钟点台词不受牵连
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

test('评论回复链路：请求体含评论与正文，模型回复直接回应评论（B1 回归）', async ({ page }) => {
  // 第 46 轮 B1 回归：commentMoment 曾把 'reply' 传进 user 位、真提示词
  // 挤进 kind 位——模型收不到评论内容，回复退化为模板腔
  const captured: string[] = [];
  const usageKinds: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('[llm usage]') && msg.args()[1]) {
      msg.args()[1].jsonValue()
        .then((obj) => usageKinds.push(String(obj?.kind)))
        .catch(() => { /* 句柄失效忽略 */ });
    }
  });
  await page.route('https://api.deepseek.com/**', async (route) => {
    const body = route.request().postData() ?? '';
    captured.push(body);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ text: '昨晚 00:20 才放下手机，还问我几点睡？先闭眼！' }) } }],
        usage: { prompt_tokens: 90, completion_tokens: 18, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 40 },
      }),
    });
  });
  await seed(page, {
    records: [mkRecord(dstr(0), '00:20', '08:20', 92)],
    profile: { aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test', deepseekModel: 'deepseek-chat' } },
  });
  await openMoments(page);
  await page.waitForTimeout(800);   // 今日动态自动生成完成

  // 打开评论框 → 发一句评论（选择器圈进 dialog——背后 AI 顾问窗格的入口卡
  // 可访问名也含"评论"，不圈会点到被拦截的底卡）
  const overlay2 = page.getByRole('dialog', { name: '大肥鱼的朋友圈' });
  await overlay2.getByRole('button', { name: '评论' }).first().click();
  await page.getByPlaceholder('和她说点什么……').fill('你昨天几点睡的？');
  await overlay2.getByRole('button', { name: '发送' }).click();

  // 回复直接回应评论内容（mock 文本与请求体断言双证）
  await expect(page.getByText('还问我几点睡').first()).toBeVisible({ timeout: 15000 });
  const commentReq = captured.find((b) => b.includes('你昨天几点睡的？'));
  expect(commentReq).toBeTruthy();                       // B1 回归锚：评论内容必须进请求体
  expect(commentReq).toContain('鱼片的评论');
  expect(commentReq).toContain('事实清单');
  // 对账日志：这条链路的 kind 必须是 'reply'（此前恒为整段提示词）
  await page.waitForTimeout(500);
  expect(usageKinds).toContain('reply');
});
