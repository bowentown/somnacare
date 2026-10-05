/**
 * SensibleSleep 贝叶斯切换点模型（TS 实现，第 26 轮）。
 *
 * 论文：Cuttone A, Bækgaard P, Sekara V, Jonsson H, Larsen JE, Lehmann S.
 * "SensibleSleep: A Bayesian Model for Learning Sleep Patterns from Smartphone Events."
 * PLOS ONE 12(1): e0169901 (2017). doi:10.1371/journal.pone.0169901
 *
 * 与旧启发式（"固定窗内最后一次熄屏 = 放下"）的本质区别：
 *   阈值规则问"这次亮屏算不算醒来"，模型问"这段空白更像睡着还是醒着"——
 *   只看事件【次数密度】，刻意丢弃单次时长（论文：事件时长中位 ≈26.5s，无信息量）。
 *
 * 实现要点（实施规格书 §2-§5，全部照做）：
 *   - 96 个 15 分钟桶；窗口起点随作息/习惯移动（§4.1，论文固定 16:00 装不下日间作息）
 *   - λ_sleep/λ_awake 跨天共享（每天独立会让对比度塌掉，论文原文）
 *   - Gamma–Poisson 共轭把 λ 解析积掉 → 精确边缘似然，无需 MCMC（§2.3）
 *   - 前缀和 O(1) 评估候选切换点 + 逐日坐标上升（§2.4）
 *   - 每次拟合必须传 observed_until，未观测桶从似然中剔除（§4.3——
 *     否则早上打开 App 会把睡眠段拖到窗口末端，误差 500 分钟级）
 *   - 输出闸门：Δ≥100 / 时长 [3,14]h / 偏离本人中位 ≤2.5h / 首末窗规则（§5）
 *   - 不实现 IQR 硬闸门（§5.6 实测误杀真人作息）
 *
 * 模型在结构上永远会输出一个睡眠段——所以【输出必须过闸门】，
 * rejected 与 insufficient 严格区分：前者不回退旧算法（旧算法会乱报），
 * 后者（数据不足跑不了模型）才允许回退。
 */

// ── 参数表（实施规格书 §3，照抄不改）──
export const BINS = 96;               // 15 分钟 × 96 = 24h
const BIN_MS = 15 * 60 * 1000;
const A_W = 2.5;                      // λ_awake ~ Gamma(2.5, 1)（论文：mean = var = 2.5）
const B_W = 1.0;
const BETA_S = 20.0;                  // λ_sleep ~ Exp(20)（论文 "very large"）
const SIGMA_PASS1 = 16;               // 第一遍宽先验（4 小时）
const SIGMA_PASS2 = 4;                // 第二遍收紧（1 小时）
const FIT_DAYS = 14;                  // 只用最近 14 天（天数越多先验越被淹没）
const MIN_ACTIVE_DAYS = 7;            // 首尾窗会被排除，需留够中间夜
const MIN_EVENTS = 30;                // 事件总数下限
const TARGET_MIN_EVENTS = 3;          // 目标夜至少要有亮屏（整机没用 → 不编数字）
const DELTA_MIN = 100;                // 两态 vs 单态对数似然比下限
const LAMBDA_RATIO_MIN = 8;           // 学不出对比度 = 屏幕数据不足以支撑结论
const NIGHT_MIN_BINS = 12;            // 逐夜时长 ∈ [3h, 14h]
const NIGHT_MAX_BINS = 56;
const NIGHT_DEV_BINS = 10;            // 逐夜就寝偏离本人中位 ≤ 2.5h（就寝信号弱，紧）
const NIGHT_WAKE_DEV_BINS = 12;       // 逐夜起床偏离本人中位 ≤ 3.0h（起床信号强；
                                      // 3.5h 实测会让 03:30 打开误出"截断到此刻"的卡——§28.1.4）
const RECENTRE_MAX_BINS = 12;         // 中位数重估偏离先验 > 3h = 作息可疑（防自我强化）
const MAX_ITERS = 12;

export interface SleepModelInput {
  /** 亮屏事件 epoch ms（只数次数；时长在事件层就丢弃） */
  events: number[];
  /** 观测截止 epoch（= 查询时刻；未观测桶从似然中剔除，绝不当 0 事件） */
  observedUntil: number;
  chronotype: 'night' | 'day';
  /** 先验中心：用户确认记录的中位数（分钟数 0-1439）；缺省用作息类型默认值 */
  habitBedMin?: number;
  habitWakeMin?: number;
  now: number;
}

