import { SleepRecord } from '../types/sleep';
import { computeRegularity, RegularityResult } from './sleepRegularity';
import { napsOnly, nightsOnly } from './recordFilter';

/**
 * 本周睡眠小结的【唯一】聚合实现（第 22 轮教训的根治）：
 * TrendsTab 页面上曾有一份平行的聚合（卡片现名"近期睡眠小结"）（wk/avg/best），与 computeRegularity
 * 各算各的——换数据口径（nightsOnly）时只改了一处，另一处对全小睡输入
 * 抛出 undefined 崩溃且阻断记录落盘。现在聚合收敛到本纯函数：
 * 空列表是合法输入（全部字段优雅降级），护栏直接测它。
 */
export interface WeekSummary {
  /** 夜睡晚数（小睡不计入） */
  nights: number;
  avgScore: number | null;
  avgDurationMin: number | null;
  avgDeepMin: number | null;
  /** 最高分的一晚（无夜睡时 null） */
  best: SleepRecord | null;
  /** 近 7 晚小睡（展示用，不计入规律度） */
  naps: SleepRecord[];
  napCount: number;
  napMinutes: number;
  regularity: RegularityResult | null;
}

export function summarizeWeek(records: SleepRecord[]): WeekSummary {
  const wk = nightsOnly(records).slice(0, 7);
  const naps = napsOnly(records).slice(0, 7);

  // 空夜睡列表是合法输入：聚合值一律 null，绝不出 NaN / undefined
  const avg = (f: (r: SleepRecord) => number): number | null =>
    wk.length === 0 ? null : Math.round(wk.reduce((a, r) => a + f(r), 0) / wk.length);

  return {
    nights: wk.length,
    avgScore: avg((r) => r.sleepScore),
    avgDurationMin: avg((r) => r.durationMinutes),
    avgDeepMin: avg((r) => r.deepSleepMinutes),
    best: wk.length > 0 ? wk.reduce((a, r) => (r.sleepScore > a.sleepScore ? r : a)) : null,
    naps,
    napCount: naps.length,
    napMinutes: naps.reduce((a, r) => a + r.durationMinutes, 0),
    regularity: computeRegularity(records),
  };
}
