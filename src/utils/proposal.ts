/**
 * 提议引擎（P3 核心）：把昨晚的手机使用信号转成一条【待确认】的睡眠提议。
 *
 * 铁律（第 20 轮方案 §决策 1）：只预填，不自动写入——lastActive 是行为性
 * 信号（放下手机 ≠ 入睡），误判写库会污染评分/规律度/图鉴能量。
 *
 * 日期口径（方案 §3.3，最大的坑）：targetDate = 醒来那天的日历日，
 * 由 firstActive 时刻直接取——绝不能用 UsageDay.date（那是"夜归属"键，
 * 恒差一天；用它会把新记录落到前一晚，保存时删掉真正属于那晚的记录）。
 * 本实现通过 epoch 重建（§3.2 gate 链之后由 verify-proposal 反向注入验证）。
 */
import { SleepRecord } from '../types/sleep';
import { bedClockAxis, circularMedian, median, shortArc, clockMinutes } from './clockMath';
import { nightsOnly } from './recordFilter';
import { fitSleepModel, modelWindowStart } from './sleepModel';
import type { UsageDay } from './usageSignal';

export interface Proposal {
  targetDate: string;        // 醒来那天的日历日（YYYY-MM-DD）
  bedtime: string;           // 'HH:MM' 放下手机
  wakeTime: string;          // 'HH:MM' 第一次拿起
  bedtimeMs: number;         // epoch（构建记录用）
  wakeMs: number;
  windowMinutes: number;
  confidence: 'high' | 'medium' | 'low';
  nightPickups: number;
}

export interface ProposalInput {
  usageDays: UsageDay[];
  chronotype?: 'night' | 'day' | 'irregular';
  records: SleepRecord[];
  sessionActive: boolean;
  handledDate?: string | null;
  now?: Date;
}