export type SleepModelOutcome =
  | {
      status: 'ok';
      bedtime: string;
      wakeTime: string;
      bedtimeMs: number;
      wakeMs: number;
      windowStartMs: number;
      targetDate: string;
      delta: number;
      lambdaAwake: number;
      lambdaSleep: number;
      lambdaRatio: number;
      /** 目标夜睡眠段内的亮屏次数（真·睡眠中亮屏，可直接展示） */
      sleepEventsInTarget: number;
      nightsFitted: number;
    }
  | { status: 'insufficient'; reason: string }   // 数据不足，允许回退旧启发式
  | {
      status: 'rejected';                        // 闸门拒绝（是否回退按 code 分流，见 proposal 层）
      reason: string;
      /** 第 42 轮：拒绝原因分类。prior-mismatch = 先验猜错（晚睡作息/记录不足），
       *  不是"没睡"的证据——证据仍在事件里，proposal 层对它放行启发式回退；
       *  其余三类是"证据本身不支持存在睡眠"，回退会复活"把没睡报成睡了"。 */
      code: 'prior-mismatch' | 'low-contrast' | 'low-delta' | 'no-trustworthy-sleep';
    };

interface DayData {
  counts: number[];
  ob: number;                       // 该窗已观测桶数
  totalK: number;
  totalS: number;
  Kp: number[];                     // 前缀计数（不含端点）
  Sp: number[];                     // 前缀 Σ ln(k!)
}

