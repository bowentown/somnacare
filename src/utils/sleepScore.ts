import { SleepRecord, SleepStageSegment, WakingMood } from '../types/sleep';
import { localDateOffset } from './dateUtils';
import { nightsOnly } from './recordFilter';
import { sleepIntervalsOf } from './sleepRegularity';

/**
 * Calculates a 0-100 sleep score.
 *
 * 【v2 口径（第 105 轮）——只对"可测/可行为佐证"的维度计分】
 * - Duration fit (40 pts)：与【个人睡眠需求】对比（调用方传 computeSleepNeed
 *   的结果；v1 是用户手设的固定目标）
 * - Rest quality (30 pts)：睡眠效率 + 夜醒惩罚（效率口径不变：纯睡眠/卧床）
 * - Latency (15 pts)：入睡耗时分档
 * - Continuity (15 pts)：夜醒次数分档
 *
 * deep/REM 占比【不再计分】：一键/手动路径的分期来自 generateSleepStages 的
 * 构造先验（前 4h 计 25% 深/20% REM），占比对多数记录是先验的回声——把
 * 先验再当成测量打 40 分是伪测量（v1 的缺陷）。它们保留为信息字段，
 * 沿用"模型估算，非测量"的既有标注。
 */
export function calculateSleepScore(
  durationMinutes: number,
  deepSleepMinutes: number,
  remSleepMinutes: number,
  awakeMinutes: number,
  wakeCount: number,
  latencyMinutes: number,
  targetDurationMinutes: number = 480
): { score: number; efficiency: number } {
  // awakeMinutes 已包含入睡潜伏期段（generateSleepStages 的首段清醒），
  // 不能再加一次 latencyMinutes——那会把潜伏期算两遍，效率被系统性低报约 3 个百分点
  const totalBedMinutes = durationMinutes + awakeMinutes;
  const efficiency = totalBedMinutes > 0 ? Math.round((durationMinutes / totalBedMinutes) * 100) : 0;

  // 1. Duration fit (max 40) — 与个人需求对比；过长与过短对称扣分
  const durationHours = durationMinutes / 60;
  const absDiffHours = Math.abs(durationHours - targetDurationMinutes / 60);
  let durationScore = 0;
  if (absDiffHours <= 0.5) {
    durationScore = 40;
  } else if (absDiffHours <= 1) {
    durationScore = 35;
  } else if (absDiffHours <= 1.5) {
    durationScore = 28;
  } else if (absDiffHours <= 2.5) {
    durationScore = 18;
  } else {
    durationScore = 10;
  }

  // 2. Rest quality (max 30) — 效率 + 夜醒（CBT-I 对齐：低效显著扣分）
  let restScore = 30;
  if (wakeCount > 3) restScore -= Math.min(9, (wakeCount - 3) * 3);
  if (efficiency < 85) restScore -= Math.min(9, Math.floor((85 - efficiency) / 3));
  if (efficiency < 60) restScore -= Math.min(12, Math.round((60 - efficiency) / 5));
  restScore = Math.max(0, restScore);

  // 3. Latency (max 15)
  const latencyScore =
    latencyMinutes <= 12 ? 15
    : latencyMinutes <= 20 ? 12
    : latencyMinutes <= 30 ? 8
    : latencyMinutes <= 45 ? 4
    : 1;

  // 4. Continuity (max 15) — 夜醒次数
  const continuityScore =
    wakeCount <= 0 ? 15
    : wakeCount === 1 ? 13
    : wakeCount === 2 ? 10
    : wakeCount === 3 ? 7
    : wakeCount <= 5 ? 4
    : 1;

  // 低分不托底：短睡/低效就该拿低分（v1 已去掉 Math.max(25,…)）
  const finalScore = Math.min(100, Math.max(5, durationScore + restScore + latencyScore + continuityScore));

  return {
    score: finalScore,
    // 如实报告效率：此前 Math.max(50,…) 会把真实 25% 的效率显示成 50%
    efficiency: Math.min(100, Math.max(0, efficiency)),
  };
}

/**
 * 个人睡眠需求（第 105 轮）：近 14 个已完成夜晚的 durationMinutes 中位数，
 * 夹在 5–11 小时的合理域内。样本 < 5 晚时回退用户设定（basis='fallback'）。
 *
 * 这是 Whoop 式"动态需求"的基线项；睡债/日间负荷的展示层调整见趋势页
 * （本轮不进计分——需求随时间变化会让存量分漂移，计分用的是"当夜的
 * 需求"，由迁移按各记录之前的夜集确定，无前视）。
 */
export interface SleepNeedResult {
  needMinutes: number;
  baselineMinutes: number;
  samples: number;
  basis: 'personal' | 'fallback';
}

