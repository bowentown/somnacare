/**
 * 护栏：SensibleSleep 贝叶斯切换点模型（第 26 轮）。
 *
 * 场景全部来自实施规格书的验收矩阵（§6.2 A/B 组 + §8 追加验证），
 * 用固定种子的泊松模拟器生成屏幕事件（昼夜对比度按论文真数据标定：
 * 清醒 ≈4.6 事件/小时、睡眠 ≈0.046 事件/小时、起夜 = 睡眠段内 1 次亮屏）。
 *
 * 方法论约束：护栏必须能反向验证——错误窗口 / 低对比度数据必须被拒。
 */
import { fileURLToPath } from 'node:url';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;

const { fitSleepModel } = await import(new URL('../src/utils/sleepModel.ts', import.meta.url).href);
const { computeModelProposal } = await import(new URL('../src/utils/proposal.ts', import.meta.url).href);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 固定种子随机源（mulberry32）──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// ── 模拟器：按窗口天生成亮屏事件 ──
const AWAKE_RATE = 4.6;    // 事件/小时（论文真数据标定）
const SLEEP_RATE = 0.046;  // 事件/小时
interface SimOptions {
  wsHour: number;                 // 窗口起点（与模型同公式）
  bedMin: number; wakeMin: number;// 真实作息（时钟分钟）
  now: number;                    // "打开 App"时刻
  mode?: 'normal' | 'allnighter' | 'uniform' | 'sparse';
  pickupTimesMin?: number[];      // 每晚起夜时刻（时钟分钟）
  seed?: number;
  lastNightBedMin?: number;       // 最近一晚（i=0）单独的作息（漂移回归用）
  lastNightWakeMin?: number;
}
function simulateEvents(o: SimOptions): { events: number[]; observedUntil: number } {
  const rng = mulberry32(o.seed ?? 20261003);
  const events: number[] = [];
  const now = o.now;
  const mode = o.mode ?? 'normal';
  // 窗口起点：最近一次本地 ws:00 ≤ now（与模型 recentWindowStart 同公式）
  const nd = new Date(now);
  let ws0 = new Date(nd.getFullYear(), nd.getMonth(), nd.getDate(), o.wsHour, 0, 0, 0).getTime();
  if (ws0 > now) ws0 -= 86400000;
  const N_WINDOWS = 14;
  for (let i = 0; i < N_WINDOWS; i++) {
    const dayStart = ws0 - i * 86400000;
    // 最近一晚（i=0）可单独指定作息——回归第 27 轮 P0（分窗索引反了会拿最老窗当目标）
    const bedFor = i === 0 && o.lastNightBedMin !== undefined ? o.lastNightBedMin : o.bedMin;
    const wakeFor = i === 0 && o.lastNightWakeMin !== undefined ? o.lastNightWakeMin : o.wakeMin;
    const bedBin = Math.round((((bedFor - o.wsHour * 60) % 1440 + 1440) % 1440) / 15);
    const wakeBin = Math.round((((wakeFor - o.wsHour * 60) % 1440 + 1440) % 1440) / 15);
    const ob = Math.max(0, Math.min(96, Math.floor((now - dayStart) / 900000) + 1));
    for (let b = 0; b < ob; b++) {
      let rate: number;
      if (mode === 'uniform') rate = 1.0;
      else if (mode === 'allnighter') rate = AWAKE_RATE;
      else rate = b >= bedBin && b < wakeBin ? SLEEP_RATE : AWAKE_RATE;
      if (mode === 'sparse') rate = 0;
      const c = poisson(rng, rate * 0.25);
      for (let k = 0; k < c; k++) {
        events.push(dayStart + b * 900000 + Math.floor(rng() * 900000));
      }
    }
    if (mode === 'sparse') {
      // 每天 3 次亮屏，落在白天
      for (let k = 0; k < 3; k++) {
        const t = dayStart + (12 + k) * 3600000;
        if (t <= now) events.push(t);
      }
    }
    // 起夜：睡眠段内 1 次亮屏
    for (const t of o.pickupTimesMin ?? []) {
      const pickup = dayStart + ((((t - o.wsHour * 60) % 1440) + 1440) % 1440) * 60000 + Math.floor(rng() * 120000);
      const inSleep = (() => {
        const bin = Math.floor((pickup - dayStart) / 900000);
        return bin >= bedBin && bin < wakeBin;
      })();
      if (inSleep && pickup <= now) events.push(pickup);
    }
  }
  return { events, observedUntil: now };
}

// 时钟工具
function atTime(h: number, m: number): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

// 场景 runner：夜间作息（默认 23:00–07:00，ws=15）
function runNight(opts: Partial<SimOptions> & { now: number }) {
  return fitSleepModel({
    events: simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, ...opts }).events,
    observedUntil: opts.now,
    chronotype: 'night',
    habitBedMin: 23 * 60,
    habitWakeMin: 7 * 60,
    now: opts.now,
  });
}
const ok = (r: ReturnType<typeof fitSleepModel>) => r.status === 'ok' ? r : null;

