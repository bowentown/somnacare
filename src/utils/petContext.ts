/**
 * 桌宠记录感知上下文（第二批，行为方案 §二后半）。
 * 独立纯模块：petOverlay 组装 payload 消费它，护栏对它做逻辑级数值测试
 * （复审 R4——此前内联在 petOverlay 里只能用字符串断言钉形状）。
 *
 * 字段口径（复审 N3 改名后）：记录日期 = 醒来日——昨晚的记录日期就是今天。
 */
import { SleepRecord } from '../types/sleep';

export interface PetContext {
  /** 昨晚评分（-1=无记录） */
  lastScore: number;
  /** 连续未记录夜数（含最近一夜，封顶 14） */
  missedDays: number;
  /** 昨晚是否已入账（复审 N3 改名：原 hasTonight 名不副实） */
  lastNightRecorded: boolean;
}

export function petContext(records: SleepRecord[], now: Date): PetContext {
  const night = (r: SleepRecord): boolean => r.kind !== 'nap';
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lastNight = records.find((r) => night(r) && r.date === today);
  // 从最近一夜（=今天）起往前数——复审 N2：原 i=1 漏掉最近一夜，
  // "连续未记录 ≥3 晚"实际要连漏 4 晚才触发
  let missedDays = 0;
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (records.some((r) => night(r) && r.date === key)) break;
    missedDays++;
  }
  return { lastScore: lastNight ? lastNight.sleepScore : -1, missedDays, lastNightRecorded: !!lastNight };
}
