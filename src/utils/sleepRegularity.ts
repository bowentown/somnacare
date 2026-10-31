import { SleepRecord } from '../types/sleep';

/**
 * 作息规律度（P1 口径：按用户自己记录的就寝/起床时刻计算——
 * 这是可验证的统计量，不是生理测量值；文案必须保留"按你自己记录的
 * 作息计算"这一诚实边界）。
 *
 * 【SRI（第 104 轮起）】此前注释禁止称 SRI——门槛是"真正的 SRI 需要逐分钟
 * 睡着/醒着状态"。该门槛自本轮满足：夜睡窗 + 小睡窗可以构造逐分钟二值
 * 序列（见 computeSRI），认识论地位与分期估算相同（模型/先验的产物），
 * UI 保留"按你记录的作息构造"口径。
 *
 * 科学依据：SRI = Fischer et al. 2021（Sleep）定义——逐分钟与其 24 小时后
 * 的状态对照，SRI = 200×同态率 − 100（完全一致=100，随机≈0）。
 * Windred et al. 2024（Sleep）的队列分析显示规律度对死亡率的预测力
 * 超过时长——这是把规律度作为一等指标（并纳入评分）的流行病学依据。
 */

export interface RegularityResult {
  nights: number;
  bedDev: number;   // 就寝平均绝对偏差（分钟）
  wakeDev: number;  // 起床平均绝对偏差（分钟）
  avgDev: number;   // 两者均值（分钟）
  score: number;    // 0-100：avgDev ≤10 分钟 → 100，≥90 分钟 → 0，中间线性
}

// 数学口径下沉到 clockMath（P3 手机使用规律度共用同一套 MAD/映射），
// 行为不变——verify-regularity 护栏继续做反向验证
import { circularDev, clockMinutes, deviationToScore } from './clockMath';
import { nightsOnly, napsOnly } from './recordFilter';

/** 一天 1440 分钟（SRI 的 24 小时滞后对照用）。 */
const DAY_MIN = 1440;

/**
 * 记录 → 睡眠区间（epoch 毫秒，start/end）。
 *
 * 就寝的【日历日】必须与夜归属互逆：nightKeyOfBed 规定 bedHour<12 的凌晨
 * 就寝归前一天（dateKey = 就寝日 − 1），因此这里凌晨就寝的日历日 = date+1
 * （day 作息不平移，与 nightKeyOfBed 的 day 豁免一致）。
 * verify-regularity 会用权威函数 nightKeyOfBed 做往返校验。
 */
export function sleepIntervalsOf(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
): Array<{ start: number; end: number }> {
  const cal = (dateKey: string, hhmm: string, dayShift: number): number => {
    const [y, mo, d] = dateKey.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    return new Date(y, mo - 1, d + dayShift, h, mi, 0, 0).getTime();
  };
  const out: Array<{ start: number; end: number }> = [];
  for (const r of records) {
    const dayShift = chronotype === 'day' ? 0 : (parseInt(r.bedtime.split(':')[0], 10) < 12 ? 1 : 0);
    const start = cal(r.date, r.bedtime, dayShift);
    let end = cal(r.date, r.wakeTime, dayShift);
    if (end <= start) end += 86400000;   // 跨午夜：醒在同日钟点之前 → 次日
    out.push({ start, end });
  }
  return out;
}

export interface SRIResult {
  sri: number;              // 0-100（Fischer 2021 口径）
  nights: number;           // 窗口内有夜睡的天数
  pairs: number;            // 参与对照的"相邻都有记录的天"对数
}

/**
 * 真 SRI（近 days 天）：逐分钟与其 24 小时后的状态对照。
 *
 * 构造与诚实边界：
 *  - 状态序列由记录构造——夜睡窗/小睡窗内=睡着，观察日内其余=醒着；
 *    【无记录的天不参与对照】（未知 ≠ 醒着，否则惩罚漏记者）。
 *  - 只对照"前后两天都有夜睡记录"的相邻天对；可对照对数 < 3 → null
 *    （样本不足不显示假数字，与 computeRegularity 同门槛）。
 *  - SRI 量的是【一致性】不是睡眠量：白天完全不睡与每天固定午睡同样高。
 */
