/**
 * 时钟偏差数学（P1 规律度与 P3 使用行为共用）：
 * 中位数/圆周统计——比均值抗离群，一夜熬夜/一次深夜刷机不应毁掉整周分数。
 */

export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** "HH:MM" → 分钟（无跨午夜处理）。 */
export function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// （madFromMedian / bedClockAxis 已移除：第 45 轮死导出扫描确认无调用方——
//   前者被 circularDev 的自有实现取代，后者被圆周短弧口径取代）
export function deviationToScore(avgDev: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - Math.max(0, avgDev - 10) * (100 / 80))));
}

// ── 圆周统计（第 20 轮方案第 2 层，修 D2）──
// 一天是 1440 分钟的圆：任何"日界"（12:00 / 0:00）都会制造人为断点，
// 而作息本来就可能落在圆的任意位置（白天睡觉、跨午夜、分段睡眠）。

const DAY_MIN = 1440;

/**
 * 圆周平均方向（分钟，[0,1440)）。方向相互抵消（真·双峰不规律）时返回 null。
 */
export function circularMean(times: number[]): number | null {
  if (times.length === 0) return null;
  let x = 0, y = 0;
  for (const t of times) {
    const a = (t / DAY_MIN) * 2 * Math.PI;
    x += Math.cos(a); y += Math.sin(a);
  }
  x /= times.length; y /= times.length;
  if (Math.hypot(x, y) < 1e-9) return null;
  return ((Math.atan2(y, x) / (2 * Math.PI)) * DAY_MIN + DAY_MIN) % DAY_MIN;
}

/**
 * 圆周平均绝对偏差（分钟）：每个点到圆周均值的【短弧】距离取均值。
 * 短弧是关键——23:50 到 00:10 是 20 分钟，不是 1420；11:50 到 12:10 同理。
 * 方向抵消时返回 DAY_MIN/4（一天的最大合理平均偏差）→ 映射到 0 分。
 */
export function circularDev(times: number[]): number {
  if (times.length === 0) return 0;
  const c = circularMean(times);
  if (c === null) return DAY_MIN / 4;
  const devs = times.map((t) => {
    const d = Math.abs(t - c) % DAY_MIN;
    return Math.min(d, DAY_MIN - d);
  });
  return devs.reduce((a, v) => a + v, 0) / devs.length;
}

/** 两时刻的短弧距离（分钟）。 */
export function shortArc(a: number, b: number): number {
  const d = Math.abs(a - b) % DAY_MIN;
  return Math.min(d, DAY_MIN - d);
}

/**
 * 圆周中位数：以圆周均值为轴收拢后取线性中位。
 * 就寝横跨午夜是常态（22/23/01/02 点的线性中位会偏 ~2.5h）——
 * 先验中心必须用它，不能用线性 median。
 */
export function circularMedian(times: number[]): number {
  if (times.length === 0) return NaN;
  const pivot = circularMean(times) ?? 0;
  const shifted = times.map((v) => {
    let d = v - pivot;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    return d;
  });
  return ((pivot + median(shifted)) % 1440 + 1440) % 1440;
}
