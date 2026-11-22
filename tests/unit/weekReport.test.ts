import { describe, it, expect } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { summarizeWeek } from '../../src/features/trends/utils/weekSummary';
import { computeWeekReport, GOOD_NIGHT_THRESHOLD } from '../../src/features/trends/utils/weekReport';

installMemoryStorage();

const mkRec = (id: string, date: string, score = 80, dur = 480, kind?: 'nap'): any => ({
  id,
  date,
  kind,
  bedtime: kind === 'nap' ? '13:00' : '23:10',
  wakeTime: kind === 'nap' ? '14:00' : '07:10',
  durationMinutes: dur,
  sleepScore: score,
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

describe('周小结聚合（summarizeWeek）', () => {
  it('空列表与全小睡输入均不出 NaN / undefined', () => {
    const empty = summarizeWeek([]);
    expect(empty.nights).toBe(0);
    expect(empty.best).toBeNull();
    expect(empty.avgScore).toBeNull();
    expect(empty.avgDurationMin).toBeNull();
    expect(empty.avgDeepMin).toBeNull();

    const napsOnly = summarizeWeek([mkRec('k1', '2026-10-03', 49, 53, 'nap'), mkRec('k2', '2026-10-04', 52, 45, 'nap')]);
    expect(napsOnly.nights).toBe(0);
    expect(napsOnly.best).toBeNull();
    expect(napsOnly.avgScore).toBeNull();
    expect(napsOnly.napCount).toBe(2);
    expect(napsOnly.napMinutes).toBe(98);
  });

  it('混合与多夜输入：聚合仅来自夜睡且 best 为最高分夜', () => {
    const mixed = summarizeWeek([mkRec('n1', '2026-10-03', 100, 480), mkRec('k1', '2026-10-03', 49, 53, 'nap')]);
    expect(mixed.nights).toBe(1);
    expect(mixed.avgScore).toBe(100);
    expect(mixed.avgDurationMin).toBe(480);
    expect(mixed.best?.id).toBe('n1');

    const multi = summarizeWeek([
      mkRec('n1', '2026-10-01', 85, 480),
      mkRec('n2', '2026-10-02', 92, 480),
      mkRec('n3', '2026-10-03', 78, 480),
    ]);
    expect(multi.best?.id).toBe('n2');
    expect(multi.avgScore).toBe(Math.round((85 + 92 + 78) / 3));
  });
});

describe('周报与连续达标（computeWeekReport）', () => {
  const now = new Date(2026, 9, 15, 15, 0); // 2026-10-15 周四
  const dstr = (off: number): string => {
    const d = new Date(2026, 9, 15 + off);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('连胜、低分断签、1 晚宽限、连漏 2 晚断签与安全兜底', () => {
    expect(GOOD_NIGHT_THRESHOLD).toBe(80);

    const r1 = computeWeekReport([mkRec('1', dstr(-1), 90), mkRec('2', dstr(-2), 88), mkRec('3', dstr(-3), 86)], now);
    expect(r1.streak).toBe(3);
    expect(r1.graceUsed).toBe(false);
    expect(r1.avgScore).toBe(88);
    expect(r1.best?.date).toBe(dstr(-1));
    expect(r1.elapsedNights).toBe(3);
    expect(r1.goodNights).toBe(3);

    expect(computeWeekReport([mkRec('1', dstr(-1), 90), mkRec('2', dstr(-2), 60), mkRec('3', dstr(-3), 92)], now).streak).toBe(1);

    const r3 = computeWeekReport([mkRec('2', dstr(-2), 90), mkRec('3', dstr(-3), 88)], now);
    expect(r3.streak).toBe(2);
    expect(r3.graceUsed).toBe(true);

    expect(computeWeekReport([mkRec('3', dstr(-3), 90), mkRec('4', dstr(-4), 88)], now).streak).toBe(0);
    expect(computeWeekReport([mkRec('2', dstr(-2), 60), mkRec('3', dstr(-3), 92)], now).streak).toBe(0);

    const napOnly = computeWeekReport([mkRec('n', dstr(-1), 90, 40, 'nap')], now);
    expect(napOnly.nights).toBe(0);
    expect(napOnly.avgScore).toBeNull();
    expect(napOnly.streak).toBe(0);
    expect(napOnly.best).toBeNull();

    const empty = computeWeekReport([], now);
    expect(empty.nights).toBe(0);
    expect(empty.streak).toBe(0);
    expect(empty.graceUsed).toBe(false);
  });
});
