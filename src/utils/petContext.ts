/**
 * 桌宠记录感知上下文（第二批，行为方案 §二后半）。
 * 独立纯模块：petOverlay 组装 payload 消费它，护栏对它做逻辑级数值测试
 * （复审 R4——此前内联在 petOverlay 里只能用字符串断言钉形状）。
 *
 * 字段口径（第 51 轮夜归属统一后）：记录日期 = 放下手机那晚——
 * "昨晚的记录"就是 date=昨天（凌晨放下更归昨天）的最近一条夜睡。
 */
import { SleepRecord } from '../types/sleep';
import { toLocalDateString } from './dateUtils';

export interface PetContext {
  /** 昨晚评分（-1=无记录） */
  lastScore: number;
  /** 连续未记录夜数（含最近一夜，封顶 14） */
  missedDays: number;
  /** 昨晚是否已入账 */
  lastNightRecorded: boolean;
}

export function petContext(records: SleepRecord[], now: Date): PetContext {
  const night = (r: SleepRecord): boolean => r.kind !== 'nap';
  // "昨晚已入账"= 存在 date=昨天（昨晚的夜归属键）的夜睡记录——
  // 用最近夜睡的 date 匹配会让"停在前天"的记录被误判成已入账
  const yKey = toLocalDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const lastNight = records.find((r) => night(r) && r.date === yKey);
  // 从昨晚的夜归属键（=昨天）起往前数：夜睡的 date 都是"就寝那晚"，
  // 今天白天不存在"今天的夜"——昨晚没记，missedDays 从 1 起算
  let missedDays = 0;
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = toLocalDateString(d);
    if (records.some((r) => night(r) && r.date === key)) break;
    missedDays++;
  }
  return { lastScore: lastNight ? lastNight.sleepScore : -1, missedDays, lastNightRecorded: !!lastNight };
}
