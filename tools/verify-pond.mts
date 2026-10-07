/**
 * 活的海 · 池塘引擎护栏（第一期横幅）。
 *
 * 锁四类不变量（逻辑级，无 DOM）：
 *  ① 确定性：同 seed 同参数 → 鱼群轨迹逐位一致（护栏可回归的前提）；
 *  ② 脊柱与边界：节间距恒定、长时间推进不出画布、无 NaN；
 *  ③ 行为：自由巡游有位移、点水聚鱼收得拢、涟漪会生灭、萤火池向目标数缓动；
 *  ④ 数据映射 pondDataFromRecords：睡眠债/萤火/星点三个槽位的口径
 *     （nap 不算夜、记录日期=醒来日、无记录中性债 0.4、萤火随评分×深睡）。
 */
import {
  attractPond, createPondState, pondDataFromRecords, stepPond,
} from '../src/utils/pond';
import { SleepRecord } from '../src/types/sleep';

let pass = 0;
const ok = (cond: boolean, name: string): void => {
  if (!cond) {
    console.error(`✗ ${name}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`✓ ${name}`);
  }
};

const mkNight = (date: string, over: Partial<SleepRecord> = {}): SleepRecord => ({
  id: 'r-' + date,
  date,
  bedtime: '23:00',
  wakeTime: '07:00',
  durationMinutes: 480,
  deepSleepMinutes: 96,
  lightSleepMinutes: 300,
  remSleepMinutes: 70,
  awakeMinutes: 14,
  sleepScore: 86,
  sleepEfficiency: 91,
  latencyMinutes: 12,
  wakeCount: 1,
  wakingMood: 'neutral',
  preSleepHabits: [],
  ...over,
});

const W = 480, H = 140;
const P = { debt: 0.3, fireflies: 12, stars: 5 };

// ① 确定性
const a = createPondState(W, H, 777);
const b = createPondState(W, H, 777);
for (let i = 0; i < 300; i++) stepPond(a, 1 / 60, P);
for (let i = 0; i < 300; i++) stepPond(b, 1 / 60, P);
ok(Math.abs(a.fish[0].spine[0].x - b.fish[0].spine[0].x) < 1e-9
  && Math.abs(a.fish[0].spine[0].y - b.fish[0].spine[0].y) < 1e-9, '确定性：同 seed 同轨迹');

// ② 构成与脊柱
ok(a.fish.length === 5 && a.fish.filter(f => f.isHero).length === 1, '构成：1 主角锦鲤 + 4 小鱼');
const chainOk = a.fish.every(f => f.spine.every((node, i) =>
  i === 0 || Math.abs(Math.hypot(node.x - f.spine[i - 1].x, node.y - f.spine[i - 1].y) - f.segLen) < 0.01));
ok(chainOk, '脊柱：节间距恒等于 segLen');

// ② 位移与长时包含
const c = createPondState(W, H, 42);
const hx0 = c.fish[0].spine[0].x, hy0 = c.fish[0].spine[0].y;
let contained = true, finite = true;
for (let i = 0; i < 1200; i++) {
  stepPond(c, 1 / 60, P);
  for (const f of c.fish) for (const node of f.spine) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) finite = false;
    if (node.x < -6 || node.x > W + 6 || node.y < -6 || node.y > H + 6) contained = false;
  }
}
ok(Math.hypot(c.fish[0].spine[0].x - hx0, c.fish[0].spine[0].y - hy0) > 20, '行为：自由巡游有位移');
ok(contained, '边界：1200 步（20s）鱼身不出画布');
ok(finite, '健壮：长时推进无 NaN/Inf');

// ③ 聚鱼
const d = createPondState(W, H, 9);
const target = { x: W * 0.72, y: H / 2 };
attractPond(d, target.x, target.y);
ok(d.ripples.length === 2 && d.attractT > 5, '涟漪：点水生成两圈 + 吸引计时启动');
for (let i = 0, minD = 1e9; i <= 480; i++) {
  stepPond(d, 1 / 60, P);
  minD = Math.min(minD, Math.hypot(d.fish[0].spine[0].x - target.x, d.fish[0].spine[0].y - target.y));
  if (i === 480) ok(minD < 50, '聚鱼：吸引窗口内主角游到点水处（8s 内最短距离 < 50px）');
}
ok(d.ripples.length === 0, '涟漪：约 1s 后自然消散');

// ③ 萤火池缓动
const e = createPondState(W, H, 5);
const hi = { debt: 0.3, fireflies: 24, stars: 3 };
for (let i = 0; i < 420; i++) stepPond(e, 1 / 60, hi);
ok(e.flies.filter(f => f.alive).length >= 18, '萤火：向高目标数爬升');
const lo = { debt: 0.3, fireflies: 0, stars: 3 };
for (let i = 0; i < 420; i++) stepPond(e, 1 / 60, lo);
ok(e.flies.filter(f => f.alive).length <= 2, '萤火：目标归零后熄灭');

// ④ 数据映射
const today = new Date();
const key = (off: number): string => {
  const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - off);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const empty = pondDataFromRecords([], { targetDurationHours: 8 }, today);
ok(empty.stars === 0 && empty.fireflies === 0 && Math.abs(empty.debt - 0.4) < 1e-9 && empty.caption.length > 0,
  '映射：无记录 → 中性债 0.4 + 零萤火 + 零星点');

const full7 = Array.from({ length: 7 }, (_, i) => mkNight(key(i)));
const full = pondDataFromRecords(full7, { targetDurationHours: 8 }, today);
ok(Math.abs(full.debt) < 0.02, '映射：整 7 夜睡满 8h → 债 ≈ 0');

const short7 = full7.map(r => ({ ...r, durationMinutes: 360 }));
ok(Math.abs(pondDataFromRecords(short7, { targetDurationHours: 8 }, today).debt - 0.25) < 0.01,
  '映射：均睡 6h/目标 8h → 债 = 0.25');

const deepNight = full7.map((r, i) => i === 0
  ? { ...r, sleepScore: 88, deepSleepMinutes: 150 }
  : r);
const bright = pondDataFromRecords(deepNight, { targetDurationHours: 8 }, today);
ok(bright.fireflies >= 14, '映射：昨晚 88 分 + 31% 深睡 → 萤火 ≥ 14');

const dullNight = full7.map((r, i) => i === 0
  ? { ...r, sleepScore: 55, deepSleepMinutes: 45 }
  : r);
ok(pondDataFromRecords(dullNight, { targetDurationHours: 8 }, today).fireflies <= 10,
  '映射：55 分 + 9% 深睡 → 萤火 ≤ 10');

const napOnly = [mkNight(key(0), { kind: 'nap' as const })];
const napView = pondDataFromRecords(napOnly, { targetDurationHours: 8 }, today);
ok(napView.stars === 0 && napView.fireflies === 0, '映射：小睡不算夜（与 petContext 同口径）');

console.log(`\npond 护栏：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
