import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { planWeeklyLayout, renderWeeklyCard, CARD_H, CARD_W } from '../../src/utils/sleepShareCard';

const storage = installMemoryStorage();

describe('分享卡布局边界与画布成品隐私', () => {
  beforeEach(() => storage.clear());

  it('四种开关组合全部落在 1080×1440 安全边距内且双栏不重叠', () => {
    const combos: [boolean, boolean][] = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    for (const [reg, dur] of combos) {
      const L = planWeeklyLayout(reg, dur);
      expect(L.maxY).toBeLessThanOrEqual(CARD_H - 40);
      expect(L.quoteTop).toBeLessThan(L.signatureY);
      if (reg && dur) {
        expect(Math.abs((L.regX ?? 0) - (L.durX ?? 0))).toBeGreaterThanOrEqual(440);
        expect((L.durX ?? 0) + 220).toBeLessThanOrEqual(CARD_W);
        expect((L.regX ?? 0) - 220).toBeGreaterThanOrEqual(0);
      }
      if (!reg && !dur) {
        expect(L.quoteTop).toBeGreaterThanOrEqual(700);
      }
    }
  });

  it('renderWeeklyCard 成品画布只绘制聚合指标，绝不泄漏任何 HH:MM 钟点或起卧指纹', async () => {
    storage.map.set('somnacare_travel_state', JSON.stringify({ unlockedCardIds: ['card-asia-01'] }));

    const drawn: string[] = [];
    const ctxStub: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'measureText') return (s: unknown) => ({ width: String(s).length * 26 });
          if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} });
          if (prop === 'fillText') return (s: unknown) => { drawn.push(String(s)); };
          return () => {};
        },
        set: () => true,
      },
    );
    const canvasStub: any = {
      width: 0,
      height: 0,
      getContext: () => ctxStub,
      toBlob: (cb: (b: unknown) => void) => cb({ size: 1 }),
    };

    const prevDoc = (globalThis as any).document;
    const prevFR = (globalThis as any).FileReader;
    const prevFetch = (globalThis as any).fetch;
    const prevCIB = (globalThis as any).createImageBitmap;

    try {
      (globalThis as any).document = { createElement: () => canvasStub };
      (globalThis as any).FileReader = class {
        result: unknown = 'data:image/jpeg;base64,AA';
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.onload?.();
        }
      };
      (globalThis as any).fetch = async () => ({ blob: async () => ({ size: 1 }) });
      (globalThis as any).createImageBitmap = async () => ({ width: 1080, height: 1440 });

      const mk = (bedtime: string, wakeTime: string, i: number): any => ({
        id: 'r' + i,
        date: `2026-10-0${i + 1}`,
        bedtime,
        wakeTime,
        durationMinutes: 470,
        deepSleepMinutes: 90,
        lightSleepMinutes: 300,
        remSleepMinutes: 70,
        awakeMinutes: 10,
        sleepScore: 86,
        sleepEfficiency: 91,
        latencyMinutes: 12,
        wakeCount: 1,
        wakingMood: 'tired',
        preSleepHabits: ['coffee'],
        dreamNotes: 'SECRET_DREAM_TEXT',
      });

      const result = await renderWeeklyCard({
        records: [mk('23:47', '07:31', 0), mk('00:13', '07:05', 1), mk('23:58', '07:44', 2)],
        accentHex: '#6366f1',
        pageBgHex: '#0B1026',
        showRegularity: true,
        showDuration: true,
      });

      expect(drawn.some((t) => t.includes('作息规律度'))).toBe(true);
      expect(drawn.some((t) => t.includes('平均睡眠时长'))).toBe(true);
      expect(drawn.filter((t) => /\d{1,2}:\d{2}/.test(t))).toEqual([]);
      expect(drawn.join(' ')).not.toContain('SECRET_DREAM_TEXT');
      expect(result.avgDurationMin).toBe(470);
      expect(result.regularity).not.toBeNull();
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).FileReader = prevFR;
      (globalThis as any).fetch = prevFetch;
      (globalThis as any).createImageBitmap = prevCIB;
    }
  });
});
