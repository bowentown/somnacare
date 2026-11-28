import React, { Suspense, lazy } from 'react';
import { getCurrentTheme, useProfileStore } from '../shared/store/profileStore';
import { useUIStore } from '../shared/store/uiStore';
import { PaneErrorBoundary } from '../shared/ui/PaneErrorBoundary';

// 全部二级子页按需懒加载，保证首屏主包轻量
const AppearanceSubpage = lazy(() =>
  import('../settings/subpages/AppearanceSubpage').then((m) => ({ default: m.AppearanceSubpage })),
);
const ScheduleSubpage = lazy(() =>
  import('../settings/subpages/ScheduleSubpage').then((m) => ({ default: m.ScheduleSubpage })),
);
const PetSubpage = lazy(() =>
  import('../settings/subpages/PetSubpage').then((m) => ({ default: m.PetSubpage })),
);
const DataSubpage = lazy(() =>
  import('../settings/subpages/DataSubpage').then((m) => ({ default: m.DataSubpage })),
);
const AdSkipSubpage = lazy(() =>
  import('../features/extensions/ad-skip/AdSkipSubpage').then((m) => ({ default: m.AdSkipSubpage })),
);
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
      <Suspense fallback={<SubpageSkeleton />}>
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

const SubpageSkeleton: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  return (
    <div
      aria-hidden
      className={`fixed inset-0 z-[60] ${theme.pageBg} ${theme.textPrimary} flex flex-col overflow-hidden`}
    >
      <div className="w-full flex-1 max-w-lg mx-auto p-4 space-y-3">
        <div className="h-9 w-36 rounded-xl bg-slate-800/50" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-3xl border border-slate-700/60 bg-slate-900/40 p-5">
            <div className="h-3 w-24 rounded-full bg-slate-700/60" />
            <div className="mt-3 h-24 rounded-2xl bg-slate-800/50" />
          </div>
        ))}
      </div>
    </div>
  );
};
