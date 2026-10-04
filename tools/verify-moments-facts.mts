/**
 * 护栏：朋友圈事实串的生产/消费字符串契约（第 29 轮）。
 *
 * buildSleepFacts（petMoments.ts）产出的事实串，被 MomentsOverlay 的正则
 * 解析成战报卡片数字——跨文件字符串契约，此前已断过一次（正则恒 null →
 * 恒显 0/7）且修复时没留测试。本护栏把两端对起来测。
 *
 * 关键纪律：消费端正则【从 MomentsOverlay.tsx 源码提取】，不手抄——
 * 否则护栏里抄一份、组件里改一份，护栏照样绿。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;

const { buildSleepFacts } = await import(new URL('../src/utils/petMoments.ts', import.meta.url).href);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1) 从消费端源码提取全部 f.match(/.../) 正则 ──
const overlaySrc = readFileSync(new URL('../src/components/MomentsOverlay.tsx', import.meta.url), 'utf8');
const consumerRegexes: RegExp[] = [];
for (const m of overlaySrc.matchAll(/f\.match\((\/.+?\/[a-z]*)\)/g)) {
  const lastSlash = m[1].lastIndexOf('/');
  consumerRegexes.push(new RegExp(m[1].slice(1, lastSlash), m[1].slice(lastSlash + 1)));
}
check('消费端正则提取：至少 2 条（周口径 ×2 + 旧格式回退）', consumerRegexes.length >= 3,
  `提取到 ${consumerRegexes.length} 条`);

// ── 2) 固定输入：2026-10-04（周日）→ 本周已过 7 夜（09-28 周一起）──
const mk = (date: string, score: number) =>
  ({ id: 'r-' + date, date, bedtime: '23:10', wakeTime: '07:10', durationMinutes: 470, deepSleepMinutes: 95, lightSleepMinutes: 300, remSleepMinutes: 75, awakeMinutes: 10, sleepScore: score, sleepEfficiency: 92, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [] });
const fixtureRecords = [
  mk('2026-10-04', 60),    // 本周，不达标
  mk('2026-10-03', 100),   // 本周，达标
  mk('2026-09-25', 90),    // 上周 → 必须被周窗排除
] as any[];
const now = new Date(2026, 9, 4, 15, 8);   // 2026-10-04 周日
const facts = buildSleepFacts(fixtureRecords, { targetBedtime: '23:30' } as any, now);

const weekElapsed = facts.find((f: string) => f.includes('本周已过'));
const weekRec = facts.find((f: string) => f.includes('本周有记录'));
check('生产者：产出两条本周 fact', !!weekElapsed && !!weekRec,
  JSON.stringify([weekElapsed, weekRec]));
check('事实数值正确：已过 7 天、达标 1 天、有记录 2 天、未记录 5 天（上周记录被排除）',
  weekElapsed === '本周已过 7 天，达标 1 天' && weekRec === '本周有记录 2 天，未记录 5 天',
  JSON.stringify([weekElapsed, weekRec]));

// ── 3) 消费端正则必须能解析出正确数字 ──
let parsedGood: string | null = null;
let parsedRec: string | null = null;
let parsedMissed: string | null = null;
for (const re of consumerRegexes) {
  const m1 = (weekElapsed ?? '').match(re);
  if (m1 && m1.length >= 3) { parsedGood = m1[2]; }
  const m2 = (weekRec ?? '').match(re);
  if (m2 && m2.length >= 3) { parsedRec = m2[1]; parsedMissed = m2[2]; }
}
check('消费端：达标数解析 = 1', parsedGood === '1', String(parsedGood));
check('消费端：有记录数解析 = 2', parsedRec === '2', String(parsedRec));
check('消费端：未记录数解析 = 5', parsedMissed === '5', String(parsedMissed));

// ── 4) 反向：文案漂移一字 → 所有消费端正则必须失配（护栏要能抓住） ──
const drifted = (weekElapsed ?? '').replace('本周已过', '本周经过了');
const driftedCaught = consumerRegexes.every((re) => !drifted.match(re));
check('反向：fact 文案漂移 → 消费端正则全部失配（可被抓住）', driftedCaught);

if (failures > 0) {
  console.error(`\n${failures} 项失败——朋友圈事实串生产/消费契约断裂`);
  process.exit(1);
}
console.log('\n✓ verify-moments-facts：事实串生产/消费契约成立（含反向漂移检测）');
