import { beforeEach, describe, expect, it } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { createDefaultProfile } from '../../src/shared/store/profileStore';
import type { SleepRecord } from '../../src/shared/types/sleep';
import { computeCbtiPrescription } from '../../src/features/intervention/utils/cbtiEngine';
import {
  computeTagCorrelations,
  MIN_TAGGED_NIGHTS,
} from '../../src/features/intervention/utils/tagCorrelation';
import {
  addCustomDiaryTag,
  hydrateInterventionStore,
  interventionStore,
  removeCustomDiaryTag,
  resetInterventionStore,
  setPreferredBreathMode,
  toggleLessonCompleted,
  toggleRitualItem,
} from '../../src/features/intervention/store/interventionStore';
import { buildFullBackup, restoreFullBackup } from '../../src/shared/storage/backup';

const storage = installMemoryStorage();

function mkNight(
  date: string,
  opts: Partial<SleepRecord> = {},
): SleepRecord {
  return {
    id: `r-${date}`,
    date,
    bedtime: '23:15',
    wakeTime: '07:15',
    durationMinutes: 480,
    deepSleepMinutes: 105,
    remSleepMinutes: 95,
    lightSleepMinutes: 255,
    awakeMinutes: 25,
    sleepScore: 86,
    sleepEfficiency: 92,
    latencyMinutes: 12,
    wakeCount: 1,
    wakingMood: 'refreshed',
    preSleepHabits: [],
    recordSource: 'manual',
    kind: 'night',
    ...opts,
  };
}

describe('Phase 5: CBT-I 行为引擎、标签关联统计与 Backup v3 集成', () => {
  beforeEach(() => {
    storage.clear();
    resetInterventionStore();
  });

  it('CBT-I 建议不足 3 晚诚实提示样本不足，不编造诊断', () => {
    const profile = createDefaultProfile();
    const zero = computeCbtiPrescription([], profile);
    expect(zero.ready).toBe(false);
    expect(zero.neededNights).toBe(3);
    expect(zero.nudges).toHaveLength(0);

    const two = computeCbtiPrescription([mkNight('2026-10-19'), mkNight('2026-10-18')], profile);
    expect(two.ready).toBe(false);
    expect(two.neededNights).toBe(1);
    expect(two.nudges).toHaveLength(0);
  });

  it('CBT-I 建议按真实入睡耗时/效率/作息波动给出对应微课推荐', () => {
    const profile = createDefaultProfile();
    const struggling: SleepRecord[] = [
      mkNight('2026-10-19', { bedtime: '23:00', latencyMinutes: 35, sleepEfficiency: 80, durationMinutes: 390 }),
      mkNight('2026-10-18', { bedtime: '01:30', latencyMinutes: 40, sleepEfficiency: 82, durationMinutes: 380 }),
      mkNight('2026-10-17', { bedtime: '22:30', latencyMinutes: 30, sleepEfficiency: 79, durationMinutes: 400 }),
    ];
    const rx = computeCbtiPrescription(struggling, profile);
    expect(rx.ready).toBe(true);
    expect(rx.sampleNights).toBe(3);
    expect(rx.nudges.some((n) => n.lessonId === 'stimulus-control')).toBe(true);
    expect(rx.nudges.some((n) => n.lessonId === 'sleep-efficiency')).toBe(true);

    const steady: SleepRecord[] = [
      mkNight('2026-10-19'),
      mkNight('2026-10-18'),
      mkNight('2026-10-17'),
      mkNight('2026-10-16'),
    ];
    const steadyRx = computeCbtiPrescription(steady, profile);
    expect(steadyRx.ready).toBe(true);
    expect(steadyRx.nudges[0].priority).toBe('steady');
  });

  it('标签关联分析严格执行 ≥5 晚门槛，达到门槛后精确计算评分/时长/潜伏期差值', () => {
    const custom = addCustomDiaryTag('热水泡脚', '🛁', 'positive')!;
    expect(custom).not.toBeNull();

    // 仅 4 晚带 custom 标签 → 必须留在 locked，绝不解锁
    const underThreshold: SleepRecord[] = [
      mkNight('2026-10-19', { sleepScore: 92, preSleepHabits: [custom.id] }),
      mkNight('2026-10-18', { sleepScore: 90, preSleepHabits: [custom.id] }),
      mkNight('2026-10-17', { sleepScore: 91, preSleepHabits: [custom.id] }),
      mkNight('2026-10-16', { sleepScore: 89, preSleepHabits: [custom.id] }),
      mkNight('2026-10-15', { sleepScore: 70, preSleepHabits: [] }),
      mkNight('2026-10-14', { sleepScore: 72, preSleepHabits: [] }),
      // 白天小睡不得计入夜睡样本数
      mkNight('2026-10-19', { id: 'nap', kind: 'nap', sleepScore: 95, preSleepHabits: [custom.id] }),
    ];
    const reportLocked = computeTagCorrelations(underThreshold, [custom]);
    expect(reportLocked.unlocked).toHaveLength(0);
    expect(reportLocked.locked).toHaveLength(1);
    expect(reportLocked.locked[0].taggedNights).toBe(4);
    expect(reportLocked.locked[0].neededNights).toBe(MIN_TAGGED_NIGHTS - 4);

    // 补齐第 5 晚 → 解锁精确差值
    const atThreshold: SleepRecord[] = [
      ...underThreshold,
      mkNight('2026-10-13', { sleepScore: 93, durationMinutes: 510, latencyMinutes: 8, preSleepHabits: [custom.id] }),
    ];
    const reportUnlocked = computeTagCorrelations(atThreshold, [custom]);
    expect(reportUnlocked.unlocked).toHaveLength(1);
    const item = reportUnlocked.unlocked[0];
    expect(item.id).toBe(custom.id);
    expect(item.taggedNights).toBe(5);
    expect(item.untaggedNights).toBe(2);
    expect(item.avgScoreWith).toBe(91);
    expect(item.avgScoreWithout).toBe(71);
    expect(item.scoreDelta).toBe(20);
  });

  it('interventionStore 状态自动纳入 Backup v3 切片并可完整恢复', () => {
    toggleLessonCompleted('stimulus-control');
    toggleRitualItem('phone_down');
    setPreferredBreathMode('box');
    const tag = addCustomDiaryTag('洋甘菊茶', '🍵', 'positive');
    expect(tag).not.toBeNull();

    const backup = buildFullBackup();
    expect(backup.schema).toBe(3);
    expect(backup.slices?.intervention).toBeTruthy();

    storage.clear();
    resetInterventionStore();
    expect(interventionStore.getState().completedLessonIds).toHaveLength(0);

    const restored = restoreFullBackup(backup);
    expect(restored.slices).toContain('intervention');
    hydrateInterventionStore();
    const state = interventionStore.getState();
    expect(state.completedLessonIds).toEqual(['stimulus-control']);
    expect(state.preferredBreathMode).toBe('box');
    expect(state.customTags).toHaveLength(1);
    expect(state.customTags[0].label).toBe('洋甘菊茶');

    removeCustomDiaryTag(state.customTags[0].id);
    expect(interventionStore.getState().customTags).toHaveLength(0);
  });
});