export function computeSleepNeed(
  records: SleepRecord[],
  fallbackMinutes = 480,
  chronotype: 'night' | 'day' | 'irregular' = 'night',
  now: Date = new Date(),
  days = 14,
): SleepNeedResult {
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const nights = nightsOnly(records)
    .filter((r) => {
      const t = new Date(r.date + 'T12:00:00').getTime();
      return t >= windowStart && t < dayStart;   // 已完成的夜（不含今晚）
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-days);
  if (nights.length < 5) {
    return { needMinutes: fallbackMinutes, baselineMinutes: fallbackMinutes, samples: nights.length, basis: 'fallback' };
  }
  const durations = nights.map((r) => r.durationMinutes).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2
    ? durations[mid]
    : Math.round((durations[mid - 1] + durations[mid]) / 2);
  const baseline = Math.max(300, Math.min(660, median));   // 5–11 小时合理域
  return { needMinutes: baseline, baselineMinutes: baseline, samples: nights.length, basis: 'personal' };
}

/**
 * MSFsc（第 105 轮）：MCTQ 的科学时型度量——自由日睡眠中点，再按工作日/
 * 自由日的睡眠时长差校正（补自由日的补觉偏移）。需要自由日（醒在周六/周日）
 * 与工作日各 ≥ 3 晚，否则 null。
 * "自由日"近似为醒来的那天是周六/周日（无 MCTQ 问卷时的标准近似，注释在案）。
 */
export interface MSFscResult {
  msfMinutes: number;   // 0-1439（本地钟点，可能落在凌晨）
  label: string;        // HH:MM
  freeSamples: number;
  workSamples: number;
}

export function computeMSFsc(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
  now: Date = new Date(),
  days = 28,
): MSFscResult | null {
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
  const nights = nightsOnly(records).filter((r) => new Date(r.date + 'T12:00:00').getTime() >= windowStart);
  const rows = sleepIntervalsOf(nights, chronotype).map((iv) => {
    const wakeDay = new Date(iv.end).getDay();          // 醒来那天的星期
    const isFree = wakeDay === 0 || wakeDay === 6;
    const dur = iv.end - iv.start;
    return { isFree, dur, mid: iv.start + dur / 2 };    // 睡眠中点（epoch）
  });
  const free = rows.filter((r) => r.isFree);
  const work = rows.filter((r) => !r.isFree);
  if (free.length < 3 || work.length < 3) return null;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const msfFree = mean(free.map((r) => r.mid));
  const sdWorkMin = mean(work.map((r) => r.dur)) / 60000;
  const sdFreeMin = mean(free.map((r) => r.dur)) / 60000;
  const msfsc = msfFree - ((sdWorkMin - sdFreeMin) / 2) * 60000;
  // 归一必须相对【本地午夜】：epoch % 86400000 是 UTC 日界，UTC+8 下本地
  // 05:00 会被算成前一天 21:00（第 105 轮护栏锚点实测抓出）
  const mid = new Date(msfsc);
  const localMid = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate()).getTime();
  let minutes = Math.round((msfsc - localMid) / 60000);
  minutes = ((minutes % 1440) + 1440) % 1440;   // MCTQ 允许 MSF > 24h
  const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { msfMinutes: minutes, label, freeSamples: free.length, workSamples: work.length };
}

/**
 * Generates realistic cyclical sleep stage segments (Deep -> Light -> REM -> Awake)
 * across 90-110 min sleep ultradian cycles.
 */