/** Lanczos 逼近的 lnΓ（9 系数，g=7）——双精度下足够本模型使用 */
const LG_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = LG_C[0];
  for (let i = 1; i < 9; i++) x += LG_C[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Gamma(α,β) 先验 + 泊松计数的边缘对数似然（λ 已解析积掉；n=0 视为无信息） */
function marginalLogP(K: number, n: number, S: number, alpha: number, beta: number): number {
  if (n <= 0) return 0;
  return alpha * Math.log(beta) + lgamma(alpha + K) - lgamma(alpha) - (alpha + K) * Math.log(beta + n) - S;
}

/** 窗口起点（小时）：习惯睡眠中点 − 12h，让睡眠居中（§4.1） */
function windowStartHour(chronotype: 'night' | 'day', bedMin?: number, wakeMin?: number): number {
  if (bedMin !== undefined && wakeMin !== undefined) {
    const mid = wakeMin < bedMin
      ? ((bedMin + wakeMin + 1440) / 2) % 1440
      : ((bedMin + wakeMin) / 2) % 1440;
    return Math.floor(((mid - 720 + 1440) % 1440) / 60);
  }
  return chronotype === 'day' ? 1 : 15;   // 无习惯：night→15（论文取 16，接近）、day→1
}

/** 模型窗口起点（本地 ws 点整）：proposal 层的拟合缓存键需要它——
 *  now 跨过窗口边界时 events/observedUntil 可能都没变，但窗口平移了一天 */
export function modelWindowStart(now: number, chronotype: 'night' | 'day', habitBedMin?: number, habitWakeMin?: number): number {
  return recentWindowStart(now, windowStartHour(chronotype, habitBedMin, habitWakeMin));
}

/** 最近一次「本地 ws 点整」≤ now 的时刻 */
function recentWindowStart(now: number, wsHour: number): number {
  const d = new Date(now);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), wsHour, 0, 0, 0).getTime();
  return candidate <= now ? candidate : candidate - 86400000;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function clockStr(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dateStr(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function median3(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function fitSleepModel(input: SleepModelInput): SleepModelOutcome {
  const { events, observedUntil, chronotype, now } = input;

  // ── 1) 分窗分桶：只数亮屏次数，时长刻意丢弃 ──
  const wsHour = windowStartHour(chronotype, input.habitBedMin, input.habitWakeMin);
  const windowStart0 = recentWindowStart(now, wsHour);
  // 逐日锚点按精确 24h 回推，不处理 DST——中国时区无夏令时；跨 DST 地区
  // 历史窗的本地起点会漂移 ±1h（模型分层 σ=1h 会放大为该夜被闸门排除）
  const spanStart = windowStart0 - (FIT_DAYS - 1) * 86400000;

  const days: DayData[] = [];
  for (let i = 0; i < FIT_DAYS; i++) {
    const counts = new Array<number>(BINS).fill(0);
    days.push({ counts, ob: BINS, totalK: 0, totalS: 0, Kp: [], Sp: [] });
  }
  for (const e of events) {
    if (!(e >= spanStart && e <= observedUntil)) continue;
    const idx = Math.floor((e - windowStart0) / 86400000);           // 当前窗=0，往前递减（e ≥ spanStart ⇒ idx ∈ [-(FIT_DAYS-1), 0]）
    const di = -idx;                                                  // ★ 0 = 当前窗——下游 ob0/target 都按此约定
    if (di < 0 || di >= FIT_DAYS) continue;
    const dayStart = windowStart0 - di * 86400000;
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor((e - dayStart) / BIN_MS)));
    days[di].counts[bin] += 1;
  }
  // 观测截止：当前窗只统计到 observedUntil 为止的桶
  const ob0 = Math.max(0, Math.min(BINS, Math.floor((observedUntil - windowStart0) / BIN_MS) + 1));
  days[0].ob = ob0;

  // ln(k!) 表（懒建到最大计数）
  let lnFact: number[] = [0];
  const ensureLnFact = (maxK: number) => {
    for (let k = lnFact.length; k <= maxK; k++) lnFact[k] = lnFact[k - 1] + Math.log(k);
  };
  ensureLnFact(Math.max(0, ...days.flatMap((d) => d.counts)));
  for (const d of days) {
    d.Kp = new Array<number>(BINS + 1).fill(0);
    d.Sp = new Array<number>(BINS + 1).fill(0);
    for (let b = 0; b < BINS; b++) {
      d.Kp[b + 1] = d.Kp[b] + d.counts[b];
      d.Sp[b + 1] = d.Sp[b] + (d.counts[b] > 0 ? lnFact[d.counts[b]] : 0);
    }
    d.totalK = d.Kp[d.ob];
    d.totalS = d.Sp[d.ob];
  }

  // 活跃窗：至少有 1 个事件（0 事件窗多为"未安装/未观测"，从似然中剔除）
  const activeIdx: number[] = [];
  for (let i = 0; i < FIT_DAYS; i++) {
    if (days[i].totalK > 0 && days[i].ob > 0) activeIdx.push(i);
  }
  const activeDays = activeIdx.map((i) => days[i]);

  // ── 2) 数据量闸门（不足 → 允许回退旧启发式）──
  const totalEvents = days.reduce((a, d) => a + d.totalK, 0);
  if (activeDays.length < MIN_ACTIVE_DAYS) {
    return { status: 'insufficient', reason: `活跃窗不足（${activeDays.length}/${MIN_ACTIVE_DAYS}）` };
  }
  if (totalEvents < MIN_EVENTS) {
    return { status: 'insufficient', reason: `事件过少（${totalEvents}/${MIN_EVENTS}）` };
  }

  // 先验中心（桶号）：习惯就寝/起床相对窗口起点
  const wsMin = wsHour * 60;
  const bedMin = input.habitBedMin ?? (chronotype === 'day' ? 9 * 60 : 23 * 60 + 30);
  const wakeMin = input.habitWakeMin ?? (chronotype === 'day' ? 17 * 60 : 7 * 60);
  const cb0 = Math.round((((bedMin - wsMin) % 1440 + 1440) % 1440) / 15);
  const cw0 = Math.round((((wakeMin - wsMin) % 1440 + 1440) % 1440) / 15);

  // ── 3) 坐标上升（前缀和 O(1) 评估候选）──
  type Assign = { ts: number; ta: number };
  const assigns: Assign[] = activeDays.map((d) => ({
    ts: Math.min(cb0, d.ob - 1),
    ta: Math.min(Math.max(cw0, cb0 + 1), d.ob),
  }));

  const globalStats = () => {
    let K1 = 0, S1 = 0, n1 = 0, K2 = 0, S2 = 0, n2 = 0;
    for (let i = 0; i < activeDays.length; i++) {
      const d = activeDays[i];
      const { ts, ta } = assigns[i];
      const k1 = d.Kp[ta] - d.Kp[ts];
      const s1 = d.Sp[ta] - d.Sp[ts];
      K1 += k1; S1 += s1; n1 += ta - ts;
      K2 += d.totalK - k1; S2 += d.totalS - s1; n2 += d.ob - (ta - ts);
    }
    return { K1, S1, n1, K2, S2, n2 };
  };

  const runPass = (sigma: number, cb: number, cw: number): void => {
    // 以当前 assigns 为起点重跑（首遍由先验中心初始化）
    for (let it = 0; it < MAX_ITERS; it++) {
      let changed = 0;
      for (let i = 0; i < activeDays.length; i++) {
        const d = activeDays[i];
        // 摘出本天贡献
        const { ts: pts, ta: pta } = assigns[i];
        const pk1 = d.Kp[pta] - d.Kp[pts];
        const ps1 = d.Sp[pta] - d.Sp[pts];
        let g = globalStats();
        g = {
          K1: g.K1 - pk1, S1: g.S1 - ps1, n1: g.n1 - (pta - pts),
          K2: g.K2 - (d.totalK - pk1), S2: g.S2 - (d.totalS - ps1), n2: g.n2 - (d.ob - (pta - pts)),
        };
        // 枚举本天候选
        let bestLL = -Infinity;
        let best: Assign = assigns[i];
        for (let ts = 0; ts < d.ob; ts++) {
          const Kts = d.Kp[ts], Sts = d.Sp[ts];
          const priorTs = -0.5 * ((ts - cb) / sigma) ** 2;
          for (let ta = ts + 1; ta <= d.ob; ta++) {
            const k1 = d.Kp[ta] - Kts;
            const s1 = d.Sp[ta] - Sts;
            const n1 = ta - ts;
            const ll =
              marginalLogP(g.K1 + k1, g.n1 + n1, g.S1 + s1, 1.0, BETA_S) +
              marginalLogP(g.K2 + (d.totalK - k1), g.n2 + (d.ob - n1), g.S2 + (d.totalS - s1), A_W, B_W) +
              priorTs - 0.5 * ((ta - cw) / sigma) ** 2;
            if (ll > bestLL) { bestLL = ll; best = { ts, ta }; }
          }
        }
        if (best.ts !== assigns[i].ts || best.ta !== assigns[i].ta) changed++;
        assigns[i] = best;
      }
      if (changed === 0) break;
    }
  };

  const objectiveOf = (sigma: number, cb: number, cw: number): number => {
    const g = globalStats();
    let ll = marginalLogP(g.K1, g.n1, g.S1, 1.0, BETA_S) + marginalLogP(g.K2, g.n2, g.S2, A_W, B_W);
    for (const { ts, ta } of assigns) {
      ll += -0.5 * ((ts - cb) / sigma) ** 2 - 0.5 * ((ta - cw) / sigma) ** 2;
    }
    return ll;
  };

  // 第一遍：宽先验（中心 = 习惯）
  runPass(SIGMA_PASS1, cb0, cw0);

  // 先验中心重估（§2.4）：剔除首尾活跃窗后取各夜切换点中位数。
  // 防自我强化（§4.2）：重估中位数偏离先验 > 3h = 作息类型可能选错——
  // 不静默改先验、不提议（提示用户确认作息是后续 UI 的事）
  const midActive = activeDays.slice(1, -1);
  const medTs = median3(midActive.map((_, i) => assigns[i + 1].ts));
  const medTa = median3(midActive.map((_, i) => assigns[i + 1].ta));
  if (Math.abs(medTs - cb0) > RECENTRE_MAX_BINS || Math.abs(medTa - cw0) > RECENTRE_MAX_BINS) {
    return { status: 'rejected', reason: '推断作息与先验中心偏差 >3h（作息类型可能不符）', code: 'prior-mismatch' };
  }
  // 第二遍：以重估中位数收紧
  runPass(SIGMA_PASS2, medTs, medTa);

  // λ（后验均值，诊断量）：Gamma 后验 mean = (α+K)/(β+n)
  const g = globalStats();
  const lambdaSleep = (1 + g.K1) / (BETA_S + g.n1);
  const lambdaAwake = (A_W + g.K2) / (B_W + g.n2);
  const lambdaRatio = lambdaAwake / Math.max(1e-9, lambdaSleep);
  if (lambdaRatio < LAMBDA_RATIO_MIN) {
    return { status: 'rejected', reason: `λ 对比度不足（${lambdaRatio.toFixed(1)}）`, code: 'low-contrast' };
  }

  // Δ 置信度：两态（含时间先验）vs 单态零模型
  const twoState = objectiveOf(SIGMA_PASS2, medTs, medTa);
  const singleState = marginalLogP(g.K1 + g.K2, g.n1 + g.n2, g.S1 + g.S2, A_W, B_W);
  const delta = twoState - singleState;
  if (!(delta >= DELTA_MIN)) {
    return { status: 'rejected', reason: `似然比 Δ=${Math.round(delta)} < ${DELTA_MIN}`, code: 'low-delta' };
  }

  // ── 4) 逐夜闸门：时长 [3,14]h + 偏离本人中位 ≤ 2.5h（§5.2/§5.3）──
  // ── 5) 目标夜选择（第 28 轮重设计：数据驱动，不按钟点卡）──
  // 此前的门是"ob ≥ 习惯起床 −1h"——按钟点卡：起床 07:00 的用户 5:30–6:00
  // 打开 App 会被判"可能还在睡"直接拒绝且不回退，早晨永远没有卡片。
  // 新规则：用户此刻正拿着手机打开 App，"已经醒了"就是最硬的行为证据——
  // 只要当前窗里存在一段【已结束的、形态可信的】睡眠段就提议它。
  // "还在睡"的保护不靠钟点，靠起床偏离闸门：凌晨打开时拟合出的起床时刻被
  // 钉在观测末端，与本人中位的偏离随夜深增大——超过 3h 即拒绝（对习惯 7 点
  // 起床者约在 04:00 前生效）。更近的凌晨（04:00–06:30）仍可能产出"截至
  // 此刻"的提议——真早起与起夜后接着睡在屏幕数据上不可区分（信息论边界），
  // 由提议卡的"截至此刻"标注 + 用户自行判断兜底。
  const targetOk = (a: Assign): boolean => {
    const dur = a.ta - a.ts;
    if (dur < NIGHT_MIN_BINS || dur > NIGHT_MAX_BINS) return false;
    if (Math.abs(a.ts - medTs) > NIGHT_DEV_BINS) return false;      // 就寝侧紧（信号弱）
    if (Math.abs(a.ta - medTa) > NIGHT_WAKE_DEV_BINS) return false; // 起床侧松（信号强+在场）
    return true;
  };

  let targetIdx = -1;
  {
    const d0 = days[0];
    const a0Idx = activeIdx.indexOf(0);
    if (a0Idx >= 0 && d0.totalK >= TARGET_MIN_EVENTS && targetOk(assigns[a0Idx])) {
      targetIdx = 0;   // 早晨主场景：昨晚就落在当前窗
    } else {
      // 当前窗不构成完整夜：若还在"今晚就寝之前"（同一日历日且未到就寝时刻），
      // 改用最近一个【完整】窗（傍晚打开，提议昨夜——与旧启发式行为对齐）；
      // 深夜/凌晨打开（真还在睡）→ 拒绝，绝不把"前晚"当"昨晚"
      const nowD = new Date(now);
      const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
      const wsD = new Date(windowStart0);
      const sameCalDay = nowD.getFullYear() === wsD.getFullYear()
        && nowD.getMonth() === wsD.getMonth() && nowD.getDate() === wsD.getDate();
      const bedClockMin = (cb0 * 15 + wsMin) % 1440;
      const a1Idx = activeIdx.indexOf(1);
      if (sameCalDay && nowMin < bedClockMin && days[1].ob === BINS
          && a1Idx >= 0 && days[1].totalK >= TARGET_MIN_EVENTS && targetOk(assigns[a1Idx])) {
        targetIdx = 1;
      }
    }
  }
  if (targetIdx < 0) {
    return { status: 'rejected', reason: '未检出可信的睡眠段（可能还在睡，或与平时作息差异过大）', code: 'no-trustworthy-sleep' };
  }
  const targetDay = days[targetIdx];
  const target = assigns[activeIdx.indexOf(targetIdx)];

  const bedtimeMs = windowStart0 - targetIdx * 86400000 + target.ts * BIN_MS;
  const wakeMs = windowStart0 - targetIdx * 86400000 + target.ta * BIN_MS;
  const sleepEventsInTarget = targetDay.Kp[target.ta] - targetDay.Kp[target.ts];

  return {
    status: 'ok',
    bedtime: clockStr(bedtimeMs),
    wakeTime: clockStr(wakeMs),
    bedtimeMs,
    wakeMs,
    windowStartMs: windowStart0,
    targetDate: dateStr(wakeMs),
    delta: Math.round(delta),
    lambdaAwake,
    lambdaSleep,
    lambdaRatio,
    sleepEventsInTarget,
    nightsFitted: activeDays.length,
  };
}
