/**
 * README 截图采集（第 136 轮）：以 web 预览（= APK 同一套 WebView 渲染）在
 * 390×844 @2x 下截取五分区 + 关键弹层。界面迭代后 `npx tsx
 * tools/capture-screenshots.mts` 重截即可，输出覆盖 docs/screenshots/。
 *
 * 前置：dev server 已在 :3000（npm run dev）。断言驱动等待（借用 e2e 的
 * 经验：固定 sleep 在负载下会截到骨架屏）。
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const BASE = 'http://localhost:3000';

const pad = (n: number): string => String(n).padStart(2, '0');
const dstr = (off: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const mkRecord = (date: string, bedtime: string, wakeTime: string, score: number) => ({
  id: 'r-' + date, date, bedtime, wakeTime,
  durationMinutes: 450 + (score % 5) * 10, deepSleepMinutes: 92, lightSleepMinutes: 300,
  remSleepMinutes: 68, awakeMinutes: 12, sleepScore: score, sleepEfficiency: 92,
  latencyMinutes: 11, wakeCount: 1,
  stages: [
    { stage: 'awake', startTime: bedtime, endTime: '23:41', durationMinutes: 11 },
    { stage: 'deep', startTime: '23:41', endTime: '01:11', durationMinutes: 90 },
    { stage: 'light', startTime: '01:11', endTime: '03:11', durationMinutes: 120 },
    { stage: 'rem', startTime: '03:11', endTime: '04:11', durationMinutes: 60 },
    { stage: 'light', startTime: '04:11', endTime: wakeTime, durationMinutes: 165 },
  ],
});

const SEED = {
  /** 近 3 周真实感数据：波动 + 一两晚低谷，图表面板都有的看 */
  threeWeeks: JSON.stringify(
    Array.from({ length: 20 }, (_, i) => {
      const off = -(i + 1);
      const wave = 88 - Math.round(Math.sin(i / 3.1) * 14) - (i === 9 ? 21 : 0);
      return mkRecord(dstr(off), off % 3 === 0 ? '23:05' : '23:25', '07:10', Math.max(58, wave));
    }),
  ),
  /** 昨晚留空（自动提议卡要出现）+ 使用信号 mock */
  gapForProposal: JSON.stringify(
    Array.from({ length: 20 }, (_, i) => {
      const off = -(i + 2);
      return mkRecord(dstr(off), '23:20', '07:10', 80 + (i % 4) * 4);
    }),
  ),
};

