import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMemoryStorage } from './_helpers';
import { buildSleepFacts } from '../../src/features/pet/utils/sleepFacts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const storage = installMemoryStorage();

const mk = (date: string, score: number): any => ({
  id: 'r-' + date,
  date,
  bedtime: '23:10',
  wakeTime: '07:10',
  durationMinutes: 470,
  deepSleepMinutes: 95,
  lightSleepMinutes: 300,
  remSleepMinutes: 75,
  awakeMinutes: 10,
  sleepScore: score,
  sleepEfficiency: 92,
  latencyMinutes: 10,
  wakeCount: 1,
  wakingMood: 'refreshed',
  preSleepHabits: [],
});

describe('朋友圈事实串生产/消费契约（buildSleepFacts ↔ MomentsOverlay）', () => {
  beforeEach(() => storage.clear());

  it('周日计算排除今晚与上周记录，产出与 MomentsOverlay 正则完全匹配的事实串', () => {
    const overlaySrc = readFileSync(join(ROOT, 'src/features/pet/MomentsOverlay.tsx'), 'utf-8');
    const consumerRegexes: RegExp[] = [];
    for (const m of overlaySrc.matchAll(/f\.match\((\/.+?\/[a-z]*)\)/g)) {
      const lastSlash = m[1].lastIndexOf('/');
      consumerRegexes.push(new RegExp(m[1].slice(1, lastSlash), m[1].slice(lastSlash + 1)));
    }
    expect(consumerRegexes.length).toBeGreaterThanOrEqual(3);

    const now = new Date(2026, 9, 4, 15, 8); // 2026-10-04 周日
    const facts = buildSleepFacts(
      [mk('2026-10-04', 60), mk('2026-10-03', 100), mk('2026-09-25', 90)],
      { targetBedtime: '23:30' } as any,
      now,
    );

    const weekElapsed = facts.find((f) => f.includes('本周已过'));
    const weekRec = facts.find((f) => f.includes('本周有记录'));
    const weekSlots = facts.find((f) => f.includes('本周逐夜'));

    expect(weekElapsed).toBe('本周已过 6 天，达标 1 天');
    expect(weekRec).toBe('本周有记录 1 天，未记录 5 天');
    expect(weekSlots).toBe('本周逐夜 000002-');

    let parsedGood: string | null = null;
    let parsedRec: string | null = null;
    let parsedMissed: string | null = null;
    for (const re of consumerRegexes) {
      const m1 = (weekElapsed ?? '').match(re);
      if (m1 && m1.length >= 3) parsedGood = m1[2];
      const m2 = (weekRec ?? '').match(re);
      if (m2 && m2.length >= 3) {
        parsedRec = m2[1];
        parsedMissed = m2[2];
      }
    }
    expect(parsedGood).toBe('1');
    expect(parsedRec).toBe('1');
    expect(parsedMissed).toBe('5');

    // 无记录不产出空战报
    const emptyFacts = buildSleepFacts([], { targetBedtime: '23:30' } as any, now);
    expect(emptyFacts.some((f) => f.includes('本周已过'))).toBe(false);
  });
});
