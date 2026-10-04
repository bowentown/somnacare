/**
 * 睡眠记录清洗（导入备份与启动加载两条路径共用）。
 * 背景：第三轮审查实测，启动路径只做 Array.isArray 时，localStorage 里的
 * 畸形记录（缺 bedtime / null 项 / 字段坏值）会直接把首页打崩（.split 抛错）
 * 或产出 NaN——这条防线原本只接在导入那一侧。
 */
import { SleepRecord, SleepStageSegment } from '../types/sleep';

// 逐条清洗：任何非对象/缺日期/字段异常的条目都会被安全跳过或兜底
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const strOr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;
const clampMin = (v: unknown, max: number): number => Math.max(0, Math.min(max, numOr(v, 0)));

export function sanitizeRecord(raw: unknown): SleepRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
    // 形状合法之外再校验日历合法：2025-02-30 会被 JS 静默当 03-02、
    // 2025-99-99 的 getTime() 是 NaN——一条坏日期就能打乱整个降序契约
    && Number.isFinite(new Date(r.date + 'T00:00:00').getTime())
    ? r.date : null;
  if (!date) return null;
  const duration = clampMin(r.durationMinutes, 1440);
  const stages = Array.isArray(r.stages)
    ? (r.stages as unknown[])
        .map((st): SleepStageSegment | null => {
          if (typeof st !== 'object' || st === null) return null;
          const s = st as Record<string, unknown>;
          const stage = ['awake', 'rem', 'light', 'deep'].includes(s.stage as string)
            ? (s.stage as SleepStageSegment['stage'])
            : 'light';
          return {
            stage,
            startTime: strOr(s.startTime, '23:30'),
            endTime: strOr(s.endTime, '07:30'),
            durationMinutes: Math.max(0, Math.round(numOr(s.durationMinutes, 0))),
          };
        })
        .filter((x): x is SleepStageSegment => x !== null)
    : [];
  return {
    id: strOr(r.id, `import-${Date.now()}-${Math.round(Math.random() * 1e6)}`),
    date,
    // 与 date 同等强度的时间格式校验："abc" 这类坏值会让下游 .split(':') 产出 NaN，
    // 界面直接显示「早于目标 NaN 分钟」
    bedtime: typeof r.bedtime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.bedtime) ? r.bedtime : '23:30',
    wakeTime: typeof r.wakeTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.wakeTime) ? r.wakeTime : '07:30',
    durationMinutes: duration || 1,
    deepSleepMinutes: clampMin(r.deepSleepMinutes, duration),
    lightSleepMinutes: clampMin(r.lightSleepMinutes, duration),
    remSleepMinutes: clampMin(r.remSleepMinutes, duration),
    awakeMinutes: clampMin(r.awakeMinutes, 720),
    sleepScore: Math.max(0, Math.min(100, numOr(r.sleepScore, 60))),
    sleepEfficiency: Math.max(0, Math.min(100, numOr(r.sleepEfficiency, 80))),
    latencyMinutes: clampMin(r.latencyMinutes, 480),
    // 白名单漏字段 = 挂载写回时静默丢数据：latencyEstimated 曾被这里抹掉，
    // AI 把按时作息推算的潜伏期当成实测值讲（第七轮§3①）
    latencyEstimated: typeof r.latencyEstimated === 'boolean' ? r.latencyEstimated : undefined,
    // 白名单加 kind：nap-only 落字段（'night'/缺省不写，旧数据 JSON 形状一字不变）
    kind: r.kind === 'nap' ? 'nap' : undefined,
    // 白名单补 recordSource（第 23 轮）：挂载写回曾把"来源标注"静默抹掉，
    // 与 latencyEstimated 同一类缺陷
    recordSource: ['onetap', 'manual', 'usage'].includes(r.recordSource as string)
      ? (r.recordSource as SleepRecord['recordSource'])
      : undefined,
    wakeCount: Math.max(0, Math.round(numOr(r.wakeCount, 0))),
    wakingMood: (['refreshed', 'neutral', 'tired', 'groggy'].includes(r.wakingMood as string)
      ? r.wakingMood
      : 'neutral') as SleepRecord['wakingMood'],
    preSleepHabits: Array.isArray(r.preSleepHabits)
      ? (r.preSleepHabits as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    dreamNotes: typeof r.dreamNotes === 'string' ? r.dreamNotes : undefined,
    stages,
    // soundEvents 逐元素白名单清洗（安全审计 V20）：此前只判数组后原样透传，
    // 是全文件唯一未深清洗的字段。形状 = { time: 'HH:MM', decibel, label }
    soundEvents: Array.isArray(r.soundEvents)
      ? (r.soundEvents as unknown[]).slice(0, 500).map((ev): NonNullable<SleepRecord['soundEvents']>[number] | null => {
          if (typeof ev !== 'object' || ev === null) return null;
          const e = ev as Record<string, unknown>;
          const time = typeof e.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time) ? e.time : null;
          const decibel = typeof e.decibel === 'number' && Number.isFinite(e.decibel) ? Math.max(0, Math.min(120, Math.round(e.decibel))) : null;
          const label = typeof e.label === 'string' ? e.label.slice(0, 32) : undefined;
          if (!time || decibel === null) return null;
          return { time, decibel, label: label || '' };
        }).filter((x): x is NonNullable<typeof x> => x !== null)
      : undefined,
  };
}

