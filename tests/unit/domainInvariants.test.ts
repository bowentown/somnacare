import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { axisWindow } from '../../src/utils/clinicalSummaryCard';
import { buildSleepFacts } from '../../src/utils/sleepFacts';
import { buildPetSayLines } from '../../src/utils/petOverlay';
import { persistChatState } from '../../src/utils/chatStore';
import { fetchJsonWithTimeout } from '../../src/utils/fetchJson';
import { generateLocalClinicalAnalysis } from '../../src/utils/clinicalSleepEngine';

const storage = installMemoryStorage();

const mkRec = (date: string, score = 85): any => ({
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

describe('核心领域行为不变量（临床摘要轴 / 昨晚新鲜度 / 聊天配额 / 超时覆盖 / 零记录诚实）', () => {
  beforeEach(() => storage.clear());

  it('clinicalSummaryCard.axisWindow：夜/昼作息刻度全部落在轴内且窗口贴合数据 (<16h)', () => {
    const night = [
      { bedtime: '23:30', wakeTime: '07:30' },
      { bedtime: '23:50', wakeTime: '07:10' },
      { bedtime: '23:10', wakeTime: '07:40' },
    ];
    const day = [
      { bedtime: '08:30', wakeTime: '16:30' },
      { bedtime: '08:50', wakeTime: '16:10' },
      { bedtime: '08:10', wakeTime: '16:40' },
    ];
    const inWindow = (w: { rangeStart: number; rangeMin: number }, m: number) =>
      m >= w.rangeStart && m <= w.rangeStart + w.rangeMin;
    const clockOf = (m: number) => {
      const v = ((m % 1440) + 1440) % 1440;
      return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    };

    const wn = axisWindow(night, 23 * 60 + 30);
    const wd = axisWindow(day, 8 * 60 + 30);

    expect(wn.ticks.length).toBeGreaterThanOrEqual(3);
    expect(wn.ticks.every((t) => inWindow(wn, t.minute))).toBe(true);
    expect(wd.ticks.length).toBeGreaterThanOrEqual(3);
    expect(wd.ticks.every((t) => inWindow(wd, t.minute))).toBe(true);
    expect(wn.label).toBe(`${clockOf(wn.rangeStart)} — ${clockOf(wn.rangeStart + wn.rangeMin)}`);
    expect(wd.label).toBe(`${clockOf(wd.rangeStart)} — ${clockOf(wd.rangeStart + wd.rangeMin)}`);
    expect(wd.ticks.every((t) => t.label === clockOf(t.minute))).toBe(true);
    expect(wn.rangeMin).toBeLessThan(16 * 60);
    expect(wd.rangeMin).toBeLessThan(16 * 60);
  });

  it('昨晚新鲜度：停更 3 晚绝不冒充昨晚，date=昨天才播报昨晚时长/评分', () => {
    const now = new Date(2026, 9, 4, 15, 8);
    const staleFacts = buildSleepFacts([mkRec('2026-10-01')], { targetBedtime: '23:30' } as any, now);
    expect(staleFacts.some((f) => f.startsWith('昨晚睡眠'))).toBe(false);
    expect(staleFacts).toContain('昨晚没有睡眠记录');
    expect(staleFacts).toContain('最近一次夜睡记录停在 2 晚前');

    const freshFacts = buildSleepFacts([mkRec('2026-10-03')], { targetBedtime: '23:30' } as any, now);
    expect(freshFacts).toContain('昨晚睡眠时长 7 小时 50 分');
    expect(freshFacts).toContain('昨晚睡眠评分 85/100');

    const staleSay = buildPetSayLines([mkRec('2026-10-01')], { targetBedtime: '23:30' } as any, now);
    expect(staleSay.some((s) => s.includes('昨晚睡了'))).toBe(false);

    const freshSay = buildPetSayLines([mkRec('2026-10-03')], { targetBedtime: '23:30' } as any, now);
    expect(freshSay.some((s) => s.includes('昨晚睡了') && s.includes('85 分'))).toBe(true);
  });

  it('chatStore：配额满时如实返回 false（不再静默失败）', () => {
    const state = {
      sessions: [{ id: 's1', title: 't', createdAt: 1, updatedAt: 1, messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 'x' }] }],
      activeId: 's1',
    } as any;
    expect(persistChatState(state)).toBe(true);
    storage.setQuotaExceeded(true);
    expect(persistChatState(state)).toBe(false);
    storage.setQuotaExceeded(false);
  });

  it('fetchJsonWithTimeout：响应头到达后 body 卡住时，超时仍能中止并抛出 AbortError', async () => {
    const prevFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = (_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        });

      await expect(fetchJsonWithTimeout('https://example.test/hang', {}, 40)).rejects.toThrow(/Aborted|abort/i);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('generateLocalClinicalAnalysis：零记录不伪造高分或具体分期结论', () => {
    const emptyAnalysis = generateLocalClinicalAnalysis([], {
      name: '新用户',
      age: 30,
      targetBedtime: '23:30',
      targetWakeTime: '07:30',
      targetDurationHours: 8,
      smartAlarmEnabled: false,
      smartWakeWindowMinutes: 20,
      soundDetectionSensitivity: 'medium',
      brightnessLevel: 100,
      warmthFilter: false,
    });
    expect(emptyAnalysis.chronotype).toContain('待建立');
    expect(emptyAnalysis.scoreSummary).toContain('尚无');
  });
});
