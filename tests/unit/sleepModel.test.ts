import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { fitSleepModel, modelWindowStart } from '../../src/features/sleep/utils/sleepModel';
import { computeModelProposal } from '../../src/features/sleep/utils/proposal';
import { circularMedian, clockMinutes } from '../../src/shared/utils/clockMath';

const storage = installMemoryStorage();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

const AWAKE_RATE = 4.6;
const SLEEP_RATE = 0.046;

interface SimOptions {
  wsHour: number;
  bedMin: number;
  wakeMin: number;
  now: number;
  mode?: 'normal' | 'allnighter' | 'uniform' | 'sparse';
  pickupTimesMin?: number[];
  seed?: number;
  lastNightBedMin?: number;
  lastNightWakeMin?: number;
}

function simulateEvents(o: SimOptions): { events: number[]; observedUntil: number } {
  const rng = mulberry32(o.seed ?? 20261003);
  const events: number[] = [];
  const now = o.now;
  const mode = o.mode ?? 'normal';
  const nd = new Date(now);
  let ws0 = new Date(nd.getFullYear(), nd.getMonth(), nd.getDate(), o.wsHour, 0, 0, 0).getTime();
  if (ws0 > now) ws0 -= 86400000;
  for (let i = 0; i < 14; i++) {
    const dayStart = ws0 - i * 86400000;
    const bedFor = i === 0 && o.lastNightBedMin !== undefined ? o.lastNightBedMin : o.bedMin;
    const wakeFor = i === 0 && o.lastNightWakeMin !== undefined ? o.lastNightWakeMin : o.wakeMin;
    const bedBin = Math.round((((bedFor - o.wsHour * 60) % 1440 + 1440) % 1440) / 15);
    const wakeBin = Math.round((((wakeFor - o.wsHour * 60) % 1440 + 1440) % 1440) / 15);
    const ob = Math.max(0, Math.min(96, Math.floor((now - dayStart) / 900000) + 1));
    for (let b = 0; b < ob; b++) {
      let rate: number;
      if (mode === 'uniform') rate = 1.0;
      else if (mode === 'allnighter') rate = AWAKE_RATE;
      else rate = b >= bedBin && b < wakeBin ? SLEEP_RATE : AWAKE_RATE;
      if (mode === 'sparse') rate = 0;
      const c = poisson(rng, rate * 0.25);
      for (let k = 0; k < c; k++) {
        events.push(dayStart + b * 900000 + Math.floor(rng() * 900000));
      }
    }
    if (mode === 'sparse') {
      for (let k = 0; k < 3; k++) {
        const t = dayStart + (12 + k) * 3600000;
        if (t <= now) events.push(t);
      }
    }
    for (const t of o.pickupTimesMin ?? []) {
      const pickup =
        dayStart + ((((t - o.wsHour * 60) % 1440) + 1440) % 1440) * 60000 + Math.floor(rng() * 120000);
      const bin = Math.floor((pickup - dayStart) / 900000);
      if (bin >= bedBin && bin < wakeBin && pickup <= now) events.push(pickup);
    }
  }
  return { events, observedUntil: now };
}

function atTime(h: number, m: number): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

function runNight(opts: Partial<SimOptions> & { now: number }) {
  return fitSleepModel({
    events: simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, ...opts }).events,
    observedUntil: opts.now,
    chronotype: 'night',
    habitBedMin: 23 * 60,
    habitWakeMin: 7 * 60,
    now: opts.now,
  });
}

