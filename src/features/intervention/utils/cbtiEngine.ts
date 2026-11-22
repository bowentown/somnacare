import type { SleepRecord, UserProfile } from '../../../shared/types/sleep';
import { nightsOnly } from '../../sleep/utils/recordFilter';
import { computeRegularity } from '../../sleep/utils/sleepRegularity';

export interface CbtiNudge {
  id: string;
  title: string;
  detail: string;
  lessonId: string;
  priority: 'high' | 'medium' | 'steady';
}

export interface CbtiPrescription {
  ready: boolean;
  sampleNights: number;
  neededNights: number;
  headline: string;
  focusLessonId: string;
  metrics: {
    avgLatencyMin: number | null;
    avgEfficiencyPct: number | null;
    avgDurationMin: number | null;
    bedDevMin: number | null;
  };
  nudges: CbtiNudge[];
}

export const CBTI_MIN_NIGHTS = 3;

/**
 * 基于用户已记录的夜睡统计生成非医疗行为建议（纯函数）。
 * 诚实口径：不足 3 晚绝不编造问题诊断，明确提示还需记录的夜数。
 */
export function computeCbtiPrescription(
  records: SleepRecord[],
  profile: UserProfile,
): CbtiPrescription {
  const recent = nightsOnly(records).slice(0, 14);
  if (recent.length < CBTI_MIN_NIGHTS) {
    const needed = CBTI_MIN_NIGHTS - recent.length;
    return {
      ready: false,
      sampleNights: recent.length,
      neededNights: needed,
      headline: `再记录 ${needed} 晚夜睡，即可结合你的作息生成行为建议`,
      focusLessonId: 'anchor-wake',
      metrics: {
        avgLatencyMin: null,
        avgEfficiencyPct: null,
        avgDurationMin: null,
        bedDevMin: null,
      },
      nudges: [],
    };
  }

  const avgLatencyMin = Math.round(
    recent.reduce((sum, r) => sum + (r.latencyMinutes || 15), 0) / recent.length,
  );
  const avgEfficiencyPct = Math.round(
    recent.reduce((sum, r) => sum + (r.sleepEfficiency || 90), 0) / recent.length,
  );
  const avgDurationMin = Math.round(
    recent.reduce((sum, r) => sum + r.durationMinutes, 0) / recent.length,
  );
  const reg = computeRegularity(recent);
  const bedDevMin = reg ? reg.bedDev : null;
  const targetMin = Math.round((profile.targetDurationHours || 8) * 60);

  const nudges: CbtiNudge[] = [];

  if (avgLatencyMin >= 30) {
    nudges.push({
      id: 'latency-high',
      title: `近期平均入睡耗时约 ${avgLatencyMin} 分钟`,
      detail: '建议在真正有困意时再上床，并配合 4-7-8 或 4-6 慢呼练习；若躺下 15–20 分钟仍清醒，可先离床缓冲。',
      lessonId: 'stimulus-control',
      priority: 'high',
    });
  }

  if (avgEfficiencyPct < 85) {
    nudges.push({
      id: 'efficiency-low',
      title: `近期记录的卧床睡眠效率约 ${avgEfficiencyPct}%`,
      detail: '可尝试把上床时间比当前推迟 15 分钟左右，收紧卧床窗口以减少辗转清醒时段。',
      lessonId: 'sleep-efficiency',
      priority: 'high',
    });
  }

  if (bedDevMin !== null && bedDevMin >= 45) {
    nudges.push({
      id: 'bed-irregular',
      title: `近 7 晚就寝波动约 ±${bedDevMin} 分钟`,
      detail: `优先固定每天 ${profile.targetWakeTime} 附近的起床锚点，比强行早睡更容易把作息拉回稳定节奏。`,
      lessonId: 'anchor-wake',
      priority: 'medium',
    });
  }

  if (avgDurationMin < targetMin - 45) {
    const gapMin = targetMin - avgDurationMin;
    nudges.push({
      id: 'duration-short',
      title: `平均时长比目标少约 ${gapMin} 分钟`,
      detail: `建议把睡前收尾仪式提前到 ${profile.targetBedtime} 前 30 分钟，减少刷屏拖延占用的睡眠窗。`,
      lessonId: 'caffeine-buffer',
      priority: 'medium',
    });
  }

  if (nudges.length === 0) {
    nudges.push({
      id: 'steady-maintain',
      title: '近期作息节奏较稳',
      detail: `近 ${recent.length} 晚入睡耗时与效率都在舒适区间，继续保持当前起卧锚点与睡前放松习惯即可。`,
      lessonId: 'two-process',
      priority: 'steady',
    });
  }

  const top = nudges[0];
  return {
    ready: true,
    sampleNights: recent.length,
    neededNights: 0,
    headline: top.priority === 'steady'
      ? `基于近 ${recent.length} 晚记录：节奏稳定，继续巩固睡前习惯`
      : `基于近 ${recent.length} 晚记录：建议优先关注「${top.title}」`,
    focusLessonId: top.lessonId,
    metrics: {
      avgLatencyMin,
      avgEfficiencyPct,
      avgDurationMin,
      bedDevMin,
    },
    nudges: nudges.slice(0, 3),
  };
}