export function generateSleepStages(
  bedtimeStr: string,
  wakeTimeStr: string,
  latencyMinutes: number = 12,
  wakeCount: number = 1
): {
  stages: SleepStageSegment[];
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
} {
  const [bHour, bMin] = bedtimeStr.split(':').map(Number);
  const [wHour, wMin] = wakeTimeStr.split(':').map(Number);

  let bedDate = new Date();
  bedDate.setHours(bHour, bMin, 0, 0);

  let wakeDate = new Date();
  wakeDate.setHours(wHour, wMin, 0, 0);
  if (wakeDate.getTime() <= bedDate.getTime()) {
    wakeDate.setDate(wakeDate.getDate() + 1);
  }

  const totalMin = Math.round((wakeDate.getTime() - bedDate.getTime()) / 60000);
  const stages: SleepStageSegment[] = [];

  let currentMin = 0;
  let deepMin = 0;
  let lightMin = 0;
  let remMin = 0;
  let awakeMin = 0;

  // 入睡潜伏期：清醒段（时长由调用方给定，演示数据用各家真实值保持一致）
  // 潜伏期不得长于在床窗口：30 分钟小睡 + 45 分钟潜伏期曾产出总和超窗 60 分钟的分期
  const latency = Math.min(Math.max(1, Math.min(120, Math.round(latencyMinutes))), Math.max(1, totalMin - 1));
  stages.push({
    stage: 'awake',
    startTime: formatTimeOffset(bedDate, currentMin),
    endTime: formatTimeOffset(bedDate, currentMin + latency),
    durationMinutes: latency,
  });
  awakeMin += latency;
  currentMin += latency;

  // 生理预算：N3 集中在前半夜——绝对分钟随时长增长（前 4h 计 25%、其后 15%），
  // 占比随之温和递减（4h≈25%、8h≈20%、12h≈18%）；这从"人的睡眠结构"出发。
  // REM 预算（前 4h 计 20%、其后 26%）只是上限：REM 集中在后半夜，分配天然
  // 向长睡夜倾斜，短睡夜的兑现率低（2h 约 11%）——这正是 REM 的生理特性，
  // 公式不要按实际占比去"校准"。
  const sleepBudget = Math.max(0, totalMin - latency);
  const deepTotal = Math.round(0.25 * Math.min(sleepBudget, 240) + 0.15 * Math.max(0, sleepBudget - 240));
  const remTotal = Math.round(0.20 * Math.min(sleepBudget, 240) + 0.26 * Math.max(0, sleepBudget - 240));
  let deepLeft = deepTotal;
  let remLeft = remTotal;

  // 夜醒段：按用户记录的次数分配（每次 5 分钟，从第 2 周期起每隔一个周期落一段），
  // 段数受夜晚长度约束；此前是固定的"第 2 周期 1 段 5 分钟"，与用户填的次数无关
  const wakeSegmentsTarget = Math.max(0, Math.min(Math.round(wakeCount), 8));
  let wakeSegmentsPlaced = 0;

  // Cycles of ~90 mins: deep -> light -> rem
  let cycleNum = 0;
  while (currentMin < totalMin - 15) {
    cycleNum++;
    const remaining = totalMin - currentMin;

    // N3 几乎只落在前两个周期（第一周期约 60%、第二周期收尾）；
    // REM 第一周期很少、此后每周期释放剩余的约 55%（单段上限 35 分钟）
    const deepDuration = cycleNum === 1
        ? Math.min(deepLeft, Math.round(deepTotal * 0.6), Math.max(0, remaining - 12))
        : cycleNum === 2
        ? Math.min(deepLeft, Math.max(0, remaining - 12))
        : 0;
    const remDuration = cycleNum === 1
        ? Math.min(remLeft, Math.round(remTotal * 0.15))
        : Math.min(remLeft, 35, Math.max(7, Math.round(remLeft * 0.55)),
                   Math.max(0, remaining - deepDuration - 6));
    // 浅睡段每段封顶 40 分钟：既符合周期结构，也让循环继续切出后续周期
    const lightDuration = Math.min(40, Math.max(6, remaining - deepDuration - remDuration));

    if (deepDuration > 5) {
      stages.push({
        stage: 'deep',
        startTime: formatTimeOffset(bedDate, currentMin),
        endTime: formatTimeOffset(bedDate, currentMin + deepDuration),
        durationMinutes: deepDuration,
      });
      deepMin += deepDuration;
      deepLeft -= deepDuration;
      currentMin += deepDuration;
    }

    if (lightDuration > 5 && currentMin < totalMin - 10) {
      stages.push({
        stage: 'light',
        startTime: formatTimeOffset(bedDate, currentMin),
        endTime: formatTimeOffset(bedDate, currentMin + lightDuration),
        durationMinutes: lightDuration,
      });
      lightMin += lightDuration;
      currentMin += lightDuration;
    }

    if (remDuration > 5 && currentMin < totalMin - 10) {
      stages.push({
        stage: 'rem',
        startTime: formatTimeOffset(bedDate, currentMin),
        endTime: formatTimeOffset(bedDate, currentMin + remDuration),
        durationMinutes: remDuration,
      });
      remMin += remDuration;
      remLeft -= remDuration;
      currentMin += remDuration;
    }

    // 夜醒段：第 2、4、6… 周期各落一段，直到配额用完
    if (cycleNum >= 2
        && wakeSegmentsPlaced < wakeSegmentsTarget && currentMin < totalMin - 20) {
      stages.push({
        stage: 'awake',
        startTime: formatTimeOffset(bedDate, currentMin),
        endTime: formatTimeOffset(bedDate, currentMin + 5),
        durationMinutes: 5,
      });
      awakeMin += 5;
      wakeSegmentsPlaced++;
      currentMin += 5;
    }
  }

  // Final waking period
  if (currentMin < totalMin) {
    const finalDiff = totalMin - currentMin;
    stages.push({
      stage: 'light',
      startTime: formatTimeOffset(bedDate, currentMin),
      endTime: formatTimeOffset(bedDate, totalMin),
      durationMinutes: finalDiff,
    });
    lightMin += finalDiff;
  }

  return {
    stages,
    deepMinutes: deepMin,
    lightMinutes: lightMin,
    remMinutes: remMin,
    awakeMinutes: awakeMin,
  };
}

