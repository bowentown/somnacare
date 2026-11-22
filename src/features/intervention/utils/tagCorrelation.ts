import type { SleepRecord } from '../../../shared/types/sleep';
import { nightsOnly } from '../../sleep/utils/recordFilter';
import { HABIT_OPTIONS } from './habitCatalog';
import type { CustomDiaryTag } from '../store/interventionStore';

/** 诚实统计门槛：至少 5 晚带标签且至少 2 晚不带标签，才展示对照差值（避免小样本伪相关）。 */
export const MIN_TAGGED_NIGHTS = 5;
export const MIN_UNTAGGED_NIGHTS = 2;

export interface TagCorrelationItem {
  id: string;
  label: string;
  emoji: string;
  isCustom: boolean;
  taggedNights: number;
  untaggedNights: number;
  avgScoreWith: number;
  avgScoreWithout: number;
  scoreDelta: number;
  durationDeltaMin: number;
  latencyDeltaMin: number;
}

export interface TagProgressItem {
  id: string;
  label: string;
  emoji: string;
  isCustom: boolean;
  taggedNights: number;
  neededNights: number;
}

export interface TagCorrelationReport {
  totalNights: number;
  unlocked: TagCorrelationItem[];
  locked: TagProgressItem[];
}

const BUILTIN_EMOJI: Record<string, string> = {
  screen_time: '📱',
  caffeine: '☕',
  hot_bath: '🛁',
  meditation: '🧘',
  reading: '📖',
  workout: '🏃',
  alcohol: '🍷',
  heavy_meal: '🍜',
};

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * 计算睡前习惯与自定义标签的个人睡眠关联统计（纯函数）。
 * 严格执行 ≥5 晚门槛：样本不足的标签只报告进度，绝不输出误导性差值。
 */
export function computeTagCorrelations(
  records: SleepRecord[],
  customTags: CustomDiaryTag[] = [],
): TagCorrelationReport {
  const nights = nightsOnly(records);
  const catalog: Array<{ id: string; label: string; emoji: string; isCustom: boolean }> = [
    ...HABIT_OPTIONS.map((h) => ({
      id: h.id,
      label: h.label,
      emoji: BUILTIN_EMOJI[h.id] ?? '🏷️',
      isCustom: false,
    })),
    ...customTags.map((t) => ({
      id: t.id,
      label: t.label,
      emoji: t.emoji || '🏷️',
      isCustom: true,
    })),
  ];

  const unlocked: TagCorrelationItem[] = [];
  const locked: TagProgressItem[] = [];

  for (const item of catalog) {
    const withTag: SleepRecord[] = [];
    const withoutTag: SleepRecord[] = [];
    for (const r of nights) {
      if ((r.preSleepHabits ?? []).includes(item.id)) {
        withTag.push(r);
      } else {
        withoutTag.push(r);
      }
    }
    if (withTag.length === 0) continue;

    if (withTag.length >= MIN_TAGGED_NIGHTS && withoutTag.length >= MIN_UNTAGGED_NIGHTS) {
      const avgScoreWith = Math.round(avg(withTag.map((r) => r.sleepScore)));
      const avgScoreWithout = Math.round(avg(withoutTag.map((r) => r.sleepScore)));
      const scoreDelta = Math.round(avg(withTag.map((r) => r.sleepScore)) - avg(withoutTag.map((r) => r.sleepScore)));
      const durationDeltaMin = Math.round(
        avg(withTag.map((r) => r.durationMinutes)) - avg(withoutTag.map((r) => r.durationMinutes)),
      );
      const latencyDeltaMin = Math.round(
        avg(withTag.map((r) => r.latencyMinutes || 15)) - avg(withoutTag.map((r) => r.latencyMinutes || 15)),
      );
      unlocked.push({
        id: item.id,
        label: item.label,
        emoji: item.emoji,
        isCustom: item.isCustom,
        taggedNights: withTag.length,
        untaggedNights: withoutTag.length,
        avgScoreWith,
        avgScoreWithout,
        scoreDelta,
        durationDeltaMin,
        latencyDeltaMin,
      });
    } else {
      locked.push({
        id: item.id,
        label: item.label,
        emoji: item.emoji,
        isCustom: item.isCustom,
        taggedNights: withTag.length,
        neededNights: Math.max(0, MIN_TAGGED_NIGHTS - withTag.length),
      });
    }
  }

  unlocked.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
  locked.sort((a, b) => b.taggedNights - a.taggedNights);

  return {
    totalNights: nights.length,
    unlocked,
    locked,
  };
}
