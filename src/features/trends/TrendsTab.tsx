import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronRight, History, Smartphone, Stethoscope } from 'lucide-react';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../sleep/store/sleepStore';
import { pushSubpage } from '../../shared/store/uiStore';
import { tapTick } from '../../shared/utils/haptics';
import { napsOnly, nightsOnly } from '../sleep/utils/recordFilter';
import { isNativePlatform } from '../sleep/utils/nativeAlarmScheduler';
import { ShareCardModal } from './ShareCardModal';
import { ClinicalSummaryModal } from './ClinicalSummaryModal';
import { TrendsChartsSection } from './TrendsChartsSection';
import { TrendsSummarySection } from './TrendsSummarySection';

/**
 * 趋势主屏（极简偏好式结构）：
 * 主屏只留「近 7 晚核心图表 + 精简近期小结」，
 * 将「历史记录 / 睡眠日历 / 手机使用对照 / 就诊摘要」收进清爽二级目录行。
 */
const TrendsTabInner: React.FC = () => {
  const records = useSleepStore((s) => s.records);
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const chronotype = userProfile.chronotype ?? 'night';
  const native = isNativePlatform();

  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showClinical, setShowClinical] = useState(false);

  const nightCount = nightsOnly(records).length;
  const napCount = napsOnly(records).length;

  return (
    <div className={`space-y-3.5 pb-28 ${theme.textPrimary}`}>
      <TrendsChartsSection
        records={records}
        theme={theme}
        focusDate={focusDate}
        onFocusDate={setFocusDate}
        targetBedtime={userProfile.targetBedtime}
        targetWakeTime={userProfile.targetWakeTime}
      />

      <TrendsSummarySection
        records={records}
        theme={theme}
        chronotype={chronotype}
        targetBedtime={userProfile.targetBedtime}
        targetWakeTime={userProfile.targetWakeTime}
        targetDurationHours={userProfile.targetDurationHours}
        onUpdateProfile={updateProfile}
        onOpenShare={() => setShowShare(true)}
      />

      {/* 偏好式清爽二级目录：收起低频明细与工具 */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl divide-y divide-slate-700/50 overflow-hidden`}>
        <button
          type="button"
          onClick={() => {
            tapTick();
            pushSubpage('trends/history');
          }}
          className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <History className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">历史记录</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">全部睡眠记录浏览、编辑与删除</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-slate-400">
              {nightCount} 夜{napCount > 0 ? ` · ${napCount} 小睡` : ''}
            </span>
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            tapTick();
            pushSubpage('trends/calendar');
          }}
          className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <CalendarDays className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">睡眠日历</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">按月点选回看当夜效率与枕边声事件</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-slate-400">月视图</span>
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
        </button>

        {native && (
          <button
            type="button"
            onClick={() => {
              tapTick();
              pushSubpage('trends/usage');
            }}
            className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-black text-white">手机使用对照</h3>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">昨晚真正放下与晨起拿起时刻对照</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] font-bold text-slate-400">仅存本机</span>
              <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
            </div>
          </button>
        )}

        {records.length > 0 && (
          <button
            type="button"
            aria-label="生成就诊摘要"
            onClick={() => {
              tapTick();
              setShowClinical(true);
            }}
            className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
                <Stethoscope className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-black text-white">生成就诊摘要</h3>
                <p className="text-[10px] text-slate-400 truncate mt-0.5">导出客观睡眠统计长图供门诊沟通参考</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] font-bold text-slate-400">预览与下载</span>
              <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
            </div>
          </button>
        )}
      </div>

      {createPortal(
        <ShareCardModal open={showShare} onClose={() => setShowShare(false)} records={records} theme={theme} />,
        document.body,
      )}
      {createPortal(
        <ClinicalSummaryModal open={showClinical} onClose={() => setShowClinical(false)} records={records} theme={theme} />,
        document.body,
      )}
    </div>
  );
};

export const TrendsTab = React.memo(TrendsTabInner);