const NAV = '主标签栏';

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const errors: string[] = [];

  const newPage = async (): Promise<import('playwright').Page> => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
    return page;
  };

  const seedAndGo = async (page: import('playwright').Page, records: string, extra?: Record<string, string>) => {
    await page.addInitScript(({ recs, ex }: { recs: string; ex?: Record<string, string> }) => {
      localStorage.setItem('somnacare_sleep_records', recs);
      localStorage.setItem('somnacare_onboarded_v1', '1');
      localStorage.setItem('somnacare_record_date_schema', 'night-v1');
      for (const [k, v] of Object.entries(ex ?? {})) localStorage.setItem(k, v);
      sessionStorage.clear();
    }, { recs: records, ex: extra });
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4300);   // 开屏播完（splashMinMs+fade，与 e2e 同窗）
  };

  // ── 1. 睡眠分区（主视觉：晨间态——昨晚评分环 + 池塘；时段自适应卡片
  //      用假时钟钉在 08:00，真实晚上跑脚本只会截到"今晚准备入睡"）──
  {
    const page = await newPage();
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);
    await page.clock.install({ time: morning });
    await seedAndGo(page, SEED.threeWeeks);
    await page.getByRole('navigation', { name: NAV }).getByRole('button', { name: '睡眠' }).waitFor();
    await page.screenshot({ path: join(OUT, 'sleep-tab.png') });

    // ── 2. 床头监测（暗色全屏面板）──
    await page.getByRole('button', { name: /床头夜钟伴眠/ }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, 'sleep-monitor.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // ── 3. 助眠音景混音器 ──
    await page.getByRole('button', { name: /助眠音景/ }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, 'sound-mixer.png') });
    await page.keyboard.press('Escape');
    await page.close();
    const ctx = page.context();
    await ctx.close();
  }

  // ── 4. 趋势（月历 + 图表）──
  {
    const page = await newPage();
    await seedAndGo(page, SEED.threeWeeks);
    await page.getByRole('navigation', { name: NAV }).getByRole('button', { name: '趋势' }).click();
    await page.getByTestId('sleep-calendar').waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);   // 吸附动画落定
    await page.screenshot({ path: join(OUT, 'trends-tab.png') });
    await page.close();
    await page.context().close();
  }

  // ── 5. AI 顾问 ──
  {
    const page = await newPage();
    await seedAndGo(page, SEED.threeWeeks);
    await page.getByRole('navigation', { name: NAV }).getByRole('button', { name: 'AI顾问' }).click();
    await page.getByText('大肥鱼的朋友圈').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'ai-tab.png') });
    await page.close();
    await page.context().close();
  }

  // ── 6. 护眼 ──
  {
    const page = await newPage();
    await seedAndGo(page, SEED.threeWeeks);
    await page.getByRole('navigation', { name: NAV }).getByRole('button', { name: '护眼' }).click();
    await page.getByText('护眼滤镜').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'eyecare-tab.png') });
    await page.close();
    await page.context().close();
  }

  // ── 7. 偏好（主题 + 作息）──
  {
    const page = await newPage();
    await seedAndGo(page, SEED.threeWeeks);
    await page.getByRole('navigation', { name: NAV }).getByRole('button', { name: '偏好' }).click();
    await page.getByText('界面主题').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'settings-tab.png') });
    await page.close();
    await page.context().close();
  }

  // ── 8. 自动提议卡（需要原生使用信号 mock + 昨晚留空）──
  {
    const page = await newPage();
    // 晨间窗口假时钟（提议卡只在醒来后的窗口显示，同 e2e 旅程1 口径）
    const fixed = new Date();
    fixed.setHours(7, 50, 0, 0);
    // 15 天亮屏事件（07:05–23:40，确定性伪随机）——模型要有数据才能出卡
    let sr = 42;
    const rnd = (): number => { sr = (sr * 1664525 + 1013904223) % 4294967296; return sr / 4294967296; };
    const day0Ms = new Date(fixed).setHours(0, 0, 0, 0);
    const events: number[] = [];
    for (let d = 15; d >= 1; d--) {
      const base = day0Ms - d * 86400000;
      for (let t = base + 7 * 3600e3 + 5 * 60e3; t < base + 23 * 3600e3 + 40 * 60e3; t += (8 + rnd() * 10) * 60e3) {
        events.push(Math.round(t));
      }
    }
    for (let t = day0Ms + 7 * 3600e3 + 5 * 60e3; t <= fixed.getTime() - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      events.push(Math.round(t));
    }
    // ★ initScript 用【字符串】注入（第 136 轮踩坑）：tsx 会给函数形态的
    //   initScript 注入 esbuild 的 __name 助手——浏览器世界没有它，脚本
    //   在 mock 前就 ReferenceError（e2e 走 Playwright 自己的转译不受影响）
    const initJs = `
      localStorage.setItem('somnacare_sleep_records', '[]');   // 旅程1 配方：零记录 + 纯事件 → 启发式回退出卡
      localStorage.setItem('somnacare_onboarded_v1', '1');
      localStorage.setItem('somnacare_record_date_schema', 'night-v1');
      sessionStorage.clear();
      const stub = new Proxy({}, { get: () => () => Promise.resolve({}) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: new Proxy({}, { get: (t, p) => t[p] ?? stub }) };
      window.CapacitorCustomPlatform = { name: 'android' };
      window.Capacitor.Plugins.UsageSignal = {
        hasPermission: async () => ({ granted: true }),
        queryDailyUsage: async () => ({ days: [{ date: ${JSON.stringify(dstr(-1))}, lastActive: '23:40', firstActive: '07:05', nightPickups: 0 }] }),
        queryScreenOnEvents: async () => ({ events: ${JSON.stringify(events)}, observedUntil: Date.now() }),
        queryWindDownApps: async () => ({ apps: [] }),
      };
    `;
    await page.clock.install({ time: fixed });
    await page.addInitScript(initJs);
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(4300);
    await page.getByText('昨晚的手机使用').waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, 'auto-proposal-card.png') });
    await page.close();
    await page.context().close();
  }

  await browser.close();
  if (errors.length > 0) {
    console.error('页面异常：\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('✓ 截图已更新 docs/screenshots/');
}

main();
