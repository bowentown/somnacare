/**
 * 评分口径迁移（第 105 轮，v1 → v2）。
 *
 * v2 = 只对可测维度计分（时长 vs 个人需求 / 效率 / 潜伏期 / 夜醒），
 * deep/REM 占比退出计分——一键/手动路径的分期来自构造先验，把先验再当
 * 测量打 40 分是伪测量（sleepScore.ts 头注释详述）。
 *
 * 迁移策略沿用第 51 轮日期口径迁移的既有模式：一次性全量重算 + localStorage
 * 标记保证幂等。重算按各记录【之前的夜集】确定需求（无前视，确定性）。
 * 已知副作用（在案）：旅行能量按记录当时的旧分结算，重算后 record 分数
 * 与历史能量贡献不再逐分对应——能量不回滚（已获得的体验不收回），仅
 * 展示口径统一为 v2。
 */
import { SleepRecord } from '../types/sleep';
import { calculateSleepScore, computeSleepNeed } from './sleepScore';

export const SCORE_SCHEMA_KEY = 'somnacare_score_schema';
export const SCORE_SCHEMA_VERSION = 'v2';

/**
 * 全量按 v2 重算（无标记检查——导入路径用）。
 * 逐条用【严格早于该记录】的夜集确定需求：按日期升序遍历，遍历到哪条，
 * prior 就含哪条之前的全部记录——同一份输入永远得到同一份输出。
 */
export function rescoreRecords(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
): SleepRecord[] {
  const asc = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const prior: SleepRecord[] = [];
  return asc
    .map((r) => {
      // "当夜的需求"以该夜就寝当天 21:00 为观测时点——只含此前的夜集
      const observedAt = new Date(
        Number(r.date.slice(0, 4)), Number(r.date.slice(5, 7)) - 1, Number(r.date.slice(8, 10)), 21, 0, 0, 0,
      );
      const need = computeSleepNeed(prior, 480, chronotype, observedAt);
      const target = need.basis === 'personal' ? need.needMinutes : 480;
      const { score } = calculateSleepScore(
        r.durationMinutes, r.deepSleepMinutes, r.remSleepMinutes,
        r.awakeMinutes, r.wakeCount, r.latencyMinutes ?? 15, target,
      );
      prior.push(r);
      return score !== r.sleepScore ? { ...r, sleepScore: score } : r;
    })
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

/** 标记门控版（启动加载路径用）：已迁移则原样返回。 */
export function rescoreRecordsIfNeeded(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
): { records: SleepRecord[]; migrated: boolean } {
  try {
    if (localStorage.getItem(SCORE_SCHEMA_KEY) === SCORE_SCHEMA_VERSION) {
      return { records, migrated: false };
    }
  } catch { /* 隐私模式：每次都算（幂等，代价可忽略） */ }
  const before = JSON.stringify(records.map((r) => r.sleepScore));
  const rescored = rescoreRecords(records, chronotype);
  const migrated = JSON.stringify(rescored.map((r) => r.sleepScore)) !== before;
  try { localStorage.setItem(SCORE_SCHEMA_KEY, SCORE_SCHEMA_VERSION); } catch { /* ignore */ }
  return { records: rescored, migrated };
}
