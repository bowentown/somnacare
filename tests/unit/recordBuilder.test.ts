import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecordFromWindow } from '../../src/features/sleep/utils/recordBuilder';
import { sanitizeRecord } from '../../src/features/sleep/utils/recordSanitize';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const golden: Record<string, any> = JSON.parse(
  readFileSync(join(ROOT, 'tools/fixtures/record-builder-golden.json'), 'utf-8'),
);

const inputs: Record<string, { sleepStartMs: number; wakeMs: number; targetDurationHours: number }> = {
  normal8h: { sleepStartMs: new Date(2026, 9, 1, 23, 0).getTime(), wakeMs: new Date(2026, 9, 2, 7, 0).getTime(), targetDurationHours: 8 },
  micro45m: { sleepStartMs: new Date(2026, 9, 2, 1, 0).getTime(), wakeMs: new Date(2026, 9, 2, 1, 45).getTime(), targetDurationHours: 8 },
  tiny12m: { sleepStartMs: new Date(2026, 9, 2, 2, 0).getTime(), wakeMs: new Date(2026, 9, 2, 2, 12).getTime(), targetDurationHours: 8 },
  m14: { sleepStartMs: new Date(2026, 9, 2, 2, 0).getTime(), wakeMs: new Date(2026, 9, 2, 2, 14).getTime(), targetDurationHours: 8 },
  exact960m: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 1, 16, 0).getTime(), targetDurationHours: 8 },
  m961: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 1, 16, 0).getTime() + 60000, targetDurationHours: 8 },
  m3000: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 3, 2, 0).getTime(), targetDurationHours: 8 },
  crossMidnight: { sleepStartMs: new Date(2026, 9, 1, 23, 50).getTime(), wakeMs: new Date(2026, 9, 2, 0, 10).getTime(), targetDurationHours: 8 },
};

const COMPARE_FIELDS = [
  'date', 'bedtime', 'wakeTime', 'durationMinutes', 'deepSleepMinutes',
  'lightSleepMinutes', 'remSleepMinutes', 'awakeMinutes', 'sleepScore',
  'sleepEfficiency', 'latencyMinutes', 'latencyEstimated', 'wakeCount', 'wakingMood',
] as const;

describe('recordBuilder 黄金样本与 sanitizeRecord 分期不变式', () => {
  for (const [key, input] of Object.entries(inputs)) {
    it(`黄金样本 ${key} 逐字段与边界一致`, () => {
      const gold = golden[key];
      const built = buildRecordFromWindow({ ...input, id: gold.record.id });
      const g = gold.record;

      for (const f of COMPARE_FIELDS) {
        expect((built.record as any)[f], `${key}.${f}`).toEqual(g[f]);
      }
      expect(built.record.stages).toEqual(g.stages);
      expect(built.truncated).toBe(gold.truncated);

      if (key === 'm961' || key === 'm3000') {
        expect(built.record.durationMinutes).toBeLessThanOrEqual(960);
        expect(built.truncated).toBe(true);
      }
      if (key === 'exact960m') {
        expect(built.truncated).toBe(false);
      }
      const stageSum = (built.record.stages ?? []).reduce((a, s) => a + s.durationMinutes, 0);
      expect(stageSum).toBe(built.record.durationMinutes + built.record.awakeMinutes);
    });
  }

  it('sanitizeRecord：合法分期零缩水，畸形分期收口且 awake 不被缩放', () => {
    const legal = sanitizeRecord({
      id: 'x', date: '2026-10-20', bedtime: '23:00', wakeTime: '06:30',
      durationMinutes: 450, deepSleepMinutes: 90, lightSleepMinutes: 270, remSleepMinutes: 90, awakeMinutes: 30,
    });
    expect(legal).not.toBeNull();
    expect(legal!.deepSleepMinutes).toBe(90);
    expect(legal!.lightSleepMinutes).toBe(270);
    expect(legal!.remSleepMinutes).toBe(90);
    expect(legal!.awakeMinutes).toBe(30);

    const bloated = sanitizeRecord({
      id: 'y', date: '2026-10-20', bedtime: '23:00', wakeTime: '06:30',
      durationMinutes: 450, deepSleepMinutes: 450, lightSleepMinutes: 450, remSleepMinutes: 450, awakeMinutes: 200,
    });
    expect(bloated).not.toBeNull();
    expect(bloated!.deepSleepMinutes + bloated!.lightSleepMinutes + bloated!.remSleepMinutes).toBe(450);
    expect(bloated!.awakeMinutes).toBe(200);
  });

  it('短窗（1/2/40 分）潜伏期钳制与上午小睡自然日键', () => {
    const wakeMs = new Date(2026, 10, 7, 11, 10).getTime();
    const mk = (dur: number, latency?: number) =>
      buildRecordFromWindow({
        id: 't' + dur + (latency ?? ''),
        sleepStartMs: wakeMs - dur * 60000,
        wakeMs,
        targetDurationHours: 8,
        ...(latency !== undefined ? { userLatencyMinutes: latency } : {}),
        chronotype: 'night',
      }).record;

    const sum = (r: ReturnType<typeof mk>) =>
      r.deepSleepMinutes + r.lightSleepMinutes + r.remSleepMinutes + r.awakeMinutes;
    expect(sum(mk(1))).toBe(1);
    expect(sum(mk(2))).toBe(2);

    const r40 = mk(40, 60);
    expect(r40.latencyMinutes).toBe(39);
    expect(r40.awakeMinutes).toBe(39);
    expect(r40.stages![0].durationMinutes).toBe(39);

    const rNap = mk(40);
    expect(rNap.date).toBe('2026-11-07');
    expect(rNap.kind).toBe('nap');
  });
});
