import React from 'react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { TrendsUsageCard } from '../TrendsUsageCard';

export const TrendsUsageSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const chronotype = userProfile.chronotype ?? 'night';

  return (
    <SubpageShell title="手机使用对照" subtitle="本机熄屏与亮屏时刻对照 · 数据仅存本地" theme={theme}>
      <TrendsUsageCard theme={theme} chronotype={chronotype} />
    </SubpageShell>
  );
};
