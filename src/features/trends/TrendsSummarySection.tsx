import React from 'react';
import { Share2, Sparkles } from 'lucide-react';
import type { SleepRecord, UserProfile } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { computeSRI, regularityTier } from '../sleep/utils/sleepRegularity';
import { summarizeWeek } from './utils/weekSummary';
import { computeWeekReport } from './utils/weekReport';
import { nightsOnly } from '../sleep/utils/recordFilter';
import { computeMSFsc, computeSleepDebt, computeSleepNeed, formatDurationChinese } from '../sleep/utils/sleepScore';
import { computeSuggestedSchedule } from '../sleep/utils/scheduleSuggestion';
import { SleepRhythmChart } from './SleepRhythmChart';
import { DurationValue } from '../../shared/ui';

interface TrendsSummarySectionProps {
  records: SleepRecord[];
  theme: ThemeConfig;
  chronotype: 'night' | 'day' | 'irregular';
  targetBedtime?: string;
  targetWakeTime?: string;
  targetDurationHours?: number;
  onUpdateProfile: (patch: Partial<UserProfile>) => void;
  onOpenShare: () => void;
}

export const TrendsSummarySection: React.FC<TrendsSummarySectionProps> = React.memo(function TrendsSummarySection({
  records,
  theme,
  chronotype,
  targetBedtime,
  targetWakeTime,
  targetDurationHours,
  onUpdateProfile,
  onOpenShare,
}) {
  if (records.length === 0) return null;

  const innerBg = theme.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme.cardInnerBorder || 'border-slate-700/80';
  const textMuted = theme.textMuted || 'text-slate-400';

  const sum = summarizeWeek(records);
  const weekReport = computeWeekReport(records);
  const sri = computeSRI(records, chronotype);
  const need = computeSleepNeed(records, Math.round((targetDurationHours || 8) * 60), chronotype);
  const msf = computeMSFsc(records, chronotype);
  const debt = computeSleepDebt(records, need.needMinutes, chronotype);

  const scheduleSuggestion = computeSuggestedSchedule(need.needMinutes, msf ? msf.msfMinutes : null, {
    bed: targetBedtime ?? '23:30',
    wake: targetWakeTime ?? '07:30',
    durationHours: targetDurationHours ?? 8,
  });

  const recentNights = nightsOnly(records).slice(0, 7);
  const avgEfficiency = recentNights.length
    ? Math.round(recentNights.reduce((a, r) => a + r.sleepEfficiency, 0) / recentNights.length)
    : null;

  return (
    <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
        <h3 className="text-sm font-bold text-white">近期睡眠小结</h3>
        <span className={`text-[10px] ${textMuted} font-mono`}>近 {sum.nights} 晚</span>
        <div className="ml-auto mr-1 flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenShare();
            }}
            aria-label="生成每周睡眠分享卡"
            className={`flex items-center justify-center gap-1 px-3 py-2 min-h-10 rounded-full ${theme.accentBg} ${theme.accentFg} text-[10px] font-bold cursor-pointer active:scale-95 transition-transform`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>分享周报</span>
          </button>
        </div>
      </div>

      {sum.avgScore === null || sum.avgDurationMin === null || avgEfficiency === null ? (
        <p className={`text-[11px] ${textMuted} leading-relaxed`}>
          还没有夜睡记录——白天的午睡不计入周小结。
        </p>
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <span className={`text-[10px] ${textMuted} block`}>平均评分</span>
            <span className={`text-4xl leading-none font-display font-bold tabular-nums ${theme.accentText}`}>
              {sum.avgScore}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1.5 pb-0.5">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-[10px] ${textMuted}`}>日均时长</span>
              <DurationValue minutes={sum.avgDurationMin} className="text-base text-white" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={`text-[10px] ${textMuted}`}>平均效率</span>
              <span className="font-display font-bold tabular-nums text-base text-emerald-400">
                {avgEfficiency}
                <span className="text-[10px] font-medium tracking-wide">%</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {sum.regularity ? (
        <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 space-y-1.5`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-200">作息规律度</span>
            <span
              className={`font-display font-bold text-lg ${
                sum.regularity.score >= 80
                  ? 'text-emerald-400'
                  : sum.regularity.score >= 50
                    ? 'text-amber-400'
                    : 'text-rose-400'
              }`}
            >
              {sum.regularity.score}
            </span>
          </div>
          <p className={`text-[10px] ${textMuted} leading-relaxed`}>
            就寝 ±{sum.regularity.bedDev} 分钟 · 起床 ±{sum.regularity.wakeDev} 分钟 ·{' '}
            {regularityTier(sum.regularity.score) === 'steady'
              ? '作息很稳'
              : regularityTier(sum.regularity.score) === 'ok'
                ? '基本规律'
                : '作息波动大'}
          </p>
          {sri && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-slate-400">SRI</span>
              <span className="font-display font-bold text-sm text-slate-200">{sri.sri}</span>
            </div>
          )}
          <SleepRhythmChart records={records} accentHex={theme.accentHex} />
        </div>
      ) : (
        <p className={`text-[11px] ${textMuted} leading-relaxed`}>
          📊 记录满 3 晚后，这里会显示作息规律度（就寝与起床的稳定程度）
        </p>
      )}

      <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 space-y-1.5`}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-200">睡眠需求</span>
          <span className={`font-display font-bold text-lg ${theme.accentText}`}>
            {formatDurationChinese(need.needMinutes)}
          </span>
        </div>
        {scheduleSuggestion && (
          <button
            type="button"
            data-no-swipe
            aria-label={`按科学建议采用作息：${scheduleSuggestion.bed} 入睡，${scheduleSuggestion.wake} 醒来`}
            onClick={() =>
              onUpdateProfile({
                targetBedtime: scheduleSuggestion.bed,
                targetWakeTime: scheduleSuggestion.wake,
                targetDurationHours: scheduleSuggestion.durationHours,
              })
            }
            className={`w-full flex items-center justify-between gap-2 min-h-10 px-3 rounded-xl border ${theme.cardInnerBorder} ${theme.cardInnerBg} cursor-pointer active:scale-[0.98] transition-transform`}
          >
            <span className="text-[11px] font-bold text-slate-200">
              按科学建议采用 <span className="font-mono">{scheduleSuggestion.bed} – {scheduleSuggestion.wake}</span>
            </span>
            <span className={`text-[10px] font-bold ${theme.accentText}`}>
              {scheduleSuggestion.basis === 'msf' ? 'MSFsc 锚定' : '需求推算'}
            </span>
          </button>
        )}
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span>MSFsc {msf ? msf.label : '—'}</span>
          {debt.nights >= 3 && debt.debtMinutes >= 30 && (
            <span>睡债 +{formatDurationChinese(debt.debtMinutes)}</span>
          )}
        </div>
        {need.basis !== 'personal' && (
          <p className={`text-[10px] ${textMuted} leading-relaxed`}>记录满 5 晚后改用个人基线</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        {weekReport.streak > 0 && (
          <p className={`text-[11px] font-bold ${theme.accentText}`}>
            🔥 连续达标 {weekReport.streak} 晚{weekReport.graceUsed ? '（今晚续上）' : ''}
          </p>
        )}
        {sum.best && (
          <p className={`text-[11px] ${textMuted}`}>
            最佳 <span className="text-white font-bold">{sum.best.date}</span> · {sum.best.sleepScore} 分
          </p>
        )}
      </div>
    </div>
  );
});
