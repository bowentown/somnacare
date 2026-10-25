/**
 * 本地时区日期工具。全项目表示"某一天"时只用这里，禁用 toISOString()——
 * 那是 UTC：东八区早上 6–9 点会落到前一天（OneTapSleepTracker 的跨夜记录
 * 互相覆盖、备份文件名日期倒退，都是这个坑的实例）。
 */
export function toLocalDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 几天前/后的本地日期（负数往前）。 */
export function localDateOffset(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
}

/**
 * 夜归属日期（第 51 轮口径统一）：一晚睡眠属于"放下手机那晚"——
 * 凌晨 00:36 放下睡到早上 08:31，是"前一晚"的觉，不是醒来那天新开的一晚。
 * 规则与原生聚合（UsageSignalPlugin）完全同源：
 *  - 夜间作息：就寝时钟 <12:00 → 归前一天（−12h 分桶）；否则归当天
 *  - 白天作息：自然日分桶，归当天（原生对 day 不平移）
 * 此前全链路用"醒来那天"（凌晨放下的夜猫子每天都会把昨晚的分数挂到
 * 今天），与用户直觉相反，已在第 51 轮整体切换。
 */
export function nightKeyOfBed(bedtimeMs: number, chronotype: 'night' | 'day' = 'night'): string {
  const d = new Date(bedtimeMs);
  const shift = chronotype === 'day' ? 0 : d.getHours() < 12 ? 1 : 0;
  return toLocalDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift));
}

