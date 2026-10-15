import { SleepRecord } from '../types/sleep';
import { calculateSleepScore, generateSleepStages } from './sleepScore';
import { deriveKind } from './recordFilter';
import { nightKeyOfBed } from './dateUtils';

/**
 * 记录构建器：把"就寝/醒来时刻窗"转成一条 SleepRecord。
 *
 * 逻辑逐字承自 OneTapSleepTracker.handleWakeUp（黄金样本护栏
 * tools/verify-record-builder.mts 保证逐字段一致），供一键就寝与
 * 使用行为提议（P3）共用——两条写入口必须共用同一构建器，
 * 否则评分/分期/截断行为会漂移。
 *
 * 保留的既有行为（踩过坑的）：
 *  - 16 小时会话截断 + 反推入睡时刻（忘记结束不产生多天记录）
 *  - 微睡眠分支（<90 分钟重算分期）
 *  - 分期与评分用同一个启发式潜伏期
 *  - durationMinutes = 纯睡眠（窗 − 觉醒）
 *  - recordDate = 夜归属（就寝那晚的本地日历日；凌晨放下归前一天，
 *    第 51 轮从"醒来那天"整体切换——真机 10-15 实证夜猫子分数错挂当天）
 */
export interface BuildInput {
  sleepStartMs: number;
  wakeMs: number;
  targetDurationHours?: number;
  id: string;
  /** 记录来源（诚实标注）：一键就寝 / 手动补录 / 手机使用提议 */
  recordSource?: 'onetap' | 'manual' | 'usage';
  /** 作息类型：决定 kind 归类（第 21 轮 #1——白天为主者的主睡不是小睡） */
  chronotype?: 'night' | 'day' | 'irregular';
  // ── 结束面板的用户输入（整夜监测有滑块/夜醒计数/心情/习惯/梦记）。
  //    提供时覆盖启发式值——分期、评分与落库字段必须同源，否则详情页
  //    互相矛盾（第 23 轮：这里曾硬编码 latency=14 评分、存值却是用户的 45）
  userLatencyMinutes?: number;
  userLatencyEstimated?: boolean;
  userWakeCount?: number;
  userWakingMood?: SleepRecord['wakingMood'];
  userPreSleepHabits?: string[];
  userDreamNotes?: string;
}

export interface BuiltRecord {
  record: SleepRecord;
  truncated: boolean;
}

export function buildRecordFromWindow(input: BuildInput): BuiltRecord {
  const sleepStartTime = input.sleepStartMs;
  const wakeDate = new Date(input.wakeMs);

  // 会话时长上限 16 小时：忘记结束的会话不产生多天时长的荒谬记录；
  // 截断时入睡时刻按"醒来 − 16h"反推，保证分期推演窗口与记录时长一致
  const rawDurationMinutes = Math.max(1, Math.round((wakeDate.getTime() - sleepStartTime) / 60000));
  const exactDurationMinutes = Math.min(960, rawDurationMinutes);
  const sessionTruncated = rawDurationMinutes > 960;
  const effectiveStart = new Date(wakeDate.getTime() - exactDurationMinutes * 60000);

  const bedtimeStr = `${String(effectiveStart.getHours()).padStart(2, '0')}:${String(
    effectiveStart.getMinutes()
  ).padStart(2, '0')}`;
  const wakeTimeStr = `${String(wakeDate.getHours()).padStart(2, '0')}:${String(
    wakeDate.getMinutes()
  ).padStart(2, '0')}`;

  // 启发式潜伏期：生成与评分必须用同一个值，否则分期图与记录字段互相矛盾；
  // 用户在结束面板声明的值优先（仍保持"同一值贯穿分期/评分/字段"）
  const latencyUsed = input.userLatencyMinutes ?? (exactDurationMinutes < 15 ? 2 : 12);
  const wakeCountUsed = input.userWakeCount ?? (exactDurationMinutes < 15 ? 0 : 1);
  const generated = generateSleepStages(bedtimeStr, wakeTimeStr, latencyUsed, wakeCountUsed);

  let deepMin = generated.deepMinutes;
  let remMin = generated.remMinutes;
  let awakeMin = generated.awakeMinutes;
  let lightMin = generated.lightMinutes;

  if (exactDurationMinutes < 90) {
    // Micro-sleep or brief testing
    deepMin = Math.max(0, Math.round(exactDurationMinutes * 0.1));
    remMin = 0;
    awakeMin = Math.min(2, exactDurationMinutes);
    lightMin = Math.max(1, exactDurationMinutes - deepMin - awakeMin);
  }

  // 统一语义：durationMinutes = 纯睡眠（卧床窗 − 觉醒段）
  const sleepMinutes = Math.max(1, exactDurationMinutes - awakeMin);
  const { score, efficiency } = calculateSleepScore(
    sleepMinutes,
    deepMin,
    remMin,
    awakeMin,
    wakeCountUsed,
    latencyUsed,
    Math.round((input.targetDurationHours || 8) * 60)
  );

  const fmtClock = (base: Date, min: number) => {
    const d = new Date(base.getTime() + min * 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const stagesForRecord =
    exactDurationMinutes < 90
      ? [
          { stage: 'awake' as const, startTime: fmtClock(effectiveStart, 0), endTime: fmtClock(effectiveStart, awakeMin), durationMinutes: awakeMin },
          { stage: 'deep' as const, startTime: fmtClock(effectiveStart, awakeMin), endTime: fmtClock(effectiveStart, awakeMin + deepMin), durationMinutes: deepMin },
          { stage: 'light' as const, startTime: fmtClock(effectiveStart, awakeMin + deepMin), endTime: fmtClock(effectiveStart, exactDurationMinutes), durationMinutes: lightMin },
        ]
      : generated.stages;

  // recordDate = 夜归属（第 51 轮口径统一）：属于"放下手机那晚"——
  // 凌晨放下的夜猫子，昨晚的觉归昨晚，不挂到醒来那天
  const recordDate = nightKeyOfBed(effectiveStart.getTime(), input.chronotype === 'day' ? 'day' : 'night');

  const record: SleepRecord = {
    id: input.id,
    date: recordDate,
    bedtime: bedtimeStr,
    wakeTime: wakeTimeStr,
    durationMinutes: sleepMinutes,
    deepSleepMinutes: deepMin,
    lightSleepMinutes: lightMin,
    remSleepMinutes: remMin,
    awakeMinutes: awakeMin,
    sleepScore: score,
    sleepEfficiency: efficiency,
    latencyMinutes: latencyUsed,
    latencyEstimated: input.userLatencyEstimated ?? true,
    wakeCount: wakeCountUsed,
    wakingMood: input.userWakingMood ?? (exactDurationMinutes < 30 ? 'tired' : 'refreshed'),
    preSleepHabits: input.userPreSleepHabits ?? [],
    ...(input.userDreamNotes ? { dreamNotes: input.userDreamNotes } : {}),
    stages: stagesForRecord,
    kind: deriveKind(effectiveStart.getHours(), input.chronotype) === 'nap' ? 'nap' : undefined,
    ...(input.recordSource ? { recordSource: input.recordSource } : {}),
  } as SleepRecord;

  return { record, truncated: sessionTruncated };
}
