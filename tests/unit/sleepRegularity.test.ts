import { describe, it, expect } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { computeRegularity, computeSRI, sleepIntervalsOf, buildSleepDayVectors } from '../../src/features/sleep/utils/sleepRegularity';
import { computeSleepNeed, computeMSFsc, computeSleepDebt, computeSleepDebtRatio } from '../../src/features/sleep/utils/sleepScore';
import { computeSuggestedSchedule } from '../../src/features/sleep/utils/scheduleSuggestion';
import { nightKeyOfBed } from '../../src/shared/utils/dateUtils';
import { reclassifyForChronotype } from '../../src/features/sleep/utils/recordFilter';

installMemoryStorage();

const rec = (bedtime: string, wakeTime: string, i: number) =>
  ({
    id: 'r' + i,
    date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    bedtime,
    wakeTime,
    durationMinutes: 420,
    sleepScore: 80,
    deepSleepMinutes: 90,
    remSleepMinutes: 90,
    lightSleepMinutes: 240,
    awakeMinutes: 0,
    latencyMinutes: 10,
    sleepEfficiency: 90,
    wakeCount: 1,
    wakingMood: 'refreshed' as const,
    preSleepHabits: [],
  });

describe('规律度 / SRI / 个人需求 / MSFsc / 睡债 / 科学作息建议', () => {
  it('computeRegularity：跨午夜、不足 3 晚、满分与波动档位', () => {
    const cross = computeRegularity([rec('23:50', '07:00', 1), rec('00:10', '07:05', 2), rec('00:00', '07:00', 3)]);
    expect(cross?.bedDev).toBe(7);

    expect(computeRegularity([rec('23:00', '07:00', 1), rec('23:30', '07:10', 2)])).toBeNull();
    expect(computeRegularity([])).toBeNull();

    const steady = computeRegularity(Array.from({ length: 7 }, (_, i) => rec('23:00', '07:00', i)));
    expect(steady?.bedDev).toBe(0);
    expect(steady?.wakeDev).toBe(0);
    expect(steady?.score).toBe(100);

    const wave = computeRegularity([
      rec('22:00', '07:00', 1),
      rec('01:30', '07:00', 2),
      rec('00:10', '07:00', 3),
      rec('22:00', '07:00', 4),
      rec('01:30', '07:00', 5),
      rec('00:10', '07:00', 6),
      rec('00:10', '07:00', 7),
    ]);
    expect(wave?.bedDev).toBe(66);
    expect(wave?.score).toBe(71);
  });

  it('圆周统计位置无关性与真双峰防洗白', () => {
    const dayCross = [
      rec('11:50', '19:50', 1),
      rec('11:55', '19:55', 2),
      rec('12:00', '20:00', 3),
      rec('12:05', '20:05', 4),
      rec('11:50', '19:50', 5),
      rec('11:55', '19:55', 6),
      rec('12:00', '20:00', 7),
    ];
    expect(computeRegularity(dayCross)!.score).toBeGreaterThanOrEqual(90);

    const wakeCross = [
      rec('23:30', '23:30', 1),
      rec('23:30', '00:15', 2),
      rec('23:30', '23:50', 3),
      rec('23:30', '00:30', 4),
      rec('23:30', '23:30', 5),
      rec('23:30', '00:15', 6),
      rec('23:30', '23:50', 7),
    ];
    expect(computeRegularity(wakeCross)!.score).toBeGreaterThanOrEqual(80);

    const night = [0, 1, 2, 3, 4, 5, 6].map((i) => rec(i % 2 === 0 ? '23:30' : '00:30', '07:30', i));
    const day = [0, 1, 2, 3, 4, 5, 6].map((i) => rec(i % 2 === 0 ? '11:30' : '12:30', '19:30', i));
    expect(Math.abs(computeRegularity(night)!.score - computeRegularity(day)!.score)).toBeLessThanOrEqual(3);

    const bimodal = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      i % 2 === 0 ? rec('23:00', '07:00', i) : rec('11:00', '19:00', i),
    );
    expect(computeRegularity(bimodal)!.score).toBe(0);
  });

  it('真 SRI（Fischer 2021 口径）与日向量观测掩码', () => {
    const NOW = new Date(2026, 10, 15);
    const mkDate = (i: number): string => {
      const d = new Date(2026, 10, 2 + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const mkNight = (i: number, bed: string, wake: string, dur = 480) => ({
      ...rec(bed, wake, i),
      id: 's' + i,
      date: mkDate(i),
      durationMinutes: dur,
      sleepScore: 85,
      stages: [],
    });

    const roundTripRecs = [mkNight(0, '23:00', '07:00'), mkNight(2, '00:20', '08:20'), mkNight(4, '01:30', '09:30')];
    const iv = sleepIntervalsOf(roundTripRecs, 'night');
    expect(iv.every((x, i) => nightKeyOfBed(x.start) === roundTripRecs[i].date)).toBe(true);

    const ivDay = sleepIntervalsOf([{ ...roundTripRecs[0], bedtime: '08:00', wakeTime: '16:00' }], 'day');
    expect(new Date(ivDay[0].start).getDate()).toBe(2);

    const steady7 = Array.from({ length: 7 }, (_, i) => mkNight(i, '23:00', '07:00'));
    const sSteady = computeSRI(steady7, 'night', NOW, 14);
    expect(sSteady?.sri).toBe(100);
    expect(sSteady?.pairs).toBe(7);

    const alt7 = Array.from({ length: 7 }, (_, i) => (i % 2 === 0 ? mkNight(i, '10:00', '22:00') : mkNight(i, '22:00', '10:00')));
    expect(computeSRI(alt7, 'night', NOW, 14)!.sri).toBeLessThanOrEqual(10);

    const withFixedNap = Array.from({ length: 7 }, (_, i) => [
      mkNight(i, '23:00', '07:00'),
      { ...mkNight(i, '13:00', '13:30', 30), kind: 'nap' as const },
    ]).flat();
    expect(computeSRI(withFixedNap, 'night', NOW, 14)?.sri).toBe(100);

    expect(computeSRI(steady7.slice(0, 3), 'night', NOW, 14)).toBeNull();

    const napIv = sleepIntervalsOf([{ ...mkNight(5, '10:30', '11:10', 40), date: '2026-11-07', kind: 'nap' as const }], 'night')[0];
    expect(new Date(napIv.start).getDate()).toBe(7);
    expect(new Date(napIv.start).getHours()).toBe(10);

    const zeroIv = sleepIntervalsOf([{ ...mkNight(5, '23:00', '23:00'), date: '2026-11-07' }], 'night')[0];
    expect(zeroIv.end - zeroIv.start).toBe(60000);

    const vecs = buildSleepDayVectors(steady7, 'night', NOW, 14);
    const first = vecs.find((v) => v.dateKey === mkDate(0))!;
    expect(first.obsMask![0]).toBe(0);
    expect(first.obsMask![1380]).toBe(1);
    expect(first.asleep![1380]).toBe(1);
    expect(vecs.filter((v) => !v.observed).length).toBe(6);
  });

  it('个人睡眠需求 / MSFsc / 睡债 / 昼转夜 / 科学作息建议', () => {
    const NOW = new Date(2026, 10, 15);
    const mkDate = (i: number): string => {
      const d = new Date(2026, 10, 2 + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const mkN = (i: number, dur: number, bed = '23:00', wake = '07:00') => ({
      ...rec(bed, wake, i),
      id: 'n' + i,
      date: mkDate(i),
      durationMinutes: dur,
      sleepScore: 85,
    });

    const need8 = computeSleepNeed(Array.from({ length: 8 }, (_, i) => mkN(i, 360)), 480, 'night', NOW, 14);
    expect(need8.needMinutes).toBe(360);
    expect(need8.basis).toBe('personal');
    expect(computeSleepNeed([mkN(0, 360), mkN(1, 360)], 480, 'night', NOW, 14).basis).toBe('fallback');
    const mix8 = Array.from({ length: 4 }, (_, i) => mkN(i, 360)).concat(Array.from({ length: 4 }, (_, i) => mkN(6 + i, 480)));
    expect(computeSleepNeed(mix8, 480, 'night', NOW, 14).needMinutes).toBe(420);

    const msfRecs = [4, 5, 11, 12]
      .map((i) => mkN(i, 540, '00:00', '09:00'))
      .concat([-1, 0, 1, 2, 3].map((i) => mkN(i, 420, '23:00', '07:00')));
    const msf = computeMSFsc(msfRecs, 'night', NOW, 28);
    expect(msf?.label).toBe('05:00');
    expect(msf?.freeSamples).toBe(4);
    expect(computeMSFsc(msfRecs.slice(2), 'night', NOW, 28)).toBeNull();

    const sixFree = [4, 5, 11, 12, 18, 19]
      .map((i) => mkN(i, 540, '00:00', '09:00'))
      .concat([-1, 0, 1, 2, 3].map((i) => mkN(i, 420, '23:00', '07:00')));
    expect(computeMSFsc(sixFree, 'night', NOW, 28)?.label).toBe('05:00');

    const crossRecs = [
      { ...mkN(0, 420, '02:30', '10:30'), date: '2026-11-06' },
      { ...mkN(1, 420, '02:30', '10:30'), date: '2026-10-30' },
      { ...mkN(2, 420, '23:50', '06:10'), date: '2026-11-13' },
      { ...mkN(3, 420, '23:50', '06:10'), date: '2026-11-07' },
      ...[2, 3, 4, 5, 9, 10, 11, 12].map((d) => ({ ...mkN(d, 420, '23:00', '07:00'), date: `2026-11-${String(d).padStart(2, '0')}` })),
    ];
    const cross = computeMSFsc(crossRecs, 'night', NOW, 28);
    expect(cross).not.toBeNull();
    expect(cross!.msfMinutes >= 1320 || cross!.msfMinutes <= 420).toBe(true);

    const debtRecs = [240, 240, 240, 420, 420, 420, 420].map((d, i) => mkN(i, d));
    expect(computeSleepDebt(debtRecs, 420, 'night', NOW, 14).debtMinutes).toBe(540);
    expect(computeSleepDebt(Array.from({ length: 7 }, (_, i) => mkN(i, 420)), 420, 'night', NOW, 14).debtMinutes).toBe(0);

    const stale = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'].map((d, i) => ({
      ...mkN(i, 300),
      date: d,
    }));
    expect(computeSleepDebtRatio(stale, 480, 7)).toBe(0.4);

    const dayToNight = reclassifyForChronotype(
      [
        { ...mkN(1, 480, '23:00', '07:00'), date: '2026-11-06', kind: 'night' as const },
        { ...mkN(2, 480, '02:00', '10:00'), date: '2026-11-06', kind: 'night' as const },
      ],
      'night',
    );
    expect(dayToNight[0].date).toBe('2026-11-06');
    expect(dayToNight[1].date).toBe('2026-11-05');

    const cur = { bed: '23:30', wake: '07:30', durationHours: 8 };
    expect(computeSuggestedSchedule(480, 390, cur)).toMatchObject({ bed: '01:00', wake: '09:00', durationHours: 8, basis: 'msf' });
    expect(computeSuggestedSchedule(475, 390, cur)?.durationHours).toBe(8);
    expect(computeSuggestedSchedule(480, null, cur)).toBeNull();
    expect(computeSuggestedSchedule(450, null, cur)).toMatchObject({ bed: '23:30', wake: '07:00', durationHours: 7.5, basis: 'need' });
    expect(computeSuggestedSchedule(600, 330, cur)).toMatchObject({ bed: '00:30', wake: '10:30' });
    expect(computeSuggestedSchedule(480, 900, cur)).toMatchObject({ bed: '21:00', wake: '05:00' });
  });
});
