import { beforeEach, describe, expect, it } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { createDefaultProfile } from '../../src/shared/store/profileStore';
import type { SleepRecord } from '../../src/shared/types/sleep';
import { computeCbtiPrescription } from '../../src/features/intervention/utils/cbtiEngine';
import {
  hydrateInterventionStore,
  interventionStore,
  resetInterventionStore,
  setPreferredBreathMode,
  toggleLessonCompleted,
  toggleRitualItem,
} from '../../src/features/intervention/store/interventionStore';
import { normalizeExcludedPkgs } from '../../src/features/extensions/ad-skip/adSkip';
import {
  DEFAULT_PET_STIMULUS_GUARD,
  getPetStimulusGuard,
  sanitizePetStimulusGuard,
  savePetStimulusGuard,
} from '../../src/features/pet/utils/petOverlay';
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

describe('Phase 5 & 6: CBT-I 行为引擎、广告排除归一化、深夜刷屏轻提醒与 Backup v3', () => {
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

  it('广告跳过排除名单去重清洗 + 深夜高刺激刷屏超时配置校验与回退', () => {
    expect(normalizeExcludedPkgs([' com.cmbchina.ccd.pluto.cmbActivity ', '', 'com.cmbchina.ccd.pluto.cmbActivity', 123])).toEqual([
      'com.cmbchina.ccd.pluto.cmbActivity',
    ]);
    expect(normalizeExcludedPkgs(null)).toEqual([]);

    // 缺省返回默认 20 分钟 + 6 款常见高刺激应用
    const def = getPetStimulusGuard();
    expect(def.enabled).toBe(true);
    expect(def.thresholdMin).toBe(20);
    expect(def.pkgs).toEqual(DEFAULT_PET_STIMULUS_GUARD.pkgs);

    // 非法阈值自动回退到 20，包名自动去重裁剪
    const cleaned = sanitizePetStimulusGuard({
      enabled: false,
      thresholdMin: 99,
      pkgs: [' tv.danmaku.bili ', 'tv.danmaku.bili', ''],
    });
    expect(cleaned.enabled).toBe(false);
    expect(cleaned.thresholdMin).toBe(20);
    expect(cleaned.pkgs).toEqual(['tv.danmaku.bili']);
  });

  it('interventionStore 与深夜刷屏提醒配置自动纳入 Backup v3 切片并可完整恢复', async () => {
    toggleLessonCompleted('stimulus-control');
    toggleRitualItem('phone_down');
    setPreferredBreathMode('box');
    await savePetStimulusGuard({
      enabled: true,
      thresholdMin: 15,
      pkgs: ['com.ss.android.ugc.aweme', 'com.xingin.xhs'],
    });

    const backup = buildFullBackup();
    expect(backup.schema).toBe(3);
    expect(backup.slices?.intervention).toBeTruthy();
    expect(backup.slices?.petStimulusGuard).toEqual({
      enabled: true,
      thresholdMin: 15,
      pkgs: ['com.ss.android.ugc.aweme', 'com.xingin.xhs'],
    });

    storage.clear();
    resetInterventionStore();
    expect(interventionStore.getState().completedLessonIds).toHaveLength(0);
    expect(getPetStimulusGuard().thresholdMin).toBe(20);

    const restored = restoreFullBackup(backup);
    expect(restored.slices).toContain('intervention');
    expect(restored.slices).toContain('petStimulusGuard');
    hydrateInterventionStore();
    const state = interventionStore.getState();
    expect(state.completedLessonIds).toEqual(['stimulus-control']);
    expect(state.preferredBreathMode).toBe('box');
    expect(getPetStimulusGuard()).toEqual({
      enabled: true,
      thresholdMin: 15,
      pkgs: ['com.ss.android.ugc.aweme', 'com.xingin.xhs'],
    });
  });
});
