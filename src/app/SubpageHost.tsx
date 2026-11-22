import React from 'react';
import { useUIStore } from '../shared/store/uiStore';
import { AppearanceSubpage } from '../settings/subpages/AppearanceSubpage';
import { ScheduleSubpage } from '../settings/subpages/ScheduleSubpage';
import { PetSubpage } from '../settings/subpages/PetSubpage';
import { WidgetsSubpage } from '../settings/subpages/WidgetsSubpage';
import { DataSubpage } from '../settings/subpages/DataSubpage';
import { AdSkipSubpage } from '../features/extensions/ad-skip/AdSkipSubpage';
import { WindDownSubpage } from '../features/intervention/WindDownSubpage';
import { PaneErrorBoundary } from '../shared/ui/PaneErrorBoundary';

/**
 * 全局二级子页宿主（Phase 2B）：
 * 订阅 uiStore.subpageStack，渲染栈顶子页，并包在 PaneErrorBoundary 内防止单页异常影响主壳。
 */
export const SubpageHost: React.FC = () => {
  const stack = useUIStore((s) => s.subpageStack);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  if (!top) return null;

  return (
    <PaneErrorBoundary label={top.id}>
      {top.id === 'settings/appearance' && <AppearanceSubpage />}
      {top.id === 'settings/schedule' && <ScheduleSubpage />}
      {top.id === 'settings/pet' && <PetSubpage />}
      {top.id === 'settings/widgets' && <WidgetsSubpage />}
      {top.id === 'settings/data' && (
        <DataSubpage autoCheck={typeof top.params?.autoCheck === 'number' ? top.params.autoCheck : undefined} />
      )}
      {top.id === 'settings/extensions' && <AdSkipSubpage />}
      {top.id === 'intervention/wind-down' && <WindDownSubpage />}
    </PaneErrorBoundary>
  );
};