// ── A 组：应能提议 ──
{
  const now = atTime(7, 0);
  const r = ok(runNight({ now, seed: 11 }));
  check('A1 标准 23:00–07:00：产出提议', r !== null, r ? `Δ=${r.delta} λ比=${r.lambdaRatio.toFixed(0)}` : '');
  check('A1 就寝 ≈ 23:00（±75 分）', r !== null && circularDiff(minutesOf(r.bedtime), 23 * 60) <= 75,
    r?.bedtime);
  check('A1 醒来 ≈ 07:00（±75 分，且绝不定到午后）', r !== null && circularDiff(minutesOf(r.wakeTime), 7 * 60) <= 75 && minutesOf(r.wakeTime) < 12 * 60,
    r?.wakeTime);

  const r2 = ok(runNight({ now: atTime(7, 30), pickupTimesMin: [2 * 60 + 30], seed: 22 }));
  check('A2 每晚 1 次起夜（02:30）：仍提议且就寝 ±90', r2 !== null && circularDiff(minutesOf(r2.bedtime), 23 * 60) <= 90,
    r2 ? `${r2.bedtime}/${r2.wakeTime} 睡中亮屏${r2.sleepEventsInTarget}` : '');

  const r3 = fitSleepModel({
    ...(() => { const s = simulateEvents({ wsHour: 14, bedMin: 22 * 60, wakeMin: 6 * 60, now: atTime(6, 30), seed: 33 }); return { events: s.events, observedUntil: s.observedUntil }; })(),
    chronotype: 'night', habitBedMin: 22 * 60, habitWakeMin: 6 * 60, now: atTime(6, 30),
  });
  check('A3 早鸟 22:00–06:00：±90', r3.status === 'ok' && circularDiff(minutesOf(r3.bedtime), 22 * 60) <= 90 && circularDiff(minutesOf(r3.wakeTime), 6 * 60) <= 75,
    r3.status === 'ok' ? `${r3.bedtime}/${r3.wakeTime}` : r3.reason);

  const r4 = fitSleepModel({
    ...(() => { const s = simulateEvents({ wsHour: 18, bedMin: 2 * 60, wakeMin: 10 * 60, now: atTime(10, 30), seed: 44 }); return { events: s.events, observedUntil: s.observedUntil }; })(),
    chronotype: 'night', habitBedMin: 2 * 60, habitWakeMin: 10 * 60, now: atTime(10, 30),
  });
  check('A4 夜猫 02:00–10:00：就寝 ±120 / 醒来 ±75', r4.status === 'ok' && circularDiff(minutesOf(r4.bedtime), 2 * 60) <= 120 && circularDiff(minutesOf(r4.wakeTime), 10 * 60) <= 75,
    r4.status === 'ok' ? `${r4.bedtime}/${r4.wakeTime}` : r4.reason);

  const r5 = fitSleepModel({
    ...(() => { const s = simulateEvents({ wsHour: 1, bedMin: 9 * 60, wakeMin: 17 * 60, now: atTime(17, 30), seed: 55 }); return { events: s.events, observedUntil: s.observedUntil }; })(),
    chronotype: 'day', habitBedMin: 9 * 60, habitWakeMin: 17 * 60, now: atTime(17, 30),
  });
  check('A5 日间作息 09:00–17:00（ws=1）：±90', r5.status === 'ok' && circularDiff(minutesOf(r5.bedtime), 9 * 60) <= 90 && circularDiff(minutesOf(r5.wakeTime), 17 * 60) <= 75,
    r5.status === 'ok' ? `${r5.bedtime}/${r5.wakeTime}` : r5.reason);

  // 傍晚 / 次日 16:00 打开：目标夜自动落到最近完整窗（提议昨夜）
  const r6 = ok(runNight({ now: atTime(22, 0), seed: 66 }));
  check('A6 傍晚 22:00 打开：提议昨夜', r6 !== null && circularDiff(minutesOf(r6.bedtime), 23 * 60) <= 90,
    r6 ? `${r6.bedtime}/${r6.wakeTime}` : '');
  const r7 = ok(runNight({ now: atTime(16, 0), seed: 77 }));
  check('A7 次日 16:00 打开：提议昨夜', r7 !== null && circularDiff(minutesOf(r7.bedtime), 23 * 60) <= 90,
    r7 ? `${r7.bedtime}/${r7.wakeTime}` : '');

  // A8 作息漂移回归（第 27 轮 P0）：13 晚 23:00–07:00 + 最近一晚 01:30–09:30，
  // 09:30 打开 → 必须提议【最近一晚】。分窗索引反了会把 13 天前那晚当目标（23:00）
  const r8 = ok(runNight({ now: atTime(9, 30), seed: 88, lastNightBedMin: 90, lastNightWakeMin: 570 }));
  check('A8 作息漂移：提议的是最近一晚（01:30），不是历史作息',
    r8 !== null && circularDiff(minutesOf(r8.bedtime), 90) <= 75 && circularDiff(minutesOf(r8.bedtime), 23 * 60) > 75,
    r8 ? `${r8.bedtime}/${r8.wakeTime}` : '');

  // A9 早起早晨回归（第 28 轮，用户实测缺陷）：习惯起床 07:00，最近一晚
  // 05:20 就醒了，05:30 打开 App → 必须提议（旧版"ob ≥ 习惯起床−1h"钟点门
  // 会拒掉 5:30–6:00 的打开且不回退——早晨永远没有卡片）
  const r9 = ok(runNight({ now: atTime(5, 30), seed: 89, lastNightWakeMin: 5 * 60 + 20 }));
  check('A9 早起 05:30 打开：必须提议昨晚',
    r9 !== null && circularDiff(minutesOf(r9.wakeTime), 5 * 60 + 20) <= 60,
    r9 ? `${r9.bedtime}/${r9.wakeTime}` : '');

  // A10 短夜（00:00–05:00，起床偏离中位 2h）：05:30 打开 → 仍要提议
  // （起床侧闸门放宽到 3.5h 的原因——短夜是真实作息，不是拟合错误）
  const r10 = ok(runNight({ now: atTime(5, 30), seed: 90, lastNightBedMin: 0, lastNightWakeMin: 5 * 60 }));
  check('A10 短夜 00:00–05:00：05:30 打开仍提议',
    r10 !== null && circularDiff(minutesOf(r10.bedtime), 0) <= 60 && circularDiff(minutesOf(r10.wakeTime), 5 * 60) <= 60,
    r10 ? `${r10.bedtime}/${r10.wakeTime}` : '');
}

