/**
 * 护栏：模型影子诊断的记账正确性（第 37 轮落地，第 40 轮按审计强化）。
 *
 * 两层不变量：
 *  1. 记账层：按目标夜合并（幂等）、真值回填、圆周口径 MAE、坏条目跳过
 *  2. 语义层（第 40 轮）：confirmed（真值循环，只算采纳率）与 manual
 *     （独立真值，算命中率/误差）必须【分开报告】——混在一起会让
 *     命中率被自比样本稀释到虚高（报告实测：报告 70%，真相 0%）
 *  3. 分母 = 实际参与比较的夜数；recordOutcome 未命中 → dropped 计数可见
 */
import { fileURLToPath } from 'node:url';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { recordEngineRun, recordOutcome, loadShadowStore, shadowStats } = await import(
  new URL('../src/utils/modelShadow.ts', import.meta.url).href
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1) 按目标夜合并（幂等）──
recordEngineRun({ date: '2026-10-04', model: { bed: '23:00', wake: '07:15' } });
recordEngineRun({ date: '2026-10-04', model: { bed: '23:10', wake: '07:10' } });   // 同夜重算 → 覆盖
const afterRun = loadShadowStore();
check('同夜引擎重算 → 合并为一条且取最新', afterRun.entries.length === 1 && afterRun.entries[0].model?.bed === '23:10',
  JSON.stringify(afterRun.entries));

// ── 2) confirmed 只进采纳率，不污染命中率（第 40 轮语义分离）──
recordOutcome('2026-10-04', '23:30', '07:05', 'confirmed');   // 采纳：真值=提议 → 差值恒 0
const st1 = shadowStats(loadShadowStore());
check('confirmed 计入采纳率（100%）', st1.adoptionRate === 100 && st1.confirmedNights === 1, JSON.stringify(st1));
check('confirmed 不产生独立命中率（真值循环）', st1.independent.hitRate === null, JSON.stringify(st1.independent));

// ── 3) manual = 独立真值，命中/误差只从这里算 ──
recordEngineRun({ date: '2026-10-05', model: { bed: '23:50', wake: '07:00' } });
recordOutcome('2026-10-05', '00:10', '07:00', 'manual');      // 跨午夜：就寝差 20 分
const st2 = shadowStats(loadShadowStore());
check('manual 夜进入独立命中率', st2.independent.nights === 1 && st2.independent.hitRate === 100,
  JSON.stringify(st2.independent));
check('manual 圆周口径：跨午夜差不炸成 1400+', st2.independent.bedMaeMin !== null && st2.independent.bedMaeMin <= 45,
  JSON.stringify(st2.independent));

// ── 4) 分母 = 实际可比夜数（时刻解析失败的条目不进分母）──
recordEngineRun({ date: '2026-10-06', heuristic: { bed: '23:00', wake: '07:00' } });
recordOutcome('2026-10-06', 'bad', 'bad', 'manual');          // 时刻无法解析 → 跳过
const st3 = shadowStats(loadShadowStore());
check('解析失败条目不压低命中率（分母=可比数）', st3.independent.hitRate === 100,
  JSON.stringify(st3.independent));

// ── 5) recordOutcome 未命中 → dropped 计数可见（不再静默）──
recordOutcome('2026-01-01', '23:00', '07:00', 'manual');      // 无对应夜
const st4 = shadowStats(loadShadowStore());
check('未命中日期 → dropped 计数 +1', st4.droppedOutcomes === 1, String(st4.droppedOutcomes));

// ── 6) 反向：坏日期条目被 loadShadowStore 跳过 ──
store.set('somnacare_model_shadow', JSON.stringify([{ date: 'bad-date' }, ...loadShadowStore().entries]));
check('反向：坏日期条目被跳过', loadShadowStore().entries.every((e: { date: string }) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)));

// ── 7) 混合分布的反向锚定（报告 §二 的场景）：先清空前序用例的数据 ──
// 10 夜：7 夜采纳（真值循环）+ 3 夜手动且模型全错 →
// 采纳率 70% 照实报告；独立命中率必须如实 0%，而不是被稀释成 7/10
store.clear();
const seq: Array<[string, string, string, string]> = [
  ['2026-10-10', '23:00', '23:00', '07:00'],
  ['2026-10-11', '23:00', '23:00', '07:00'],
  ['2026-10-12', '23:00', '23:00', '07:00'],
  ['2026-10-13', '23:00', '23:00', '07:00'],
  ['2026-10-14', '23:00', '23:00', '07:00'],
  ['2026-10-15', '23:00', '23:00', '07:00'],
  ['2026-10-16', '23:00', '23:00', '07:00'],
  ['2026-10-17', '23:00', '04:00', '12:00'],   // 模型全错（夜 1）
  ['2026-10-18', '23:00', '05:00', '13:00'],   // 模型全错（夜 2）
  ['2026-10-19', '23:00', '06:00', '14:00'],   // 模型全错（夜 3）
];
for (const [date, mBed, oBed, oWake] of seq) {
  recordEngineRun({ date, model: { bed: mBed, wake: '07:00' } });
  const type = oBed === mBed ? 'confirmed' : 'manual';
  recordOutcome(date, oBed, oWake, type as 'confirmed' | 'manual');
}
const st5 = shadowStats(loadShadowStore());
check('反向锚定：7 采纳 + 3 全错 → 采纳率 70%、独立命中率如实 0%',
  st5.adoptionRate === 70 && st5.independent.hitRate === 0,
  `采纳率=${st5.adoptionRate}% 独立=${st5.independent.hitRate}%`);

if (failures > 0) {
  console.error(`\n${failures} 项失败——影子诊断指标语义失真`);
  process.exit(1);
}
console.log('\n✓ verify-model-shadow：记账/语义分离/分母/反向锚定全部符合');