/** 单个 HH:mm + 夜归属键 → epoch（凌晨事件归 dateKey 的次一日历日）。 */
export function epochOfEvent(dateKey: string, hhmm: string, kind: 'lastActive' | 'firstActive', isDay = false): number {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  // 夜间作息：firstActive 恒在晨窗（04–12 点）→ 日历日 = dateKey + 1；
  // lastActive：18–24 点 = dateKey 当天，0–6 点 = dateKey + 1。
  // 白天作息：原生端按自然日分桶（放下 06–18 / 醒来 12–20 都在 dateKey 当天）→ 不平移
  const dayShift = isDay ? 0 : kind === 'firstActive' ? 1 : h >= 18 ? 0 : 1;
  return new Date(y, mo - 1, d + dayShift, h, mi, 0, 0).getTime();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function computeProposal(input: ProposalInput): Proposal | null {
  const now = input.now ?? new Date();
  if (input.chronotype === 'irregular') return null;          // gate 0：不作息者不自动提议
  if (input.sessionActive) return null;                       // gate 5：进行中不提议
  if (input.usageDays.length === 0) return null;              // 无数据（未授权/老内核）

  // 只提议最近一晚（决策 2）：取最后一晚（时间序末尾）
  const day = input.usageDays[input.usageDays.length - 1];
  if (!day) return null;

  if (!day.lastActive || !day.firstActive) return null;       // gate 1：信号不全不编数字

  // gate 7（防御性复验，Java 已保证；缓存数据可能陈旧畸形）。
  // 窗口必须跟原生端 UsageSignalPlugin 的采样窗口同源——day 作息此前被
  // 硬编码的夜间窗口整段拒绝，设置页宣称的"白天为主自动提议"实际从不触发
  const isDay = input.chronotype === 'day';
  const bedH = parseInt(day.lastActive.split(':')[0], 10);
  const wakeH = parseInt(day.firstActive.split(':')[0], 10);
  const bedOk = isDay ? bedH >= 6 && bedH < 18 : bedH >= 18 || bedH < 6;
  const wakeOk = isDay ? wakeH >= 12 && wakeH < 20 : wakeH >= 4 && wakeH < 12;
  if (!bedOk || !wakeOk) return null;

  const bedtimeMs = epochOfEvent(day.date, day.lastActive, 'lastActive', isDay);
  const wakeMs = epochOfEvent(day.date, day.firstActive, 'firstActive', isDay);
  if (!(wakeMs > bedtimeMs)) return null;                     // 时序防御

  const windowMinutes = Math.round((wakeMs - bedtimeMs) / 60000);
  if (windowMinutes < 240 || windowMinutes > 960) return null; // gate 2：4h~16h

  // ★ targetDate = 醒来那天的日历日（由 wakeMs 取，绝不用 day.date——差一天）
  const w = new Date(wakeMs);
  const targetDate = `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;

  // gate 4：已有夜睡记录 → 不提议。必须只看夜睡——小睡与夜睡共存是合法状态
  // （mergeRecord 契约），下午记了午睡不该把"昨晚还没确认"的提议挡掉
  if (nightsOnly(input.records).some((r) => r.date === targetDate)) return null;
  if (input.handledDate === targetDate) return null;                  // gate 6：已处理过


  // gate 8：置信度 = 与历史就寝中位数（近 14 晚）的偏差（用你自己的历史判据）
  // 置信度判据用【夜睡】历史（小睡是资产不是作息），并改用圆周短弧——
  // 日界断点对白睡者会把高置信误判为低（D2 同源）
  const history = nightsOnly(input.records)
    .slice(0, 14)
    .map((r) => clockMinutes(r.bedtime));
  let confidence: 'high' | 'medium' | 'low';
  if (history.length < 3) {
    confidence = 'medium';
  } else {
    const med = median(history);
    const diff = shortArc(clockMinutes(day.lastActive), med);
    confidence = diff <= 90 ? 'high' : diff <= 180 ? 'medium' : 'low';
  }
  if (confidence === 'low') return null;                      // 低置信：不预填，走手动补录

  return {
    targetDate,
    bedtime: day.lastActive,
    wakeTime: day.firstActive,
    bedtimeMs,
    wakeMs,
    windowMinutes,
    confidence,
    nightPickups: day.nightPickups,
  };
}

/**
 * 模型化提议（第 26 轮）：用 SensibleSleep 贝叶斯切换点模型替代
 * "固定窗内最后一次熄屏"的启发式（起夜会把就寝顶到后半夜的结构性缺陷）。
 *
 * 回退策略（关键设计）：
 *  - fallbackAllowed=true 仅当【模型跑不了】（数据不足/非 native）——此时回退
 *    computeProposal 是既有行为
 *  - 模型【跑出了结论但被闸门拒绝】（通宵用机/作息可疑/观测未到起床）→
 *    proposal=null 且 fallbackAllowed=false——绝不回退，否则旧算法会把
 *    "通宵没睡"报成一次睡眠，正是本方案要根治的场景
 *
 * 先验中心（模型的命门，§4.2）：优先用用户确认的夜睡记录中位数（近 14 晚），
 * 其次用作息类型默认值。模型推断中位数偏离先验 >3h 会在模型层直接拒绝
 * （不静默改先验——错误会自我强化）。
 */
export interface ModelProposalInput {
  events: number[];
  observedUntil: number;
  chronotype: 'night' | 'day' | 'irregular';
  records: SleepRecord[];
  sessionActive: boolean;
  handledDate?: string | null;
  now?: Date;
}

export interface ModelProposalResult {
  proposal: Proposal | null;
  fallbackAllowed: boolean;
}

// 拟合结果缓存（单条）：键见 computeModelProposal 内注释
let fitCache: { events: number[]; key: string; outcome: ReturnType<typeof fitSleepModel> } | null = null;

export function computeModelProposal(input: ModelProposalInput): ModelProposalResult {
  if (input.chronotype === 'irregular') return { proposal: null, fallbackAllowed: false };  // gate 0
  if (input.sessionActive) return { proposal: null, fallbackAllowed: false };               // gate 5

  // 先验中心：确认夜睡中位数（≥3 晚）→ 作息类型默认。
  // ★ 必须用圆周中位数——就寝横跨午夜时线性中位会偏 ~2.5h（模型命门）
  const nights = nightsOnly(input.records).slice(0, 14);
  const hasHabit = nights.length >= 3;
  const habitBedMin = hasHabit ? circularMedian(nights.map((r) => clockMinutes(r.bedtime))) : undefined;
  const habitWakeMin = hasHabit ? circularMedian(nights.map((r) => clockMinutes(r.wakeTime))) : undefined;

  // 拟合缓存：events 数组在 usageSignal 的 30min TTL 内是同一引用，而
  // records/handledDate 的每次变化都会触发 effect 重跑——坐标上升不必重跑。
  // 缓存命中后 gate 4/6/窗口闸仍全量复查（它们不进缓存键，语义不变）
  const fitKey = `${input.chronotype === 'day' ? 'day' : 'night'}|${habitBedMin ?? ''}|${habitWakeMin ?? ''}|${input.observedUntil}|${modelWindowStart((input.now ?? new Date()).getTime(), input.chronotype === 'day' ? 'day' : 'night', habitBedMin, habitWakeMin)}`;
  let fit: ReturnType<typeof fitSleepModel>;
  if (fitCache && fitCache.events === input.events && fitCache.key === fitKey) {
    fit = fitCache.outcome;
  } else {
    fit = fitSleepModel({
      events: input.events,
      observedUntil: input.observedUntil,
      chronotype: input.chronotype === 'day' ? 'day' : 'night',
      habitBedMin,
      habitWakeMin,
      now: (input.now ?? new Date()).getTime(),
    });
    fitCache = { events: input.events, key: fitKey, outcome: fit };
  }
  if (fit.status === 'insufficient') {
    return { proposal: null, fallbackAllowed: true };   // 跑不了模型 → 旧算法顶上
  }
  if (fit.status === 'rejected') {
    return { proposal: null, fallbackAllowed: false };  // 模型明确拒绝 → 不回退
  }

  const targetDate = fit.targetDate;
  if (nightsOnly(input.records).some((r) => r.date === targetDate)) {
    return { proposal: null, fallbackAllowed: false };  // gate 4：已有记录
  }
  if (input.handledDate === targetDate) {
    return { proposal: null, fallbackAllowed: false };  // gate 6：已处理过
  }

  const windowMinutes = Math.round((fit.wakeMs - fit.bedtimeMs) / 60000);
  if (windowMinutes < 240 || windowMinutes > 960) {
    return { proposal: null, fallbackAllowed: false };  // gate 2（比模型 [3,14]h 更紧）
  }

  // 置信度：Δ 映射（实测正常夜 710–830、真实用户 865–1573）
  const confidence = fit.delta >= 800 ? 'high' : fit.delta >= 300 ? 'medium' : null;
  if (!confidence) return { proposal: null, fallbackAllowed: false };

  return {
    proposal: {
      targetDate,
      bedtime: fit.bedtime,
      wakeTime: fit.wakeTime,
      bedtimeMs: fit.bedtimeMs,
      wakeMs: fit.wakeMs,
      windowMinutes,
      confidence,
      nightPickups: fit.sleepEventsInTarget,
    },
    fallbackAllowed: false,
  };
}
