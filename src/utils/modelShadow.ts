/**
 * SensibleSleep 模型影子诊断（第 37 轮）：让 App 自己测量自己。
 *
 * 背景：模型参数用公开数据集（SensibleDTU，丹麦学生）标定，从未见过
 * 本 App 真实用户的屏幕事件分布。影子跑的正确形态不是让用户手动汇报——
 * 而是【用户的每次保存都是标注真值】：模型提议的时刻 vs 用户最终
 * 确认/补录的时刻，差异就是模型误差，按夜积累、自动算准确率。
 *
 * 存储：somnacare_model_shadow（不进备份——诊断是本机开发工具，不是用户数据）
 * 按目标夜合并（同夜只留一条），上限 60 夜。
 */
import { shortArc } from './clockMath';

const KEY = 'somnacare_model_shadow';
const MAX_ENTRIES = 60;
/** 命中阈值：就寝与起床偏差都 ≤45 分钟（论文口径） */
export const HIT_THRESHOLD_MIN = 45;

export interface EngineTimes {
  bed: string;
  wake: string;
}

export interface ShadowEntry {
  date: string;                     // 目标夜 = 醒来那天的日历日
  model?: EngineTimes;              // SensibleSleep 输出
  heuristic?: EngineTimes;          // 旧启发式输出（回退路径）
  outcome?: {
    type: 'confirmed' | 'manual';   // confirmed=采纳提议；manual=手动补录/修改
    bed: string;
    wake: string;
  };
}

export function loadShadow(): ShadowEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
  } catch {
    return [];
  }
}

export function persistShadow(entries: ShadowEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* 配额满时放弃（诊断非关键数据） */ }
}

/** 记录一次引擎运行（按目标夜合并，幂等——重复计算不产生重复条目）。 */
export function recordEngineRun(run: { date: string; model?: EngineTimes; heuristic?: EngineTimes }): void {
  const entries = loadShadow();
  const idx = entries.findIndex((e) => e.date === run.date);
  if (idx >= 0) {
    if (run.model) entries[idx].model = run.model;
    if (run.heuristic) entries[idx].heuristic = run.heuristic;
  } else {
    entries.push({ date: run.date, model: run.model, heuristic: run.heuristic });
  }
  persistShadow(entries);
}

/** 回填结果真值：用户保存的最终记录时刻（确认/手动/修改统一处理）。 */
export function recordOutcome(date: string, bed: string, wake: string, type: 'confirmed' | 'manual'): void {
  const entries = loadShadow();
  const idx = entries.findIndex((e) => e.date === date);
  if (idx < 0) return;   // 该夜引擎没运行过（如数据不足回退且无提议）→ 无对比价值
  entries[idx].outcome = { type, bed, wake };
  persistShadow(entries);
}

export interface ShadowStats {
  nights: number;            // 有引擎输出的夜数
  withOutcome: number;       // 已有结果真值的夜数
  maeMin: number | null;     // 平均绝对误差（就寝+起床圆周差的均值）
  bedMaeMin: number | null;
  wakeMaeMin: number | null;
  hitRate: number | null;    // ±45 分钟命中率（就寝与起床都命中才算）
}

/** 单夜误差：圆周短弧（跨午夜安全），单位分钟 */
function nightDelta(model: EngineTimes, outcome: { bed: string; wake: string }): { bed: number; wake: number } | null {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const b = toMin(model.bed);
  const w = toMin(model.wake);
  const ob = toMin(outcome.bed);
  const ow = toMin(outcome.wake);
  if (b === null || w === null || ob === null || ow === null) return null;
  return { bed: shortArc(b, ob), wake: shortArc(w, ow) };
}

export function shadowStats(entries: ShadowEntry[]): ShadowStats {
  const withEngine = entries.filter((e) => e.model || e.heuristic);
  const withOutcome = withEngine.filter((e) => e.outcome);
  const bedDiffs: number[] = [];
  const wakeDiffs: number[] = [];
  let hits = 0;
  for (const e of withOutcome) {
    const engine = e.model ?? e.heuristic;   // 有模型用模型，否则对照启发式
    if (!engine) continue;
    const d = nightDelta(engine, e.outcome!);
    if (!d) continue;
    bedDiffs.push(d.bed);
    wakeDiffs.push(d.wake);
    if (d.bed <= HIT_THRESHOLD_MIN && d.wake <= HIT_THRESHOLD_MIN) hits++;
  }
  const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return {
    nights: withEngine.length,
    withOutcome: withOutcome.length,
    maeMin: mean(bedDiffs.map((d, i) => Math.round((d + wakeDiffs[i]) / 2))),
    bedMaeMin: mean(bedDiffs),
    wakeMaeMin: mean(wakeDiffs),
    hitRate: withOutcome.length ? Math.round((hits / withOutcome.length) * 100) : null,
  };
}
