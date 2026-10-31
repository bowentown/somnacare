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
export interface SleepDayVector {
  dayIndex: number;            // 0 = 窗口首日
  dateKey: string;
  observed: boolean;           // 当天有夜睡记录（头或尾）
  asleep: Uint8Array | null;   // 1440 分钟睡着掩码（未观察日 = null）
  obsMask: Uint8Array | null;  // 观测掩码：纪元内且当天有夜睡记录
}

/**
 * 逐分钟睡眠序列的唯一构造器（第 106 轮）：computeSRI 与趋势页节律图
 * 共用——图上画的就是 SRI 在量的东西，两者不可能漂移。
 * 观测语义：夜睡记录的当晚（头）与次日早上（尾）都有观测；纪元
 * （首区间起点 → 末区间终点）之外的分钟与漏记夜的分钟是【未知】，
 * 不充当"醒着"。
 */
export function buildSleepDayVectors(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
  now: Date = new Date(),
  days = 14,
): SleepDayVector[] {
  const dayStartMs = (k: number): number =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1) + k).getTime();
  const keyOf = (k: number): string => {
    const d = new Date(dayStartMs(k));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const nights = nightsOnly(records).filter((r) => r.date >= keyOf(0) && r.date <= keyOf(days - 1));
  const observed = new Set<number>();
  for (const r of nights) {
    // 正午锚定恰为 0.5 天：round(0.5)=1 会整体错位一天（第 106 轮日向量锚点抓出）
    const k = Math.floor((new Date(r.date + 'T12:00:00').getTime() - dayStartMs(0)) / 86400000);
    if (k >= 0 && k <= days - 1) { observed.add(k); observed.add(k + 1); }
  }
  const all = sleepIntervalsOf([...nights, ...napsOnly(records)], chronotype);
  const eraStart = all.length ? Math.min(...all.map((x) => x.start)) : 0;
  const eraEnd = all.length ? Math.max(...all.map((x) => x.end)) : 0;

  const out: SleepDayVector[] = [];
  for (let k = 0; k < days; k++) {
    const base: SleepDayVector = { dayIndex: k, dateKey: keyOf(k), observed: observed.has(k), asleep: null, obsMask: null };
    if (!base.observed || all.length === 0) { out.push(base); continue; }
    const ds = dayStartMs(k);
    const era0 = Math.max(0, Math.floor((eraStart - ds) / 60000));
    const era1 = Math.min(1440, Math.ceil((eraEnd - ds) / 60000));
    if (era1 <= era0) { out.push(base); continue; }
    const obs = new Uint8Array(1440);
    for (let i = era0; i < era1; i++) obs[i] = 1;
    let asleep: Uint8Array | undefined;
    for (const { start, end } of all) {
      if (end <= ds || start >= ds + 86400000) continue;
      const i0 = Math.max(0, Math.floor((start - ds) / 60000));
      const i1 = Math.min(1440, Math.ceil((end - ds) / 60000));
      if (!asleep) asleep = new Uint8Array(1440);
      for (let i = i0; i < i1; i++) asleep[i] = 1;
    }
    out.push({ ...base, asleep: asleep ?? null, obsMask: obs });
  }
  return out;
}

export function computeSRI(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
  now: Date = new Date(),
  days = 14,
): SRIResult | null {
  // 夜数口径不变（头日计数）；<3 晚 → null
  const nights = nightsOnly(records).filter((r) => r.date >= keyOf0(now, days) && r.date <= keyOfN(now));
  if (nights.length < 3) return null;
  const days_ = buildSleepDayVectors(records, chronotype, now, days);
  const observedDays = days_.filter((d) => d.observed && d.asleep && d.obsMask);

  // 相邻观察日对照（同钟点分钟对 = 24h 滞后），只在【两侧都观测】的分钟上
  // 进行；时钟变更会造成 23/25 小时日——按 1440 网格对齐在案（中国无夏令时）
  let cmp = 0;
  let match = 0;
  let pairs = 0;
  for (let i = 0; i < observedDays.length - 1; i++) {
    const a = observedDays[i];
    const b = observedDays[i + 1];
    if (b.dayIndex - a.dayIndex !== 1) continue;   // 只对照相邻自然日（24h 滞后）
    pairs++;
    for (let m = 0; m < 1440; m++) {
      if (!a.obsMask![m] || !b.obsMask![m]) continue;
      cmp++;
      if (a.asleep![m] === b.asleep![m]) match++;
    }
  }
  if (pairs < 4) return null;   // 可对照天对不足 4 → 不显示假数字
  const sri = Math.max(0, Math.min(100, Math.round(200 * (match / cmp) - 100)));
  return { sri, nights: nights.length, pairs };
}

// 窗口首/末日键（computeSRI 的夜数过滤用；与 buildSleepDayVectors 同锚定）
function keyOf0(now: Date, days: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function keyOfN(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
