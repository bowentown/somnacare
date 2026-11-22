import { describe, it, expect } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { sanitizeRecord } from '../../src/features/sleep/utils/recordSanitize';
import { mergeRecord, isNap, isNight, deriveKind } from '../../src/features/sleep/utils/recordFilter';
import { computeRegularity } from '../../src/features/sleep/utils/sleepRegularity';

installMemoryStorage();

const rec = (id: string, date: string, kind?: 'nap' | 'night', dur = 480): any => ({
  id,
  date,
  kind,
  bedtime: kind === 'nap' ? '13:00' : '23:00',
  wakeTime: kind === 'nap' ? '14:00' : '07:00',
  durationMinutes: dur,
  sleepScore: 80,
  deepSleepMinutes: 90,
  lightSleepMinutes: 300,
  remSleepMinutes: 80,
  awakeMinutes: 10,
  sleepEfficiency: 90,
  latencyMinutes: 10,
  wakeCount: 1,
  wakingMood: 'refreshed',
  preSleepHabits: [],
  stages: [],
});

describe('夜睡/小睡分类模型与编辑幂等合并', () => {
  it('sanitizeRecord：保留 nap、省略 night、严格校验真实日历日', () => {
    expect(sanitizeRecord(rec('a', '2026-10-01', 'nap'))?.kind).toBe('nap');
    expect(JSON.stringify(sanitizeRecord(rec('b', '2026-10-01')))).not.toContain('kind');
    expect(JSON.stringify(sanitizeRecord(rec('c', '2026-10-01', 'night')))).not.toContain('kind');

    expect(sanitizeRecord(rec('d', '2025-02-30'))).toBeNull();
    expect(sanitizeRecord(rec('e', '2025-99-99'))).toBeNull();
    expect(sanitizeRecord(rec('f', '2024-02-29'))?.date).toBe('2024-02-29');
    expect(sanitizeRecord(rec('g', '2025-02-29'))).toBeNull();
  });

  it('mergeRecord：夜睡与小睡互不删除、同日夜睡幂等替换', () => {
    const night = rec('n1', '2026-10-03');
    const nap = rec('nap1', '2026-10-03', 'nap', 53);
    const nap2 = rec('nap2', '2026-10-03', 'nap', 30);

    const afterNap = mergeRecord([night], nap);
    expect(afterNap).toHaveLength(2);
    expect(isNap(afterNap.find((r) => r.id === 'nap1')!)).toBe(true);

    const afterNight = mergeRecord([nap], night);
    expect(afterNight).toHaveLength(2);
    expect(afterNight.some((r) => r.id === 'n1')).toBe(true);

    const twoNaps = mergeRecord(mergeRecord([night], nap), nap2);
    expect(twoNaps.filter(isNap)).toHaveLength(2);

    const night2 = rec('n2', '2026-10-03');
    expect(mergeRecord([night], night2).filter(isNight)).toHaveLength(1);

    // 编辑幂等：沿用原 id 保存同夜不产生重复夜睡
    const edited = { ...night, bedtime: '23:30', sleepScore: 92 };
    const afterEdit = mergeRecord([night, nap], edited);
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit.find((r) => r.id === 'n1')?.bedtime).toBe('23:30');
  });

  it('deriveKind × chronotype：窗口 [10:00, 20:00) 两沿与白昼/不规律作息策略', () => {
    expect(deriveKind(9, 'night')).toBe('night');
    expect(deriveKind(10, 'night')).toBe('nap');
    expect(deriveKind(11, 'night')).toBe('nap');
    expect(deriveKind(19, 'night')).toBe('nap');
    expect(deriveKind(20, 'night')).toBe('night');
    expect(deriveKind(23, 'night')).toBe('night');

    expect(deriveKind(11, 'day')).toBe('night');
    expect(deriveKind(14, 'day')).toBe('night');
    expect(deriveKind(18, 'day')).toBe('night');

    expect(deriveKind(13, 'irregular')).toBe('nap');
    expect(deriveKind(23, 'irregular')).toBe('night');
    expect(deriveKind(11)).toBe('nap');
  });

  it('分析层对小睡免疫，备份序列化保留 kind', () => {
    const nights = [rec('n1', '2026-10-01'), rec('n2', '2026-10-02'), rec('n3', '2026-10-03')];
    const withNap = [...nights, rec('nap1', '2026-10-03', 'nap', 53)];
    const a = computeRegularity(nights);
    const b = computeRegularity(withNap);
    expect(a?.score).toBe(b?.score);
    expect(a?.nights).toBe(3);

    const round = JSON.parse(JSON.stringify([rec('n1', '2026-10-03'), rec('nap1', '2026-10-03', 'nap', 53)]));
    expect(round[0].kind).toBeUndefined();
    expect(round[1].kind).toBe('nap');
  });
});