export function computeSRI(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
  now: Date = new Date(),
  days = 14,
): SRIResult | null {
  // 逐日【本地午夜】锚定（不能用"日序号 × 86400000"——那是 UTC 午夜，
  // UTC+8 下整体错 8 小时）
  const dayStartMs = (k: number): number =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1) + k).getTime();
  const keyOf = (k: number): string => {
    const d = new Date(dayStartMs(k));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // 观察日：夜睡记录的 date（头）或其次日（尾——醒在当天早上）都有观测
  const nights = nightsOnly(records).filter((r) => r.date >= keyOf(0) && r.date <= keyOf(days - 1));
  if (nights.length < 3) return null;
  const observed = new Set<number>();
  for (const r of nights) {
    const k = Math.round((new Date(r.date + 'T12:00:00').getTime() - dayStartMs(0)) / 86400000);
    if (k >= 0 && k <= days - 1) { observed.add(k); observed.add(k + 1); }
  }

  // 逐分钟状态 + 观测掩码：夜睡窗/小睡窗内=睡着；其余分钟只有在
  // 【纪元内（首区间起点 → 末区间终点）且当天有夜睡记录】才算"观测到醒着"
  // ——首日就寝前、末日醒来后、以及漏记夜的分钟是【未知】而不是醒着，
  // 把未知当醒着会惩罚漏记的人（SRI 崩给诚实记录的用户）。
  const vectors = new Map<number, Uint8Array>();
  const obsMasks = new Map<number, Uint8Array>();
  const all = sleepIntervalsOf([...nights, ...napsOnly(records)], chronotype);
  if (all.length === 0) return null;
  const eraStart = Math.min(...all.map((x) => x.start));
  const eraEnd = Math.max(...all.map((x) => x.end));
  for (let k = 0; k < days; k++) {
    if (!observed.has(k)) continue;
    const ds = dayStartMs(k);
    const era0 = Math.max(0, Math.floor((eraStart - ds) / 60000));
    const era1 = Math.min(DAY_MIN, Math.ceil((eraEnd - ds) / 60000));
    if (era1 <= era0) continue;
    const obs = new Uint8Array(DAY_MIN);
    for (let i = era0; i < era1; i++) obs[i] = 1;
    obsMasks.set(k, obs);
    let vec: Uint8Array | undefined;
    for (const { start, end } of all) {
      if (end <= ds || start >= ds + 86400000) continue;
      const i0 = Math.max(0, Math.floor((start - ds) / 60000));
      const i1 = Math.min(DAY_MIN, Math.ceil((end - ds) / 60000));
      if (!vec) vec = new Uint8Array(DAY_MIN);
      for (let i = i0; i < i1; i++) vec[i] = 1;
    }
    if (vec) vectors.set(k, vec);
  }

  // 相邻观察日对照（同钟点分钟对 = 24h 滞后），只在【两侧都观测】的分钟上
  // 进行；时钟变更会造成 23/25 小时日——按 1440 网格对齐在案（中国无夏令时）
  const observedDays = [...observed].sort((a, b) => a - b);
  let cmp = 0;
  let match = 0;
  let pairs = 0;
  for (let i = 0; i < observedDays.length - 1; i++) {
    const a = observedDays[i];
    const b = observedDays[i + 1];
    if (b - a !== 1) continue;   // 只对照相邻自然日（24h 滞后）
    const va = vectors.get(a);
    const vb = vectors.get(b);
    const oa = obsMasks.get(a);
    const ob = obsMasks.get(b);
    if (!va || !vb || !oa || !ob) continue;
    pairs++;
    for (let m = 0; m < DAY_MIN; m++) {
      if (!oa[m] || !ob[m]) continue;
      cmp++;
      if (va[m] === vb[m]) match++;
    }
  }
  if (pairs < 4) return null;   // 可对照天对不足 4 → 不显示假数字
  const sri = Math.max(0, Math.min(100, Math.round(200 * (match / cmp) - 100)));
  return { sri, nights: nights.length, pairs };
}

/**
 * 近 7 晚规律度（records 需按日期降序，records[0] 最新）。
 * 少于 3 晚返回 null——不显示假数字。
 */
export function computeRegularity(records: SleepRecord[]): RegularityResult | null {
  // 纵深防御：即使调用点漏过滤，本函数也不把小睡算进规律度
  const wk = nightsOnly(records).slice(0, 7);
  if (wk.length < 3) return null;
  // 圆周统计（修 D2）：任何日界断点（12:00/0:00）都不再制造人为偏差
  const bedDev = Math.round(circularDev(wk.map((r) => clockMinutes(r.bedtime))));
  const wakeDev = Math.round(circularDev(wk.map((r) => clockMinutes(r.wakeTime))));
  const avgDev = (bedDev + wakeDev) / 2;
  const score = deviationToScore(avgDev);
  return { nights: wk.length, bedDev, wakeDev, avgDev: Math.round(avgDev), score };
}

/** 规律度分档（score ≥80 稳 / ≥50 中 / 其余波动大）。 */
export function regularityTier(score: number): 'steady' | 'ok' | 'wild' {
  return score >= 80 ? 'steady' : score >= 50 ? 'ok' : 'wild';
}
