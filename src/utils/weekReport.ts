/**
 * 睡眠周报与连续达标（第 52 轮新增）：数据利用率最高的空缺——
 * 记录都在，缺的是一张"这一周睡得怎么样、连胜多少晚"的汇总。
 *
 * 口径（与全仓一致）：
 *  - 只看夜睡（nightsOnly），date=夜归属（放下手机那晚）
 *  - "已度过夜数"= 本周周一..昨天（今晚尚未发生，不算未记录）
 *  - 达标 = sleepScore ≥ 80（与旅行能量阈值同源）
 *  - 连胜：从昨晚往回数连续达标夜；整段至多容忍 1 个缺卡夜（连续缺卡
 *    或隔开后再次缺卡都会断签）——激励设计而非惩罚设计
 */
import { SleepRecord } from '../types/sleep';
import { nightsOnly } from './recordFilter';
import { toLocalDateString } from './dateUtils';

export const GOOD_NIGHT_THRESHOLD = 80;

export interface WeekReport {
  /** 近 7 晚（含今晚之前的）夜数 */
  nights: number;
  avgScore: number | null;
  avgDurationMin: number | null;
  /** 达标夜数 / 已度过夜数（本周口径） */
  goodNights: number;
  elapsedNights: number;
  best: { date: string; score: number } | null;
  /** 连续达标夜数（从昨晚回数，1 晚宽限） */
  streak: number;
  /** 连胜是否正处于宽限（昨晚缺卡但更早仍在连胜） */
  graceUsed: boolean;
}

export function computeWeekReport(records: SleepRecord[], now: Date = new Date()): WeekReport {
  const nights = nightsOnly(records);

  // 近 7 晚汇总（date 降序，slice(0,7) 即最近 7 晚——全仓既有口径）
  const recent7 = nights.slice(0, 7);
  const avgScore = recent7.length
    ? Math.round(recent7.reduce((a, r) => a + r.sleepScore, 0) / recent7.length)
    : null;
  const avgDurationMin = recent7.length
    ? Math.round(recent7.reduce((a, r) => a + r.durationMinutes, 0) / recent7.length)
    : null;
  let best: WeekReport['best'] = null;
  for (const r of recent7) {
    if (!best || r.sleepScore > best.score) best = { date: r.date, score: r.sleepScore };
  }

  // 本周已度过夜数（周一=0 .. 昨天=本周最后一个已过去的夜）
  const dowIdx = (now.getDay() + 6) % 7;
  const elapsedNights = dowIdx;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dowIdx);
  const weekKeys = new Set<string>();
  for (let i = 0; i < elapsedNights; i++) {
    weekKeys.add(toLocalDateString(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
  }
  // 按夜去重：导入数据同一天可能有多条夜睡（导入路径只排序不去重），
  // 不去重会出现"本周达标 2/1"（第 54 轮）
  const weekSeen = new Set<string>();
  let goodNights = 0;
  for (const r of nights) {
    if (!weekKeys.has(r.date) || weekSeen.has(r.date)) continue;
    weekSeen.add(r.date);
    if (r.sleepScore >= GOOD_NIGHT_THRESHOLD) goodNights++;
  }

  // 连续达标：昨晚起回数；无记录 1 晚 = 宽限（不增不断），连漏 2 = 断。
  // 宽限只在"缺卡夜之后（更早）仍有记录"时才算被用——历史尽头的空夜
  // 是连胜的自然终结，不构成"今晚保住连胜"的叙事。
  let streak = 0;
  let missAt = -1;
  let lastSeen = 0;
  const byDate = new Map<string, SleepRecord>();
  for (const r of nights) {
    if (!byDate.has(r.date)) byDate.set(r.date, r);
  }
  for (let i = 1; i <= 60; i++) {   // 回溯上限 60 晚（UI 可显示"60+"）
    const key = toLocalDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    const rec = byDate.get(key);
    if (rec) {
      lastSeen = i;
      if (rec.sleepScore >= GOOD_NIGHT_THRESHOLD) streak++;
      else break;
    } else if (missAt >= 0) {
      break;   // 宽限已用又缺 = 断
    } else {
      missAt = i;   // 首次缺卡：宽限（连胜保留但停涨）
    }
  }
  // 宽限只对"昨晚缺卡"成立（连胜保留的叙事）；缺卡发生在更早位置
  // 且更早已无记录时不算
  const graceUsed = missAt === 1 && lastSeen > missAt;

  return { nights: recent7.length, avgScore, avgDurationMin, goodNights, elapsedNights, best, streak, graceUsed };
}
