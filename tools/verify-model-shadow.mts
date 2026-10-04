/**
 * 护栏：模型影子诊断的记账正确性（第 37 轮）。
 *
 * 影子跑的价值全在记账准确：按目标夜合并（幂等）、真值回填、MAE 圆周口径、
 * 命中率阈值——任何一处算错，诊断卡就会对"模型准不准"撒谎。
 * 方法论约束：反向自检（构造坏条目必须被跳过/被算出）。
 */
import { fileURLToPath } from 'node:url';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { recordEngineRun, recordOutcome, loadShadow, shadowStats, HIT_THRESHOLD_MIN } = await import(
  new URL('../src/utils/modelShadow.ts', import.meta.url).href
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1) 按目标夜合并（幂等）──
recordEngineRun({ date: '2026-10-04', model: { bed: '23:00', wake: '07:15' } });
recordEngineRun({ date: '2026-10-04', model: { bed: '23:10', wake: '07:10' } });   // 同夜重算 → 覆盖不重复
const afterRun = loadShadow();
check('同夜引擎重算 → 合并为一条且取最新', afterRun.length === 1 && afterRun[0].model?.bed === '23:10',
  JSON.stringify(afterRun));

// ── 2) 真值回填 + 圆周误差（跨午夜安全）──
recordOutcome('2026-10-04', '23:30', '07:05', 'confirmed');   // 就寝差 20、起床差 5
const st1 = shadowStats(loadShadow());
check('回填结果：MAE = (20+5)/2 ≈ 13 分', st1.maeMin === 13, JSON.stringify(st1));
check('回填结果：命中（20/5 都 ≤45）', st1.hitRate === 100, `${st1.hitRate}%`);

// ── 3) 跨午夜：模型 23:50 vs 记录 00:10 → 圆周差 20 分钟（不是 1420）──
recordEngineRun({ date: '2026-10-05', model: { bed: '23:50', wake: '07:00' } });
recordOutcome('2026-10-05', '00:10', '07:00', 'manual');
const st2 = shadowStats(loadShadow());
check('跨午夜圆周口径：起床/就寝差不炸成 1400+', st2.bedMaeMin !== null && st2.bedMaeMin <= 45, JSON.stringify(st2));

// ── 4) 未反馈夜计入积累但不计入命中率 ──
recordEngineRun({ date: '2026-10-06', heuristic: { bed: '23:00', wake: '07:00' } });
const st3 = shadowStats(loadShadow());
check('未反馈夜：计入积累、不计入命中率', st3.nights === 3 && st3.withOutcome === 2, JSON.stringify(st3));

// ── 5) 反向：畸形条目（坏日期）被 loadShadow 跳过 ──
store.set('somnacare_model_shadow', JSON.stringify([{ date: 'bad-date' }, ...loadShadow()]));
check('反向：坏日期条目被跳过', loadShadow().every((e: { date: string }) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)));

// ── 6) 无引擎输出的条目不产生误差 ──
const empty = shadowStats([{ date: '2026-10-07' } as any]);
check('无引擎输出 → 误差为 null（不产 0/0）', empty.maeMin === null && empty.hitRate === null);

if (failures > 0) {
  console.error(`\n${failures} 项失败——影子诊断记账失真`);
  process.exit(1);
}
console.log('\n✓ verify-model-shadow：影子记账合并/回填/圆周误差/降级全部符合');