describe('SensibleSleep 贝叶斯切换点模型', () => {
  beforeEach(() => storage.clear());

  describe('A 组：标准与边界场景应正确产出提议', () => {
    it('A1 标准 23:00–07:00 产出合理提议', () => {
      const r = runNight({ now: atTime(7, 0), seed: 11 });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(circularDiff(minutesOf(r.bedtime), 23 * 60)).toBeLessThanOrEqual(75);
      expect(circularDiff(minutesOf(r.wakeTime), 7 * 60)).toBeLessThanOrEqual(75);
      expect(minutesOf(r.wakeTime)).toBeLessThan(12 * 60);
    });

    it('A2 每晚起夜 1 次仍正确提议', () => {
      const r = runNight({ now: atTime(7, 30), pickupTimesMin: [2 * 60 + 30], seed: 22 });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(circularDiff(minutesOf(r.bedtime), 23 * 60)).toBeLessThanOrEqual(90);
    });

    it('A3–A5 早鸟 / 夜猫 / 日间作息全部命中', () => {
      const s3 = simulateEvents({ wsHour: 14, bedMin: 22 * 60, wakeMin: 6 * 60, now: atTime(6, 30), seed: 33 });
      const r3 = fitSleepModel({ ...s3, chronotype: 'night', habitBedMin: 22 * 60, habitWakeMin: 6 * 60, now: atTime(6, 30) });
      expect(r3.status).toBe('ok');
      if (r3.status === 'ok') {
        expect(circularDiff(minutesOf(r3.bedtime), 22 * 60)).toBeLessThanOrEqual(90);
        expect(circularDiff(minutesOf(r3.wakeTime), 6 * 60)).toBeLessThanOrEqual(75);
      }

      const s4 = simulateEvents({ wsHour: 18, bedMin: 2 * 60, wakeMin: 10 * 60, now: atTime(10, 30), seed: 44 });
      const r4 = fitSleepModel({ ...s4, chronotype: 'night', habitBedMin: 2 * 60, habitWakeMin: 10 * 60, now: atTime(10, 30) });
      expect(r4.status).toBe('ok');
      if (r4.status === 'ok') {
        expect(circularDiff(minutesOf(r4.bedtime), 2 * 60)).toBeLessThanOrEqual(120);
        expect(circularDiff(minutesOf(r4.wakeTime), 10 * 60)).toBeLessThanOrEqual(75);
      }

      const s5 = simulateEvents({ wsHour: 1, bedMin: 9 * 60, wakeMin: 17 * 60, now: atTime(17, 30), seed: 55 });
      const r5 = fitSleepModel({ ...s5, chronotype: 'day', habitBedMin: 9 * 60, habitWakeMin: 17 * 60, now: atTime(17, 30) });
      expect(r5.status).toBe('ok');
      if (r5.status === 'ok') {
        expect(circularDiff(minutesOf(r5.bedtime), 9 * 60)).toBeLessThanOrEqual(90);
        expect(circularDiff(minutesOf(r5.wakeTime), 17 * 60)).toBeLessThanOrEqual(75);
      }
    });

    it('A6–A12 傍晚/漂移/早起/短夜提议与凌晨起夜拒绝边界', () => {
      const r6 = runNight({ now: atTime(22, 0), seed: 66 });
      expect(r6.status).toBe('ok');
      const r7 = runNight({ now: atTime(16, 0), seed: 77 });
      expect(r7.status).toBe('ok');

      const r8 = runNight({ now: atTime(9, 30), seed: 88, lastNightBedMin: 90, lastNightWakeMin: 570 });
      expect(r8.status).toBe('ok');
      if (r8.status === 'ok') {
        expect(circularDiff(minutesOf(r8.bedtime), 90)).toBeLessThanOrEqual(75);
        expect(circularDiff(minutesOf(r8.bedtime), 23 * 60)).toBeGreaterThan(75);
      }

      const r9 = runNight({ now: atTime(5, 30), seed: 89, lastNightWakeMin: 5 * 60 + 20 });
      expect(r9.status).toBe('ok');
      if (r9.status === 'ok') {
        expect(circularDiff(minutesOf(r9.wakeTime), 5 * 60 + 20)).toBeLessThanOrEqual(60);
      }

      const r10 = runNight({ now: atTime(5, 30), seed: 90, lastNightBedMin: 0, lastNightWakeMin: 5 * 60 });
      expect(r10.status).toBe('ok');
      if (r10.status === 'ok') {
        expect(circularDiff(minutesOf(r10.bedtime), 0)).toBeLessThanOrEqual(60);
        expect(circularDiff(minutesOf(r10.wakeTime), 5 * 60)).toBeLessThanOrEqual(60);
      }

      const r11 = runNight({ now: atTime(3, 30), seed: 91 });
      expect(r11.status).toBe('rejected');

      const t4 = atTime(4, 0);
      const r12 = runNight({ now: t4, seed: 92 });
      expect(r12.status !== 'ok' || t4 - r12.wakeMs < 3600000).toBe(true);
    });
  });

  describe('B 组 & 反向自检：异常/低对比度/不足天数输入必须拒绝或标记 insufficient', () => {
    it('通宵、均匀、稀疏、退化与凌晨输入均不误提议', () => {
      expect(runNight({ now: atTime(7, 0), mode: 'allnighter', seed: 101 }).status).toBe('rejected');
      expect(runNight({ now: atTime(7, 0), mode: 'uniform', seed: 102 }).status).toBe('rejected');
      expect(runNight({ now: atTime(7, 0), mode: 'sparse', seed: 103 }).status).toBe('rejected');

      const nowB4 = atTime(7, 0);
      expect(
        fitSleepModel({
          events: [nowB4 - 3600000],
          observedUntil: nowB4,
          chronotype: 'night',
          habitBedMin: 23 * 60,
          habitWakeMin: 7 * 60,
          now: nowB4,
        }).status,
      ).toBe('insufficient');

      const t0 = nowB4 - 86400000;
      const events500 = Array.from({ length: 500 }, () => t0);
      expect(
        fitSleepModel({
          events: events500,
          observedUntil: nowB4,
          chronotype: 'night',
          habitBedMin: 23 * 60,
          habitWakeMin: 7 * 60,
          now: nowB4,
        }).status,
      ).not.toBe('ok');

      const normal13 = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now: nowB4, seed: 106 })
        .events.filter((e) => e < nowB4 - 86400000 + 900000);
      const mixed = fitSleepModel({
        events: [...normal13, ...events500],
        observedUntil: nowB4,
        chronotype: 'night',
        habitBedMin: 23 * 60,
        habitWakeMin: 7 * 60,
        now: nowB4,
      });
      if (mixed.status === 'ok') {
        const h = (mixed.wakeMs - mixed.bedtimeMs) / 3600000;
        expect(h).toBeGreaterThanOrEqual(3);
        expect(h).toBeLessThanOrEqual(14);
      }

      const fewNights = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now: nowB4, seed: 107 });
      const recent5 = fewNights.events.filter((e) => e >= nowB4 - 5 * 86400000);
      expect(
        fitSleepModel({
          events: recent5,
          observedUntil: nowB4,
          chronotype: 'night',
          habitBedMin: 23 * 60,
          habitWakeMin: 7 * 60,
          now: nowB4,
        }).status,
      ).toBe('insufficient');

      expect(runNight({ now: atTime(3, 0), seed: 108 }).status).toBe('rejected');
    });

    it('反向：错误作息窗口与低对比度数据必须被拒绝', () => {
      const sim = simulateEvents({ wsHour: 1, bedMin: 9 * 60, wakeMin: 17 * 60, now: atTime(17, 30), seed: 301 });
      const wrong = fitSleepModel({
        events: sim.events,
        observedUntil: sim.observedUntil,
        chronotype: 'night',
        habitBedMin: 23 * 60,
        habitWakeMin: 7 * 60,
        now: atTime(17, 30),
      });
      expect(wrong.status === 'ok' && circularDiff(minutesOf(wrong.bedtime), 9 * 60) <= 90).toBe(false);

      const rng = mulberry32(302);
      const evR2: number[] = [];
      const now7 = atTime(7, 0);
      const d = new Date(now7);
      let ws0 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 0, 0, 0).getTime();
      if (ws0 > now7) ws0 -= 86400000;
      for (let i = 0; i < 14; i++) {
        const dayStart = ws0 - i * 86400000;
        for (let b = 0; b < 96; b++) {
          const inSleep = b >= 32 && b < 64;
          const c = poisson(rng, (inSleep ? 1.0 : 4.6) * 0.25);
          for (let k = 0; k < c; k++) evR2.push(dayStart + b * 900000 + Math.floor(rng() * 900000));
        }
      }
      expect(
        fitSleepModel({
          events: evR2,
          observedUntil: now7,
          chronotype: 'night',
          habitBedMin: 23 * 60,
          habitWakeMin: 7 * 60,
          now: now7,
        }).status,
      ).toBe('rejected');
    });
  });

  describe('C/D/E 组：gate 链与作息散布窗口滚动死区回归', () => {
    it('C 组：computeModelProposal 闸门链全部生效', () => {
      const now = atTime(7, 0);
      const sim = simulateEvents({ wsHour: 15, bedMin: 23 * 60, wakeMin: 7 * 60, now, seed: 201 });
      const input = {
        events: sim.events,
        observedUntil: sim.observedUntil,
        chronotype: 'night' as const,
        records: [],
        sessionActive: false,
        handledDate: null as string | null,
        now: new Date(now),
      };
      const r1 = computeModelProposal(input);
      expect(r1.proposal).not.toBeNull();
      expect(r1.fallbackAllowed).toBe(false);

      const targetDate = r1.proposal!.targetDate;
      expect(computeModelProposal({ ...input, handledDate: targetDate }).proposal).toBeNull();
      expect(
        computeModelProposal({
          ...input,
          records: [{ id: 'x', date: targetDate, bedtime: '23:00', wakeTime: '07:00', kind: undefined } as any],
        }).proposal,
      ).toBeNull();
      expect(computeModelProposal({ ...input, sessionActive: true }).proposal).toBeNull();
      const r5 = computeModelProposal({ ...input, chronotype: 'irregular' });
      expect(r5.proposal).toBeNull();
      expect(r5.fallbackAllowed).toBe(false);
    });

    it('D/E 组：散布作息与窗口滚动后 3/12 分钟打开仍准确提议昨晚', () => {
      const NIGHTS = [
        { date: '2026-10-13', bed: '00:28', wake: '07:38' },
        { date: '2026-10-12', bed: '00:39', wake: '09:08' },
        { date: '2026-10-11', bed: '23:30', wake: '10:15' },
        { date: '2026-10-10', bed: '00:00', wake: '09:00' },
        { date: '2026-10-09', bed: '23:15', wake: '09:15' },
        { date: '2026-10-08', bed: '22:45', wake: '09:00' },
        { date: '2026-10-07', bed: '01:33', wake: '08:53' },
        { date: '2026-10-06', bed: '01:59', wake: '10:31' },
      ];
      const recs = NIGHTS.slice(1).map((n, i) => ({
        id: 'r' + i,
        date: n.date,
        bedtime: n.bed,
        wakeTime: n.wake,
        durationMinutes: 480,
        deepSleepMinutes: 120,
        lightSleepMinutes: 300,
        remSleepMinutes: 40,
        awakeMinutes: 10,
        sleepScore: 86,
        sleepEfficiency: 91,
        latencyMinutes: 12,
        wakeCount: 1,
      }));
      const genEvents = (nowMs: number): number[] => {
        const rng = mulberry32(7);
        const ev: number[] = [];
        const dayMs = 86400000;
        for (const n of NIGHTS) {
          const wakeAbs =
            new Date(n.date + 'T00:00:00').getTime() +
            Number(n.wake.slice(0, 2)) * 3600000 +
            Number(n.wake.slice(3)) * 60000;
          const bedAbs =
            wakeAbs -
            dayMs -
            (Number(n.wake.slice(0, 2)) * 3600000 + Number(n.wake.slice(3)) * 60000) +
            Number(n.bed.slice(0, 2)) * 3600000 +
            Number(n.bed.slice(3)) * 60000;
          for (let t = bedAbs - 90 * 60000; t < bedAbs; t += 7 * 60000) {
            if (t > nowMs) break;
            for (let k = 0; k < 3; k++) ev.push(t + Math.floor(rng() * 420000));
          }
          for (let t = bedAbs; t < wakeAbs; t += 45 * 60000) {
            if (t > nowMs) break;
            if (rng() < 0.25) ev.push(t);
          }
          const eveningEnd = Math.min(wakeAbs + 14 * 3600000, nowMs);
          for (let t = wakeAbs; t < eveningEnd; t += 7 * 60000) {
            for (let k = 0; k < 3; k++) ev.push(t + Math.floor(rng() * 420000));
          }
        }
        const now = new Date(nowMs);
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        for (let t = dayStart + 7 * 3600000; t < nowMs; t += 7 * 60000) {
          for (let k = 0; k < 3; k++) ev.push(t + Math.floor(rng() * 420000));
        }
        return ev.filter((t) => t <= nowMs);
      };

      const day0 = new Date(2026, 9, 14, 0, 0, 0, 0).getTime();
      const runAt = (nowMs: number) =>
        computeModelProposal({
          events: genEvents(nowMs),
          observedUntil: nowMs,
          chronotype: 'night',
          records: recs as any,
          now: new Date(nowMs),
          sessionActive: false,
          handledDate: null,
        });

      expect(runAt(day0 + 12 * 3600000 + 33 * 60000).proposal?.targetDate).toBe('2026-10-13');
      expect(runAt(day0 + 16 * 3600000 + 52 * 60000).proposal?.targetDate).toBe('2026-10-13');
      expect(runAt(day0 + 3 * 3600000 + 30 * 60000).proposal).toBeNull();

      const hbE = circularMedian(recs.map((r) => clockMinutes(r.bedtime)));
      const hwE = circularMedian(recs.map((r) => clockMinutes(r.wakeTime)));
      const rollAt = modelWindowStart(day0 + 12 * 3600000, 'night', hbE, hwE) + 86400000;
      expect(runAt(rollAt + 12 * 60000).proposal?.targetDate).toBe('2026-10-13');
      expect(runAt(rollAt + 3 * 60000).proposal?.targetDate).toBe('2026-10-13');
    });
  });
});
