/**
 * 一天四段（第 57 轮）：首页与主卡按时段切换主任务。
 *  - morning   05–11：看昨晚结果 / 补录
 *  - afternoon 11–18：小睡
 *  - evening   18–23：准备入睡
 *  - late      23–05：该睡了
 * 只服务夜间作息；白天主睡者由调用方保留原语义。
 */
export type DayPhase = 'morning' | 'afternoon' | 'evening' | 'late';

export function getDayPhase(date: Date = new Date()): DayPhase {
  const h = date.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'late';
}
