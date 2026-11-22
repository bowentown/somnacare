import { describe, expect, it } from 'vitest';
import { buildWidgetSnapshot, toNativeWidgetPayload } from '../../src/features/widgets/widgetSnapshot';
import { createDefaultProfile } from '../../src/shared/store/profileStore';
import type { SleepRecord, UserProfile } from '../../src/shared/types/sleep';

function mkNight(date: string, score: number, durationMinutes: number, bedtime = '23:15', wakeTime = '07:15'): SleepRecord {
  return {
    id: `n-${date}`,
    date,
    bedtime,
    wakeTime,
    durationMinutes,
    deepSleepMinutes: Math.round(durationMinutes * 0.22),
    remSleepMinutes: Math.round(durationMinutes * 0.2),
    lightSleepMinutes: Math.round(durationMinutes * 0.52),
    awakeMinutes: Math.round(durationMinutes * 0.06),
    sleepScore: score,
    sleepEfficiency: 92,
    latencyMinutes: 12,
    wakeCount: 1,
    wakingMood: 'refreshed',
    preSleepHabits: [],
    recordSource: 'manual',
    kind: 'night',
  };
}

describe('WidgetSnapshot 桌面小组件统一快照计算', () => {
  const now = new Date(2026, 9, 20, 10, 0, 0); // 2026-10-20
  const profile: UserProfile = {
    ...createDefaultProfile(),
    themeColor: 'warm_amber',
    targetBedtime: '23:00',
    targetWakeTime: '07:00',
    targetDurationHours: 8,
  };

  it('零记录时诚实返回 null（绝不冒充 0 分或假 SRI），原生编码为 -1', () => {
    const snap = buildWidgetSnapshot([], profile, { currentEnergy: 0, targetEnergy: 200 }, now);
    expect(snap.lastScore).toBeNull();
    expect(snap.lastDurationMin).toBeNull();
    expect(snap.sriScore).toBeNull();
    expect(snap.sleepDebtMin).toBe(0);
    expect(snap.streakNights).toBe(0);
    expect(snap.weekDots).toHaveLength(7);
    expect(snap.weekDots.every((d) => d.status === 'N')).toBe(true);
    expect(snap.themeId).toBe('warm_amber');

    const payload = toNativeWidgetPayload(snap);
    expect(payload.lastScore).toBe(-1);
    expect(payload.lastDurationMin).toBe(-1);
    expect(payload.sriScore).toBe(-1);
    expect(payload.weekDots).toBe('N,N,N,N,N,N,N');
  });

  it('正确计算 7 晚顺序分档（G/Y/R/N）、睡眠债、连胜、SRI 与忽略小睡', () => {
    const records: SleepRecord[] = [
      mkNight('2026-10-19', 90, 480), // 昨 -> G, debt 0
      mkNight('2026-10-18', 84, 450), // -2 -> G, debt 30
      mkNight('2026-10-17', 72, 420), // -3 -> Y, debt 60
      mkNight('2026-10-16', 55, 360), // -4 -> R, debt 120
      mkNight('2026-10-15', 88, 490), // -5 -> G, debt 0
      // 2026-10-14 缺卡 -> N
      mkNight('2026-10-13', 82, 480), // -7 -> G, debt 0
      // 白天小睡不应污染夜睡评分与 7 晚分档
      { ...mkNight('2026-10-19', 40, 35, '13:30', '14:05'), id: 'nap-1', kind: 'nap' },
    ];

    const snap = buildWidgetSnapshot(records, profile, { currentEnergy: 150, targetEnergy: 200 }, now);
    expect(snap.lastScore).toBe(90);
    expect(snap.lastDurationMin).toBe(480);
    expect(snap.streakNights).toBe(2);
    expect(snap.sleepDebtMin).toBe(210); // 30 + 60 + 120
    expect(snap.sriScore).not.toBeNull();
    expect(snap.weekDots.map((d) => d.status)).toEqual(['G', 'N', 'G', 'R', 'Y', 'G', 'G']);
    expect(snap.weekDots[6].label).toBe('昨');
    expect(snap.petEnergyPct).toBe(75);
    expect(toNativeWidgetPayload(snap).weekDots).toBe('G,N,G,R,Y,G,G');
  });

  it('大肥鱼旅行能量百分比严格钳制在 0–100', () => {
    const over = buildWidgetSnapshot([], profile, { currentEnergy: 350, targetEnergy: 200 }, now);
    expect(over.petEnergyPct).toBe(100);
    const under = buildWidgetSnapshot([], profile, { currentEnergy: -10, targetEnergy: 200 }, now);
    expect(under.petEnergyPct).toBe(0);
  });
});
