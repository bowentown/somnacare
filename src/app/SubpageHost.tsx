import React, { Suspense, lazy } from 'react';
import { useUIStore } from '../shared/store/uiStore';
import { AppearanceSubpage } from '../settings/subpages/AppearanceSubpage';
import { ScheduleSubpage } from '../settings/subpages/ScheduleSubpage';
import { PetSubpage } from '../settings/subpages/PetSubpage';
import { DataSubpage } from '../settings/subpages/DataSubpage';
import { AdSkipSubpage } from '../features/extensions/ad-skip/AdSkipSubpage';
import { PaneErrorBoundary } from '../shared/ui/PaneErrorBoundary';

// 进阶二级子页按需懒加载，保证首屏主包轻量
const WidgetsSubpage = lazy(() =>
  import('../settings/subpages/WidgetsSubpage').then((m) => ({ default: m.WidgetsSubpage })),
);
const WindDownSubpage = lazy(() =>
  import('../features/intervention/WindDownSubpage').then((m) => ({ default: m.WindDownSubpage })),
);
const TrendsHistorySubpage = lazy(() =>
  import('../features/trends/subpages/TrendsHistorySubpage').then((m) => ({ default: m.TrendsHistorySubpage })),
);
const TrendsCalendarSubpage = lazy(() =>
  import('../features/trends/subpages/TrendsCalendarSubpage').then((m) => ({ default: m.TrendsCalendarSubpage })),
);
const TrendsUsageSubpage = lazy(() =>
  import('../features/trends/subpages/TrendsUsageSubpage').then((m) => ({ default: m.TrendsUsageSubpage })),
);
const EyeCareScheduleSubpage = lazy(() =>
  import('../features/eyecare/subpages/EyeCareScheduleSubpage').then((m) => ({ default: m.EyeCareScheduleSubpage })),
);
const EyeCareHealthSubpage = lazy(() =>
  import('../features/eyecare/subpages/EyeCareHealthSubpage').then((m) => ({ default: m.EyeCareHealthSubpage })),
);

/**
 * 全局二级子页宿主（Phase 2B & Phase 6）：
 * 订阅 uiStore.subpageStack，渲染栈顶子页，并包在 PaneErrorBoundary 内防止单页异常影响主壳。
 */
export const SubpageHost: React.FC = () => {
  const stack = useUIStore((s) => s.subpageStack);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  if (!top) return null;

  return (
    <PaneErrorBoundary label={top.id}>
      <Suspense fallback={null}>
        {top.id === 'settings/appearance' && <AppearanceSubpage />}
        {top.id === 'settings/schedule' && <ScheduleSubpage />}
        {top.id === 'settings/pet' && <PetSubpage />}
        {top.id === 'settings/widgets' && <WidgetsSubpage />}
        {top.id === 'settings/data' && (
          <DataSubpage autoCheck={typeof top.params?.autoCheck === 'number' ? top.params.autoCheck : undefined} />
        )}
        {top.id === 'settings/extensions' && <AdSkipSubpage />}
        {top.id === 'intervention/wind-down' && <WindDownSubpage />}
        {top.id === 'trends/history' && <TrendsHistorySubpage />}
        {top.id === 'trends/calendar' && <TrendsCalendarSubpage />}
        {top.id === 'trends/usage' && <TrendsUsageSubpage />}
        {top.id === 'eyecare/schedule' && <EyeCareScheduleSubpage />}
        {top.id === 'eyecare/health' && <EyeCareHealthSubpage />}
      </Suspense>
    </PaneErrorBoundary>
  );
};