// ── B 组：应拒绝（且不回退旧算法）──
{
  const b1 = runNight({ now: atTime(7, 0), mode: 'allnighter', seed: 101 });
  check('B1 通宵用机 → 拒绝（Δ 闸门）', b1.status === 'rejected', b1.status === 'rejected' ? b1.reason : `误提议 ${JSON.stringify(b1)}`);
  const b2 = runNight({ now: atTime(7, 0), mode: 'uniform', seed: 102 });
  check('B2 全天均匀用机 → 拒绝', b2.status === 'rejected', b2.status === 'rejected' ? b2.reason : '');
  const b3 = runNight({ now: atTime(7, 0), mode: 'sparse', seed: 103 });
  check('B3 极稀疏（每天 3 次）→ 拒绝', b3.status === 'rejected', b3.status === 'rejected' ? b3.reason : '');
  const nowB4 = atTime(7, 0);
  const b4 = fitSleepModel({
    events: [nowB4 - 3600000], observedUntil: nowB4, chronotype: 'night',
    habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: nowB4,
  });
  check('B4 单个事件 → insufficient（允许回退）', b4.status === 'insufficient', b4.status === 'insufficient' ? b4.reason : '');
  // 500 个同一时刻（退化输入）：无论走到哪道闸门，绝不能产出提议
  const t0 = atTime(7, 0) - 86400000;
  const events500: number[] = [];
  for (let i = 0; i < 500; i++) events500.push(t0);
  const r500 = fitSleepModel({
    events: events500,
    observedUntil: atTime(7, 0), chronotype: 'night', habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: atTime(7, 0),
  });
  check('B5 500 个同一时刻（纯退化输入）→ 绝不产出提议', r500.status !== 'ok',
    r500.status === 'rejected' ? r500.reason : r500.status === 'insufficient' ? r500.reason : JSON.stringify(r500).slice(0, 80));
  // 混合形态：13 个正常夜 + 目标夜只有 500 个同刻事件 → 不崩，且若提议则时长必在 [3,14]h
  const normal13 = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now: atTime(7, 0), seed: 106 }).events
    .filter((e) => e < atTime(7, 0) - 86400000 + 900000);   // 剔除目标夜
  const mixed = fitSleepModel({
    events: [...normal13, ...events500],
    observedUntil: atTime(7, 0), chronotype: 'night', habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: atTime(7, 0),
  });
  const mixedDurOk = mixed.status !== 'ok'
    || (() => { const h = (mixed.wakeMs - mixed.bedtimeMs) / 3600000; return h >= 3 && h <= 14; })();
  check('B5b 混合退化输入 → 不崩；若提议则时长必在 [3,14]h', mixedDurOk,
    mixed.status === 'ok' ? `${mixed.bedtime}/${mixed.wakeTime}` : mixed.reason);
  // 数据不足 7 天 → insufficient（回退旧算法）
  const fewNights = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now: atTime(7, 0), seed: 107 });
  // 只保留最近 5 个窗的事件
  const ws0Approx = atTime(7, 0);
  const recent5 = fewNights.events.filter((e) => e >= ws0Approx - 5 * 86400000);
  const b6 = fitSleepModel({
    events: recent5, observedUntil: atTime(7, 0), chronotype: 'night',
    habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: atTime(7, 0),
  });
  check('B6 仅 ~5 天数据 → insufficient（回退旧启发式）', b6.status === 'insufficient', b6.status === 'insufficient' ? b6.reason : JSON.stringify(b6).slice(0, 80));
  const b7 = runNight({ now: atTime(3, 0), seed: 108 });
  check('B7 凌晨 03:00 打开（还在睡）→ 拒绝', b7.status === 'rejected', b7.status === 'rejected' ? b7.reason : JSON.stringify(b7).slice(0, 80));
}