function formatTimeOffset(baseDate: Date, minutesOffset: number): string {
  const d = new Date(baseDate.getTime() + minutesOffset * 60000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function formatDurationChinese(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分钟`;
  return `${h}小时${m > 0 ? `${m}分` : ''}`;
}

/**
 * 7 Days of realistic pre-seeded initial logs.
 * 数值字段全部从分期推演结果派生（deep/light/rem/awake/时长/得分互相自洽），
 * 手写的只有作息时间、潜伏期与叙事字段——此前手写常量与分期各算各的，
 * 分期总和比声明时长多 30-40 分钟、深睡最多差 61 分钟。
 */
const DEMO_SPEC: Array<{
  id: string;
  /** 相对今天偏移的天数（夜归属：1=昨晚）；写死日期会随时间推移变成"过期演示" */
  daysAgo: number;
  bedtime: string;
  wakeTime: string;
  latencyMinutes: number;
  wakingMood: WakingMood;
  preSleepHabits: string[];
  dreamNotes?: string;
}> = [
  {
    id: 'log-7',
    daysAgo: 1, // 昨晚（夜归属：date=昨天；23:15 放下睡到 07:10）
    bedtime: '23:15',
    wakeTime: '07:10',
    latencyMinutes: 14,
    wakingMood: 'refreshed',
    preSleepHabits: ['reading', 'hot_bath', 'meditation'],
    dreamNotes: '梦见在海边森林散步，微风徐徐，很舒服。',
  },
  { id: 'log-6', daysAgo: 2, bedtime: '23:45', wakeTime: '07:00', latencyMinutes: 22, wakingMood: 'neutral', preSleepHabits: ['screen_time'] },
  { id: 'log-5', daysAgo: 3, bedtime: '00:20', wakeTime: '07:30', latencyMinutes: 28, wakingMood: 'tired', preSleepHabits: ['screen_time', 'caffeine'], dreamNotes: '赶公交车迟到的紧张梦境。' },
  { id: 'log-4', daysAgo: 4, bedtime: '23:30', wakeTime: '08:00', latencyMinutes: 12, wakingMood: 'refreshed', preSleepHabits: ['meditation', 'reading'] },
  { id: 'log-3', daysAgo: 5, bedtime: '23:10', wakeTime: '06:55', latencyMinutes: 16, wakingMood: 'neutral', preSleepHabits: ['hot_bath'] },
  { id: 'log-2', daysAgo: 6, bedtime: '01:05', wakeTime: '07:15', latencyMinutes: 35, wakingMood: 'groggy', preSleepHabits: ['screen_time', 'alcohol'] },
  { id: 'log-1', daysAgo: 7, bedtime: '23:00', wakeTime: '07:05', latencyMinutes: 15, wakingMood: 'refreshed', preSleepHabits: ['meditation'] },
];

export function getInitialSleepLogs(): SleepRecord[] {
  return DEMO_SPEC.map((spec) => {
    const date = localDateOffset(-spec.daysAgo);
    const gen = generateSleepStages(spec.bedtime, spec.wakeTime, spec.latencyMinutes);
    const durationMinutes = gen.deepMinutes + gen.lightMinutes + gen.remMinutes; // 总窗 - 清醒
    // 夜醒次数 = 除入睡潜伏期外的清醒段数
    const wakeCount = Math.max(0, gen.stages.filter((s) => s.stage === 'awake').length - 1);
    const { score, efficiency } = calculateSleepScore(
      durationMinutes,
      gen.deepMinutes,
      gen.remMinutes,
      gen.awakeMinutes,
      wakeCount,
      spec.latencyMinutes
    );
    return {
      id: spec.id,
      date,
      bedtime: spec.bedtime,
      wakeTime: spec.wakeTime,
      durationMinutes,
      deepSleepMinutes: gen.deepMinutes,
      lightSleepMinutes: gen.lightMinutes,
      remSleepMinutes: gen.remMinutes,
      awakeMinutes: gen.awakeMinutes,
      sleepScore: score,
      sleepEfficiency: efficiency,
      latencyMinutes: spec.latencyMinutes,
      wakeCount,
      wakingMood: spec.wakingMood,
      preSleepHabits: spec.preSleepHabits,
      dreamNotes: spec.dreamNotes,
      stages: gen.stages,
      ...(spec.id === 'log-7'
        ? {
            soundEvents: [
              { time: '02:40', decibel: 32, label: '翻身微动' },
              { time: '05:15', decibel: 38, label: '轻微呼吸声' },
            ],
          }
        : {}),
    } as SleepRecord;
  });
}
