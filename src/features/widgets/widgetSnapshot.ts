import type { SleepRecord, UserProfile } from '../../shared/types/sleep';
import type { UserTravelState } from '../pet/types/travel';
import { nightsOnly } from '../sleep/utils/recordFilter';
import { computeSRI } from '../sleep/utils/sleepRegularity';
import { computeWeekReport } from '../trends/utils/weekReport';
import { toLocalDateString } from '../../shared/utils/dateUtils';

export type WidgetThemeId = NonNullable<UserProfile['themeColor']>;
export type WidgetKind = 'score' | 'bedtime' | 'rhythm' | 'pet';
export type WeekDotStatus = 'G' | 'Y' | 'R' | 'N';

export interface WeekDotItem {
  dateKey: string;
  label: string;
  status: WeekDotStatus;
  score: number | null;
}

export interface WidgetSnapshot {
  themeId: WidgetThemeId;
  lastScore: number | null;
  lastDurationMin: number | null;
  streakNights: number;
  sleepDebtMin: number;
  sriScore: number | null;
  weekDots: WeekDotItem[];
  targetBedtime: string;
  eyeCareEnabled: boolean;
  petMood: string;
  petEnergyPct: number;
}

export interface NativeWidgetPayload {
  themeId: WidgetThemeId;
  lastScore: number;
  lastDurationMin: number;
  streakNights: number;
  sleepDebtMin: number;
  sriScore: number;
  weekDots: string;
  targetBedtime: string;
  eyeCareEnabled: boolean;
  petMood: string;
  petEnergyPct: number;
}

const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

function pickPetMood(
  lastScore: number | null,
  streakNights: number,
  energyPct: number,
  targetBedtime: string,
): string {
  if (energyPct >= 90) return '梦境能量快满啦，随时准备出发旅行！';
  if (streakNights >= 7) return `连续达标 ${streakNights} 晚，本鱼为你骄傲～`;
  if (lastScore !== null && lastScore >= 85) return '昨晚睡得真香，今天精力满满！';
  if (lastScore !== null && lastScore < 65) return `昨晚有点累，今晚 ${targetBedtime} 早点休息吧`;
  if (lastScore !== null) return `今晚记得 ${targetBedtime} 准时放手机哦`;
  return '记下第一晚睡眠，帮大肥鱼攒旅行能量吧';
}

/**
 * 构造桌面 4 款小组件的唯一事实快照（纯函数，可直接单测）。
 * 诚实口径：无记录时 lastScore/lastDurationMin 为 null；SRI 样本不足为 null。
 */
export function buildWidgetSnapshot(
  records: SleepRecord[],
  profile: UserProfile,
  travel: Pick<UserTravelState, 'currentEnergy' | 'targetEnergy'>,
  now: Date = new Date(),
): WidgetSnapshot {
  const nights = nightsOnly(records);
  const latest = nights[0] ?? null;
  const weekReport = computeWeekReport(records, now);
  const sri = computeSRI(records, profile.chronotype ?? 'night', now, 14);

  const byDate = new Map<string, SleepRecord>();
  for (const r of nights) {
    if (!byDate.has(r.date)) byDate.set(r.date, r);
  }

  // 近 7 晚：从 7 天前到昨晚（与夜归属 dateKey 对齐）
  const weekDots: WeekDotItem[] = [];
  let sleepDebtMin = 0;
  const targetMin = Math.round((profile.targetDurationHours || 8) * 60);

  for (let offset = 7; offset >= 1; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const dateKey = toLocalDateString(d);
    const rec = byDate.get(dateKey);
    const label = offset === 1 ? '昨' : WEEKDAY_SHORT[d.getDay()];
    if (!rec) {
      weekDots.push({ dateKey, label, status: 'N', score: null });
    } else {
      const status: WeekDotStatus =
        rec.sleepScore >= 80 ? 'G' : rec.sleepScore >= 60 ? 'Y' : 'R';
      weekDots.push({ dateKey, label, status, score: rec.sleepScore });
      if (rec.durationMinutes < targetMin) {
        sleepDebtMin += targetMin - rec.durationMinutes;
      }
    }
  }

  const targetBedtime = profile.targetBedtime || '23:30';
  const energyDenom = Math.max(1, travel.targetEnergy || 200);
  const petEnergyPct = Math.max(0, Math.min(100, Math.round((travel.currentEnergy / energyDenom) * 100)));

  return {
    themeId: profile.themeColor || 'midnight',
    lastScore: latest ? latest.sleepScore : null,
    lastDurationMin: latest ? latest.durationMinutes : null,
    streakNights: weekReport.streak,
    sleepDebtMin,
    sriScore: sri ? sri.sri : null,
    weekDots,
    targetBedtime,
    eyeCareEnabled: !!profile.eyeCare?.enabled,
    petMood: pickPetMood(latest ? latest.sleepScore : null, weekReport.streak, petEnergyPct, targetBedtime),
    petEnergyPct,
  };
}

/** 转为原生 SleepWidgetsPlugin.syncSnapshot 接受的扁平结构（null 统一编码为 -1）。 */
export function toNativeWidgetPayload(snapshot: WidgetSnapshot): NativeWidgetPayload {
  return {
    themeId: snapshot.themeId,
    lastScore: snapshot.lastScore ?? -1,
    lastDurationMin: snapshot.lastDurationMin ?? -1,
    streakNights: snapshot.streakNights,
    sleepDebtMin: snapshot.sleepDebtMin,
    sriScore: snapshot.sriScore ?? -1,
    weekDots: snapshot.weekDots.map((d) => d.status).join(','),
    targetBedtime: snapshot.targetBedtime,
    eyeCareEnabled: snapshot.eyeCareEnabled,
    petMood: snapshot.petMood,
    petEnergyPct: snapshot.petEnergyPct,
  };
}