// ── C 组：computeModelProposal 的 gate 链 ──
{
  const sim = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now: atTime(7, 0), seed: 201 });
  const input = {
    events: sim.events, observedUntil: sim.observedUntil,
    chronotype: 'night' as const, records: [], sessionActive: false, handledDate: null as string | null,
    now: new Date(atTime(7, 0)),
  };
  const r1 = computeModelProposal(input);
  check('C1 提议产出且不回退（模型拍板）', r1.proposal !== null && r1.fallbackAllowed === false,
    r1.proposal ? `${r1.proposal.bedtime}/${r1.proposal.wakeTime} ${r1.proposal.confidence}` : 'null');
  const targetDate = r1.proposal?.targetDate ?? '';
  const r2 = computeModelProposal({ ...input, handledDate: targetDate });
  check('C2 该晚已处理 → 不提议', r2.proposal === null && r2.fallbackAllowed === false);
  const r3 = computeModelProposal({
    ...input,
    records: [{ id: 'x', date: targetDate, bedtime: '23:00', wakeTime: '07:00', kind: undefined } as any],
  });
  check('C3 该晚已有夜睡记录 → 不提议（gate 4 只看夜睡）', r3.proposal === null && r3.fallbackAllowed === false);
  const r4 = computeModelProposal({ ...input, sessionActive: true });
  check('C4 会话进行中 → 不提议', r4.proposal === null);
  const r5 = computeModelProposal({ ...input, chronotype: 'irregular' });
  check('C5 不规律作息 → 不提议（gate 0）', r5.proposal === null && r5.fallbackAllowed === false);
}

// ── 反向自检：错误口径必须被抓住 ──
{
  // R1 白天作息喂夜间窗口（chronotype 传错）：绝不能产出"正确的 09:00 提议"
  const sim = simulateEvents({ wsHour: 1, bedMin: 9 * 60, wakeMin: 17 * 60, now: atTime(17, 30), seed: 301 });
  const wrong = fitSleepModel({
    events: sim.events, observedUntil: sim.observedUntil, chronotype: 'night',
    habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: atTime(17, 30),
  });
  const wrongOk = wrong.status === 'ok' && circularDiff(minutesOf(wrong.bedtime), 9 * 60) <= 90;
  check('R1 反向：错误窗口下不得给出正确的日间提议', !wrongOk, wrong.status === 'ok' ? `${wrong.bedtime}/${wrong.wakeTime}` : wrong.reason);
  // R2 低对比度（睡眠期 1.0 事件/小时，与清醒只差 4.6 倍）→ 必须拒绝
  const rngR2 = mulberry32(302);
  const evR2: number[] = [];
  const ws0R2 = (() => { const d = new Date(atTime(7, 0)); let w = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 0, 0, 0).getTime(); if (w > atTime(7, 0)) w -= 86400000; return w; })();
  for (let i = 0; i < 14; i++) {
    const dayStart = ws0R2 - i * 86400000;
    for (let b = 0; b < 96; b++) {
      const inSleep = b >= 32 && b < 64;
      const c = poisson(rngR2, (inSleep ? 1.0 : 4.6) * 0.25);
      for (let k = 0; k < c; k++) evR2.push(dayStart + b * 900000 + Math.floor(rngR2() * 900000));
    }
  }
  const weak = fitSleepModel({
    events: evR2, observedUntil: atTime(7, 0), chronotype: 'night',
    habitBedMin: 23 * 60, habitWakeMin: 7 * 60, now: atTime(7, 0),
  });
  check('R2 反向：低对比度数据（λ 比不足）→ 拒绝', weak.status === 'rejected', weak.status === 'rejected' ? weak.reason : JSON.stringify(weak).slice(0, 80));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——SensibleSleep 模型与规格书口径不符`);
  process.exit(1);
}
console.log('\n✓ verify-sleep-model：A/B/C 组场景 + 反向自检全部符合');
