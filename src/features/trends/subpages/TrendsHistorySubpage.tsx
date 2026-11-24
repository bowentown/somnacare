import React, { useState } from 'react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { deleteSleepRecord, useSleepStore } from '../../sleep/store/sleepStore';
import { openEditRecordModal } from '../../../shared/store/uiStore';
import { napsOnly, nightsOnly } from '../../sleep/utils/recordFilter';
import { TrendsHistoryList } from '../TrendsHistoryList';

export const TrendsHistorySubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);
  const [focusDate, setFocusDate] = useState<string | null>(null);

  return (
    <SubpageShell
      title="历史记录"
      subtitle={`共 ${nightsOnly(records).length} 晚夜睡 · ${napsOnly(records).length} 次小睡`}
      theme={theme}
    >
      <TrendsHistoryList
        records={records}
        theme={theme}
        focusDate={focusDate}
        onFocusDate={setFocusDate}
        onEditRecord={openEditRecordModal}
        onDeleteRecord={deleteSleepRecord}
        defaultExpanded
      />
    </SubpageShell>
  );
};
