/**
 * 睡眠事实清单（第 95 轮从 petMoments 拆出）——LLM 数字纪律的唯一数据源。
 *
 * 纪律（dsh-plugin-moments 的核心）：提示词只允许引用这里产出的数字；
 * 返回文案再过数字白名单校验（numbersCheck，在 petMoments）——不在清单里
 * 的数字整条拒收。verify-moments-facts / verify-audit-hardening 两条行为
 * 护栏直接 import 本模块。
 */
import type { SleepRecord, UserProfile } from '../types/sleep';
import { nightsOnly } from './recordFilter';

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 真实事实清单：LLM 只允许引用这里的数字（dsh-plugin-moments 的核心纪律）。
 */
export function buildSleepFacts(
  records: SleepRecord[],
  profile: UserProfile,
  now: Date = new Date(),
): string[] {
  const facts: string[] = [];
  const bedtime = profile?.targetBedtime ?? '23:30';
  // "昨晚"= 昨夜归属键（date=昨天）上的夜睡（第 81 轮收紧，与 petContext
  // 同口径）——此前取"最新一条"，停更几晚后会把几天前的旧记录说成昨晚，
  // 今晚已补录的记录也会在傍晚被当成"昨晚"引用
  const yKey = dateKeyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const nights = nightsOnly(records as SleepRecord[]);
  const lastNight = nights.find((r) => r.date === yKey) ?? null;
  const week = nights.slice(0, 7);

  facts.push(`就寝目标 ${bedtime}`);
  if (lastNight) {
    facts.push(`昨晚睡眠时长 ${fmtDuration(lastNight.durationMinutes)}`);
    facts.push(`昨晚睡眠评分 ${lastNight.sleepScore}/100`);
    facts.push(`入睡效率 ${lastNight.sleepEfficiency}%`);
    // 推算值必须标注——此前把它当实测值讲，且本地模板据它骂人（第七轮缺陷类复发）
    facts.push(`入睡耗时 ${fmtDuration(lastNight.latencyMinutes)}${lastNight.latencyEstimated ? '（按作息推算的估计值）' : ''}`);
    facts.push(`夜醒累计 ${fmtDuration(lastNight.awakeMinutes)}`);
  } else {
    facts.push('昨晚没有睡眠记录');
    if (nights.length) {
      // 有旧记录时如实说停在哪一晚——比只说"没记录"多给 LLM 一句真话
      const gap = Math.round((Date.parse(`${yKey}T12:00:00`) - Date.parse(`${nights[0].date}T12:00:00`)) / 86400000);
      if (gap > 0) facts.push(`最近一次夜睡记录停在 ${gap} 晚前`);
    }
  }
  if (week.length) {
    const avg = Math.round(week.reduce((a, r) => a + r.sleepScore, 0) / week.length);
    facts.push(`近 ${week.length} 晚平均 ${avg} 分`);
  }
  // 本周达标战报（第 29 轮；第 51 轮适配夜归属）：
  //   周 = 周一起算；夜按"放下手机那晚"归属本周（夜归属 date=周一晚 = 本周第 1 夜）。
  //   已度过 = 今天之前本周已过的夜数（周一=0 … 今天不计——今晚尚未发生，
  //   白天查看不能把今晚报成"未记录"）；x = 有记录的夜数；m = 未记录的夜数。
  const dowIdx = (now.getDay() + 6) % 7;            // 周一=0 … 周日=6
  const elapsedSlots = dowIdx;                       // 已度过的夜数（昨晚=最后一块拼图）
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dowIdx);
  const weekDates = new Set<string>();
  for (let i = 0; i < elapsedSlots; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    weekDates.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const weekRecs = nightsOnly(records as SleepRecord[]).filter((r) => weekDates.has(r.date));
  const goodWeek = weekRecs.filter((r) => r.sleepScore >= 80).length;
  const missed = Math.max(0, elapsedSlots - weekRecs.length);
  // 没有记录就不生成战报事实：周一的 0/0 + "全部有记录" 是当众撒谎，
  // 也会让朋友圈配一张只有破折号的怪卡
  if (elapsedSlots > 0 && weekRecs.length > 0) {
    facts.push(`本周已过 ${elapsedSlots} 天，达标 ${goodWeek} 天`);
    facts.push(`本周有记录 ${weekRecs.length} 天，未记录 ${missed} 天`);
    // 逐夜状态（周一起）：2=达标，1=有记录未达标，0=未记录，-=未来
    const slots: string[] = [];
    for (let i = 0; i < 7; i++) {
      if (i >= elapsedSlots) { slots.push('-'); continue; }
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = weekRecs.find((r) => r.date === key);
      slots.push(!rec ? '0' : rec.sleepScore >= 80 ? '2' : '1');
    }
    facts.push(`本周逐夜 ${slots.join('')}`);
  }
  return facts;
}
