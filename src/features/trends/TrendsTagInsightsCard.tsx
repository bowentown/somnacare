import React, { useMemo } from 'react';
import { Sparkles, Tag } from 'lucide-react';
import type { SleepRecord } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { useInterventionStore } from '../intervention/store/interventionStore';
import { computeTagCorrelations, MIN_TAGGED_NIGHTS } from '../intervention/utils/tagCorrelation';
import { handleDeepLink } from '../../shared/store/uiStore';

interface TrendsTagInsightsCardProps {
  records: SleepRecord[];
  theme: ThemeConfig;
}

function fmtSigned(n: number, unit: string): string {
  if (n > 0) return `+${n}${unit}`;
  if (n < 0) return `${n}${unit}`;
  return `持平`;
}

/**
 * 睡前习惯 & 自定义标签关联洞察卡（位于懒加载 TrendsTab chunk 内）：
 * 严格遵循 ≥5 晚诚实门槛——未满 5 晚只展示进度条，绝不伪造小样本相关性。
 */
export const TrendsTagInsightsCard: React.FC<TrendsTagInsightsCardProps> = ({ records, theme }) => {
  const customTags = useInterventionStore((s) => s.customTags);
  const report = useMemo(() => computeTagCorrelations(records, customTags), [records, customTags]);

  return (
    <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} shadow-xl space-y-3`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Tag className={`w-4 h-4 ${theme.accentText}`} />
          <h3 className="text-sm font-black text-white">睡前标签关联洞察</h3>
        </div>
        <button
          type="button"
          onClick={() => handleDeepLink('intervention/wind-down')}
          className={`text-[11px] font-bold ${theme.accentText} cursor-pointer`}
        >
          管理标签 →
        </button>
      </div>

      {report.unlocked.length > 0 ? (
        <div className="space-y-2">
          {report.unlocked.slice(0, 5).map((item) => {
            const positive = item.scoreDelta > 0;
            const negative = item.scoreDelta < 0;
            return (
              <div
                key={item.id}
                className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl px-3.5 py-2.5 flex items-center justify-between gap-3`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span>{item.emoji}</span>
                    <span className="text-xs font-bold text-slate-100 truncate">{item.label}</span>
                    <span className="text-[10px] text-slate-500 shrink-0">
                      ({item.taggedNights} 晚 vs {item.untaggedNights} 晚)
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    时长 {fmtSigned(item.durationDeltaMin, ' 分钟')} · 入睡耗时 {fmtSigned(item.latencyDeltaMin, ' 分钟')}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-xl text-xs font-black font-display tabular-nums shrink-0 ${
                    positive
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/35'
                      : negative
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-400/35'
                        : 'bg-slate-800 text-slate-300 border border-slate-700'
                  }`}
                >
                  评分 {fmtSigned(item.scoreDelta, ' 分')}
                </span>
              </div>
            );
          })}
          <p className="text-[10px] text-slate-500">
            基于你个人记录的统计对照（单标签 ≥{MIN_TAGGED_NIGHTS} 晚解锁），仅供参考，不构成因果或医疗结论。
          </p>
        </div>
      ) : (
        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 space-y-2`}>
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
            <Sparkles className={`w-3.5 h-3.5 ${theme.accentText}`} />
            <span>
              {report.locked.length > 0
                ? '已有习惯标签正在累积样本，满 5 晚自动解锁对比'
                : '记录夜睡时勾选睡前习惯，满 5 晚解锁个人影响对比'}
            </span>
          </div>
          {report.locked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {report.locked.slice(0, 6).map((item) => (
                <span
                  key={item.id}
                  className="px-2.5 py-1 rounded-xl bg-slate-900/90 border border-slate-800 text-[10px] text-slate-300 font-medium"
                >
                  {item.emoji} {item.label} · {item.taggedNights}/{MIN_TAGGED_NIGHTS} 晚
                  {item.neededNights > 0 ? `（还差 ${item.neededNights} 晚）` : '（需至少 2 晚对照）'}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
