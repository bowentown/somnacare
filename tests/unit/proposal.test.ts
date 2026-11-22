import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { computeProposal, computeProposalTraced, computeModelProposal } from '../../src/features/sleep/utils/proposal';
import { clockMinutes, shortArc } from '../../src/shared/utils/clockMath';

const storage = installMemoryStorage();

const dstr = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const rec = (date: string, bedtime: string): any => ({
  id: 'r' + date + bedtime,
  date,
  bedtime,
  wakeTime: '07:30',
  durationMinutes: 480,
  sleepScore: 80,
});

describe('提议引擎（启发式 + 模型集成）', () => {
  const TARGET = dstr(-1);
  const STALE_WAKE_DAY = dstr(0);
  const baseDay = { date: TARGET, lastActive: '00:20', firstActive: '07:35', nightPickups: 2 };
  const baseRecords = [rec(dstr(-2), '23:10'), rec(dstr(-3), '23:05'), rec(dstr(-4), '23:15')];

  beforeEach(() => storage.clear());

  it('基准提议、夜归属日期口径与窗口边界（4h–16h）', () => {
    const p = computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false });
    expect(p).not.toBeNull();
    expect(p!.targetDate).toBe(TARGET);
    expect(p!.targetDate).not.toBe(STALE_WAKE_DAY);
    expect(p!.bedtime).toBe('00:20');
    expect(p!.wakeTime).toBe('07:35');
    expect(p!.windowMinutes).toBe(435);
    expect(p!.confidence).toBe('high');

    const mk = (bed: string, wake: string) => [{ date: TARGET, lastActive: bed, firstActive: wake, nightPickups: 0 }];
    expect(computeProposal({ usageDays: mk('00:05', '04:05'), records: baseRecords, sessionActive: false })?.windowMinutes).toBe(240);
    expect(computeProposal({ usageDays: mk('00:06', '04:05'), records: baseRecords, sessionActive: false })).toBeNull();

    const lateHistory = [rec(dstr(-2), '19:30'), rec(dstr(-3), '19:25'), rec(dstr(-4), '19:35')];
    expect(computeProposal({ usageDays: mk('19:00', '11:00'), records: lateHistory, sessionActive: false })?.windowMinutes).toBe(960);
    expect(computeProposal({ usageDays: mk('19:00', '11:00'), records: baseRecords, sessionActive: false })).toBeNull();
    expect(computeProposal({ usageDays: mk('18:00', '11:01'), records: baseRecords, sessionActive: false })).toBeNull();
  });

  it('跨午夜历史必须采用圆周中位（线性中位会复现低置信 bug）', () => {
    const midnightHistory = [rec(dstr(-2), '23:40'), rec(dstr(-3), '00:30'), rec(dstr(-4), '00:20'), rec(dstr(-5), '23:50')];
    const p = computeProposal({
      usageDays: [{ date: TARGET, lastActive: '00:33', firstActive: '08:56', nightPickups: 1 }],
      records: midnightHistory,
      sessionActive: false,
    });
    expect(p).not.toBeNull();
    expect(p!.confidence).not.toBe('low');
    expect(p!.targetDate).toBe(TARGET);
    expect(p!.windowMinutes).toBe(503);

    const sorted = midnightHistory.map((r) => clockMinutes(r.bedtime)).sort((a, b) => a - b);
    const linearMed = (sorted[1] + sorted[2]) / 2;
    expect(shortArc(clockMinutes('00:33'), linearMed)).toBeGreaterThan(180);
  });

  it('轨迹可读性、降级矩阵、day 作息与 gate 4 小睡豁免', () => {
    expect(computeProposalTraced({ usageDays: [], records: [], sessionActive: false }).block).toContain('没有手机使用数据');
    expect(
      computeProposalTraced({
        usageDays: [{ date: TARGET, lastActive: '19:00', firstActive: '07:35', nightPickups: 0 }],
        records: baseRecords,
        sessionActive: false,
      }).block,
    ).toContain('置信');
    expect(computeProposalTraced({ usageDays: [baseDay], records: baseRecords, sessionActive: false }).block).toBe('');

    expect(computeProposal({ usageDays: [{ date: TARGET, lastActive: '00:20', firstActive: '', nightPickups: 0 }], records: baseRecords, sessionActive: false })).toBeNull();
    expect(computeProposal({ usageDays: [baseDay], records: [...baseRecords, rec(TARGET, '22:00')], sessionActive: false })).toBeNull();
    expect(computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: true })).toBeNull();
    expect(computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false, handledDate: TARGET })).toBeNull();
    expect(computeProposal({ usageDays: [baseDay], records: [], sessionActive: false })?.confidence).toBe('medium');
    expect(computeProposal({ usageDays: [{ date: TARGET, lastActive: '15:00', firstActive: '17:00', nightPickups: 0 }], records: baseRecords, sessionActive: false })).toBeNull();
    expect(computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false, chronotype: 'irregular' })).toBeNull();

    const dayUsage = [{ date: dstr(0), lastActive: '08:30', firstActive: '16:30', nightPickups: 1 }];
    const dayHistory = [rec(dstr(-1), '08:40'), rec(dstr(-2), '08:35'), rec(dstr(-3), '08:30')];
    const pd = computeProposal({ usageDays: dayUsage, records: dayHistory, sessionActive: false, chronotype: 'day' });
    expect(pd?.targetDate).toBe(dstr(0));
    expect(pd?.windowMinutes).toBe(480);
    expect(computeProposal({ usageDays: dayUsage, records: baseRecords, sessionActive: false })).toBeNull();

    const nap = { ...rec(TARGET, '13:00'), id: 'nap-1', kind: 'nap', wakeTime: '13:40' };
    expect(computeProposal({ usageDays: [baseDay], records: [...baseRecords, nap], sessionActive: false })?.targetDate).toBe(TARGET);
  });

  it('computeModelProposal：理想 14 夜、不足回退、已有记录拦截与晚睡先验失配放行回退', () => {
    const fixed = new Date();
    fixed.setHours(8, 30, 0, 0);
    const now = fixed.getTime();
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const evs: number[] = [];
    const day0 = new Date(now);
    day0.setHours(0, 0, 0, 0);
    for (let d = 15; d >= 1; d--) {
      const base = day0.getTime() - d * 86400000;
      for (let t = base + 7 * 3600e3 + 5 * 60e3; t < base + 23 * 3600e3 + 40 * 60e3; t += (8 + rnd() * 10) * 60e3) {
        evs.push(Math.round(t));
      }
    }
    for (let t = day0.getTime() + 7 * 3600e3 + 5 * 60e3; t <= now - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      evs.push(Math.round(t));
    }
    evs.sort((a, b) => a - b);

    const full = computeModelProposal({ events: evs, observedUntil: now, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: fixed });
    expect(full.proposal?.targetDate).toBe(TARGET);
    expect(full.fallbackAllowed).toBe(false);
    expect(full.fit?.status).toBe('ok');

    const few = computeModelProposal({ events: evs.slice(-120), observedUntil: now, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: fixed });
    expect(few.proposal).toBeNull();
    expect(few.fallbackAllowed).toBe(true);
    expect(few.fit?.status).toBe('insufficient');

    const taken = computeModelProposal({ events: evs, observedUntil: now, chronotype: 'night', records: [rec(TARGET, '22:00')], sessionActive: false, handledDate: null, now: fixed });
    expect(taken.proposal).toBeNull();
    expect(taken.fallbackAllowed).toBe(false);
    expect(taken.block).toContain('已有夜睡记录');

    const owlFixed = new Date();
    owlFixed.setHours(12, 0, 0, 0);
    const owlNow = owlFixed.getTime();
    let owlSeed = 7;
    const owlRnd = () => {
      owlSeed = (owlSeed * 1664525 + 1013904223) % 4294967296;
      return owlSeed / 4294967296;
    };
    const owlEvents: number[] = [];
    const owlDay0 = new Date(owlNow);
    owlDay0.setHours(0, 0, 0, 0);
    for (let d = 16; d >= 1; d--) {
      const base = owlDay0.getTime() - d * 86400000;
      for (let t = base + 10 * 3600e3 + 30 * 60e3; t < base + 26 * 3600e3 + 30 * 60e3; t += (8 + owlRnd() * 10) * 60e3) {
        owlEvents.push(Math.round(t));
      }
    }
    for (let t = owlDay0.getTime() + 10 * 3600e3 + 30 * 60e3; t <= owlNow - 10 * 60e3; t += (8 + owlRnd() * 10) * 60e3) {
      owlEvents.push(Math.round(t));
    }
    owlEvents.sort((a, b) => a - b);

    const owl = computeModelProposal({ events: owlEvents, observedUntil: owlNow, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: owlFixed });
    expect(owl.proposal).toBeNull();
    expect(owl.fallbackAllowed).toBe(true);
    expect(owl.fit?.status).toBe('rejected');
  });
});
