import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import {
  recordEngineRun,
  recordOutcome,
  recordAdjustment,
  recordNegativeLabel,
  loadShadowStore,
  shadowStats,
} from '../../src/features/sleep/utils/modelShadow';

const storage = installMemoryStorage();

describe('模型影子诊断（modelShadow）', () => {
  beforeEach(() => storage.clear());

  it('按目标夜幂等合并、confirmed/manual 语义分离与圆周误差口径', () => {
    recordEngineRun({ date: '2026-10-04', model: { bed: '23:00', wake: '07:15' } });
    recordEngineRun({ date: '2026-10-04', model: { bed: '23:10', wake: '07:10' } });
    const afterRun = loadShadowStore();
    expect(afterRun.entries).toHaveLength(1);
    expect(afterRun.entries[0].model?.bed).toBe('23:10');

    recordOutcome('2026-10-04', '23:30', '07:05', 'confirmed');
    const st1 = shadowStats(loadShadowStore());
    expect(st1.adoptionRate).toBe(100);
    expect(st1.confirmedNights).toBe(1);
    expect(st1.independent.hitRate).toBeNull();

    recordEngineRun({ date: '2026-10-05', model: { bed: '23:50', wake: '07:00' } });
    recordOutcome('2026-10-05', '00:10', '07:00', 'manual');
    const st2 = shadowStats(loadShadowStore());
    expect(st2.independent.nights).toBe(1);
    expect(st2.independent.hitRate).toBe(100);
    expect(st2.independent.bedMaeMin).not.toBeNull();
    expect(st2.independent.bedMaeMin!).toBeLessThanOrEqual(45);

    recordEngineRun({ date: '2026-10-06', heuristic: { bed: '23:00', wake: '07:00' } });
    recordOutcome('2026-10-06', 'bad', 'bad', 'manual');
    expect(shadowStats(loadShadowStore()).independent.hitRate).toBe(100);

    recordOutcome('2026-01-01', '23:00', '07:00', 'manual');
    expect(shadowStats(loadShadowStore()).droppedOutcomes).toBe(1);

    storage.map.set('somnacare_model_shadow', JSON.stringify([{ date: 'bad-date' }, ...loadShadowStore().entries]));
    expect(loadShadowStore().entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
  });

  it('混合分布反向锚定：7 采纳 + 3 全错 → 采纳率 70%，独立命中率如实 0%', () => {
    const seq: Array<[string, string, string, string]> = [
      ['2026-10-10', '23:00', '23:00', '07:00'],
      ['2026-10-11', '23:00', '23:00', '07:00'],
      ['2026-10-12', '23:00', '23:00', '07:00'],
      ['2026-10-13', '23:00', '23:00', '07:00'],
      ['2026-10-14', '23:00', '23:00', '07:00'],
      ['2026-10-15', '23:00', '23:00', '07:00'],
      ['2026-10-16', '23:00', '23:00', '07:00'],
      ['2026-10-17', '23:00', '04:00', '12:00'],
      ['2026-10-18', '23:00', '05:00', '13:00'],
      ['2026-10-19', '23:00', '06:00', '14:00'],
    ];
    for (const [date, mBed, oBed, oWake] of seq) {
      recordEngineRun({ date, model: { bed: mBed, wake: '07:00' } });
      recordOutcome(date, oBed, oWake, oBed === mBed ? 'confirmed' : 'manual');
    }
    const st = shadowStats(loadShadowStore());
    expect(st.adoptionRate).toBe(70);
    expect(st.independent.hitRate).toBe(0);
  });

  it('微调按夜累加与否定标注统计', () => {
    recordEngineRun({ date: '2026-10-20', model: { bed: '23:00', wake: '07:00' } });
    recordAdjustment('2026-10-20', 15, -15);
    recordAdjustment('2026-10-20', 15, 0);
    recordEngineRun({ date: '2026-10-21', model: { bed: '23:00', wake: '07:00' } });
    recordNegativeLabel('2026-10-21');
    const st = shadowStats(loadShadowStore());
    expect(st.adjustments.nights).toBe(1);
    expect(st.adjustments.avgBed).toBe(30);
    expect(st.adjustments.avgWake).toBe(-15);
    expect(st.negatives).toBe(1);
  });
});
