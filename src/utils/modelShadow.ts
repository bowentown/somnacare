/**
 * SensibleSleep 模型影子诊断（第 37 轮落地，第 40 轮按审计重构）：
 * 让 App 自己测量自己——用户的每次保存都是标注，按夜存档并自动算指标。
 *
 * ★ 第 40 轮核心修正（指标语义）：
 *   - confirmed（一键采纳）的"真值"就是提议自己的时刻——差值恒 0，
 *     它衡量的是【采纳率】，不是模型准确度；
 *   - manual（手动补录/修改）的时刻才是【独立真值】，只有它能算命中率/误差；
 *   - 两者必须分开报告，混在一起会让命中率被自比样本稀释到虚高。
 *   - hitRate 分母 = 实际参与比较的夜数（不是 withOutcome——时刻解析失败
 *     被跳过的条目不能再进分母，否则系统性低估模型）。
 *
 * 存储：somnacare_model_shadow（不进备份）。形状 v1 = { v, entries, dropped }，
 * 旧版平铺数组自动迁移。按目标夜合并（同夜幂等），上限 60 夜。
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
    type: 'confirmed' | 'manual';   // confirmed=采纳提议（真值循环，只算采纳率）；manual=独立真值
    bed: string;
    wake: string;
  };
}

export interface ShadowStore {
  entries: ShadowEntry[];
  /** recordOutcome 因找不到对应夜而被丢弃的次数（日期不匹配会让静默变可见） */
  dropped: number;
}

function sanitizeEntries(list: unknown): ShadowEntry[] {
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter(
    (e): e is ShadowEntry =>
      !!e && typeof (e as ShadowEntry).date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test((e as ShadowEntry).date)
  );
}

export function loadShadowStore(): ShadowStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { entries: sanitizeEntries(parsed), dropped: 0 };   // 旧版平铺数组迁移
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        return {
          entries: sanitizeEntries(parsed.entries),
          dropped: Number.isFinite(parsed.dropped) ? parsed.dropped : 0,
        };
      }
    }
  } catch { /* 损坏则归零 */ }
  return { entries: [], dropped: 0 };
}

export function persistShadow(store: ShadowStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      v: 1,
      entries: store.entries.slice(-MAX_ENTRIES),
      dropped: store.dropped,
    }));
  } catch { /* 配额满时放弃（诊断非关键数据） */ }
}

/** 记录一次引擎运行（按目标夜合并，幂等——重复计算不产生重复条目）。 */
export function recordEngineRun(run: { date: string; model?: EngineTimes; heuristic?: EngineTimes }): void {
  const store = loadShadowStore();
  const idx = store.entries.findIndex((e) => e.date === run.date);
  if (idx >= 0) {
    if (run.model) store.entries[idx].model = run.model;
    if (run.heuristic) store.entries[idx].heuristic = run.heuristic;
  } else {
    store.entries.push({ date: run.date, model: run.model, heuristic: run.heuristic });
  }
  persistShadow(store);
}

/**
 * 回填结果真值。返回 false = 该夜没有引擎记录（日期不匹配或引擎未运行），
 * 调用方不必处理，但丢弃会被计数——静默丢弃最关键的标注必须可见。
 */
export function recordOutcome(date: string, bed: string, wake: string, type: 'confirmed' | 'manual'): boolean {
  const store = loadShadowStore();
  const idx = store.entries.findIndex((e) => e.date === date);
  if (idx < 0) {
    store.dropped += 1;
    persistShadow(store);
    return false;
  }
  store.entries[idx].outcome = { type, bed, wake };
  persistShadow(store);
  return true;
}

export interface ShadowStats {
  nights: number;                 // 有引擎输出的夜数
  withOutcome: number;            // 已回填真值的夜数
  confirmedNights: number;        // 其中一键采纳的夜数
  adoptionRate: number | null;    // 采纳率 = confirmed / withOutcome（反映使用习惯，非准确度）
  droppedOutcomes: number;        // 被丢弃的结果数（日期不匹配等）
  independent: {
    nights: number;               // manual 夜数（独立真值样本）
    maeMin: number | null;        // 平均绝对误差（就寝+起床圆周差的均值）
    bedMaeMin: number | null;
    wakeMaeMin: number | null;
    hitRate: number | null;       // ±45 分钟命中率（分母 = 实际可比夜数）
  };
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

export function shadowStats(store: ShadowStore): ShadowStats {
  const withEngine = store.entries.filter((e) => e.model || e.heuristic);
  const withOutcome = withEngine.filter((e) => e.outcome);
  const confirmed = withOutcome.filter((e) => e.outcome!.type === 'confirmed');
  const manual = withOutcome.filter((e) => e.outcome!.type === 'manual');

  // 独立命中率：只用 manual 夜（confirmed 的真值循环，混入必然虚高）
  const bedDiffs: number[] = [];
  const wakeDiffs: number[] = [];
  let hits = 0;
  for (const e of manual) {
    const engine = e.model ?? e.heuristic;
    if (!engine) continue;
    const d = nightDelta(engine, e.outcome!);
    if (!d) continue;
    bedDiffs.push(d.bed);
    wakeDiffs.push(d.wake);
    if (d.bed <= HIT_THRESHOLD_MIN && d.wake <= HIT_THRESHOLD_MIN) hits++;
  }
  const compared = bedDiffs.length;   // ★ 分母 = 实际参与比较的夜数
  const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  return {
    nights: withEngine.length,
    withOutcome: withOutcome.length,
    confirmedNights: confirmed.length,
    adoptionRate: withOutcome.length ? Math.round((confirmed.length / withOutcome.length) * 100) : null,
    droppedOutcomes: store.dropped,
    independent: {
      nights: manual.length,
      maeMin: mean(bedDiffs.map((d, i) => Math.round((d + wakeDiffs[i]) / 2))),
      bedMaeMin: mean(bedDiffs),
      wakeMaeMin: mean(wakeDiffs),
      hitRate: compared ? Math.round((hits / compared) * 100) : null,
    },
  };
}
