import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { deleteSleepRecord, useSleepStore } from '../sleep/store/sleepStore';
import { openEditRecordModal } from '../../shared/store/uiStore';
import { ShareCardModal } from './ShareCardModal';
import { ClinicalSummaryModal } from './ClinicalSummaryModal';
import { TrendsChartsSection } from './TrendsChartsSection';
import { TrendsHistoryList } from './TrendsHistoryList';
import { TrendsSummarySection } from './TrendsSummarySection';
import { TrendsUsageCard } from './TrendsUsageCard';
import { TrendsTagInsightsCard } from './TrendsTagInsightsCard';

/**
 * 趋势主壳（独立懒加载分包，Recharts 与睡眠日历留在此 chunk 内不进首包）：
 * 统一管理当前选中夜 focusDate 与分享卡 / 就诊摘要弹窗。
 */
const TrendsTabInner: React.FC = () => {
  const records = useSleepStore((s) => s.records);
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const chronotype = userProfile.chronotype ?? 'night';

  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showClinical, setShowClinical] = useState(false);

  return (
    <div className={`space-y-3 pb-28 ${theme.textPrimary}`}>
      <TrendsChartsSection
        records={records}
        theme={theme}
        focusDate={focusDate}
        onFocusDate={setFocusDate}
        targetBedtime={userProfile.targetBedtime}
        targetWakeTime={userProfile.targetWakeTime}
      />

      <TrendsHistoryList
        records={records}
        theme={theme}
        focusDate={focusDate}
        onFocusDate={setFocusDate}
        onEditRecord={openEditRecordModal}
        onDeleteRecord={deleteSleepRecord}
      />

      <TrendsSummarySection
        records={records}
        theme={theme}
        chronotype={chronotype}
        targetBedtime={userProfile.targetBedtime}
        targetWakeTime={userProfile.targetWakeTime}
        targetDurationHours={userProfile.targetDurationHours}
        focusDate={focusDate}
        onFocusDate={setFocusDate}
        onUpdateProfile={updateProfile}
        onOpenShare={() => setShowShare(true)}
        onOpenClinical={() => setShowClinical(true)}
      />

      <TrendsUsageCard theme={theme} chronotype={chronotype} />

      <TrendsTagInsightsCard records={records} theme={theme} />

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
