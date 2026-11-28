import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentTheme, useProfileStore } from '../shared/store/profileStore';
import { useUIStore, type SubpageEntry, type SubpageId } from '../shared/store/uiStore';
import type { NavTab } from '../shared/ui/BottomNavBar';
import { MOTION } from '../shared/utils/motionTokens';
import { PaneErrorBoundary } from '../shared/ui/PaneErrorBoundary';

// 统一子页模块加载器：lazy() 与按 Tab 空闲预热共用同一份 import，零首屏包体增长且点开 0ms 就绪
const SUBPAGE_LOADERS = {
  'settings/appearance': () => import('../settings/subpages/AppearanceSubpage'),
  'settings/schedule': () => import('../settings/subpages/ScheduleSubpage'),
  'settings/pet': () => import('../settings/subpages/PetSubpage'),
  'settings/data': () => import('../settings/subpages/DataSubpage'),
  'settings/extensions': () => import('../features/extensions/ad-skip/AdSkipSubpage'),
  'settings/widgets': () => import('../settings/subpages/WidgetsSubpage'),
  'intervention/wind-down': () => import('../features/intervention/WindDownSubpage'),
  'trends/history': () => import('../features/trends/subpages/TrendsHistorySubpage'),
  'trends/calendar': () => import('../features/trends/subpages/TrendsCalendarSubpage'),
  'trends/usage': () => import('../features/trends/subpages/TrendsUsageSubpage'),
  'eyecare/schedule': () => import('../features/eyecare/subpages/EyeCareScheduleSubpage'),
  'eyecare/health': () => import('../features/eyecare/subpages/EyeCareHealthSubpage'),
} as const;

const TAB_SUBPAGES: Partial<Record<NavTab, readonly SubpageId[]>> = {
  today: ['intervention/wind-down', 'settings/schedule'],
  trends: ['trends/history', 'trends/calendar', 'trends/usage'],
  eyecare: ['eyecare/schedule', 'eyecare/health'],
  settings: [
    'settings/appearance',
    'settings/schedule',
    'settings/pet',
    'settings/extensions',
    'settings/widgets',
    'settings/data',
  ],
};

const prefetchedSubpages = new Set<SubpageId>();

function prefetchSubpagesForTab(tab: NavTab): void {
  const ids = TAB_SUBPAGES[tab];
  if (!ids) return;
  for (const id of ids) {
    if (prefetchedSubpages.has(id)) continue;
    prefetchedSubpages.add(id);
    void SUBPAGE_LOADERS[id]().catch(() => {
      prefetchedSubpages.delete(id);
    });
  }
}

const AppearanceSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/appearance']().then((m) => ({ default: m.AppearanceSubpage })),
);
const ScheduleSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/schedule']().then((m) => ({ default: m.ScheduleSubpage })),
);
const PetSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/pet']().then((m) => ({ default: m.PetSubpage })),
);
const DataSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/data']().then((m) => ({ default: m.DataSubpage })),
);
const AdSkipSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/extensions']().then((m) => ({ default: m.AdSkipSubpage })),
);
const WidgetsSubpage = lazy(() =>
  SUBPAGE_LOADERS['settings/widgets']().then((m) => ({ default: m.WidgetsSubpage })),
);
const WindDownSubpage = lazy(() =>
  SUBPAGE_LOADERS['intervention/wind-down']().then((m) => ({ default: m.WindDownSubpage })),
);
const TrendsHistorySubpage = lazy(() =>
  SUBPAGE_LOADERS['trends/history']().then((m) => ({ default: m.TrendsHistorySubpage })),
);
const TrendsCalendarSubpage = lazy(() =>
  SUBPAGE_LOADERS['trends/calendar']().then((m) => ({ default: m.TrendsCalendarSubpage })),
);
const TrendsUsageSubpage = lazy(() =>
  SUBPAGE_LOADERS['trends/usage']().then((m) => ({ default: m.TrendsUsageSubpage })),
);
const EyeCareScheduleSubpage = lazy(() =>
  SUBPAGE_LOADERS['eyecare/schedule']().then((m) => ({ default: m.EyeCareScheduleSubpage })),
);
const EyeCareHealthSubpage = lazy(() =>
  SUBPAGE_LOADERS['eyecare/health']().then((m) => ({ default: m.EyeCareHealthSubpage })),
);

const EXIT_FALLBACK_MS = 210;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 全局二级子页宿主（v1.44.1 顺滑推入与零闪帧重构）：
 * - 统一持有唯一的不透明 fixed inset-0 z-[60] GPU 推入/退场容器，彻底消除
 *   「骨架屏 1 帧 → opacity:0 透底闪回主界面 → 淡入」的三连闪；
 * - 停留在某个 Tab 时在空闲窗口静默预热其二级子页 chunk，首次点击即 0ms 就绪；
 * - 退场首帧立即置 aria-hidden + pointer-events-none，丝滑右滑退出且零阻挡后续操作。
 */
export const SubpageHost: React.FC = () => {
  const activeTab = useUIStore((s) => s.activeTab);
  const stack = useUIStore((s) => s.subpageStack);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);

  const [rendered, setRendered] = useState<SubpageEntry | null>(top);
  const exitTimerRef = useRef<number | null>(null);
  const prevTabRef = useRef<NavTab>(activeTab);

  // 退场期间若用户立刻切去别的底栏 Tab，直接收尾旧子页，避免旧页从新 Tab 上划过
  useLayoutEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      if (!top && rendered) {
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        setRendered(null);
      }
    }
  }, [activeTab, top, rendered]);

  // 开屏结束后的空闲窗口预热当前分区下属的二级子页 chunk（不阻塞首屏、不增大主包）
  useEffect(() => {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const cancelRic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;

    const kickoff = (): (() => void) => {
      if (ric) {
        const id = ric(() => prefetchSubpagesForTab(activeTab), { timeout: 600 });
        return () => cancelRic?.(id);
      }
      const id = window.setTimeout(() => prefetchSubpagesForTab(activeTab), 80);
      return () => window.clearTimeout(id);
    };

    // 仅首屏 today 避让开屏动画窗口；用户已主动切换到其他分区时立即在空闲帧预热，点开 0ms 就绪
    const waitMs =
      activeTab === 'today' ? Math.max(0, MOTION.splashMinMs + MOTION.splashFadeMs - performance.now()) : 0;
    let cancelInner: (() => void) | null = null;
    let outer = 0;
    if (waitMs > 0) {
      outer = window.setTimeout(() => {
        cancelInner = kickoff();
      }, waitMs);
    } else {
      cancelInner = kickoff();
    }
    return () => {
      if (outer) window.clearTimeout(outer);
      cancelInner?.();
    };
  }, [activeTab]);

  // 同步管理推入与退场生命周期（useLayoutEffect 避免额外 1 帧空拍）
  useLayoutEffect(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (top) {
      setRendered(top);
      return;
    }

    if (!rendered) return;

    if (prefersReducedMotion()) {
      setRendered(null);
      return;
    }

    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setRendered(null);
    }, EXIT_FALLBACK_MS);
  }, [top, rendered]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  const displayEntry = top ?? rendered;
  if (!displayEntry) return null;

  const isClosing = !top;

  return (
    <div
      key={displayEntry.id}
      data-no-swipe
      data-subpage-phase={isClosing ? 'out' : 'in'}
      aria-hidden={isClosing || undefined}
      onAnimationEnd={(e) => {
        if (!isClosing || e.target !== e.currentTarget || e.animationName !== 'subpage-push-out') return;
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        setRendered(null);
      }}
      className={`fixed inset-0 z-[60] ${theme.pageBg} ${theme.textPrimary} flex flex-col overflow-hidden ${
        isClosing ? 'animate-subpage-out pointer-events-none' : 'animate-subpage-in'
      }`}
    >
      <PaneErrorBoundary label={displayEntry.id}>
        <Suspense fallback={<DelayedSubpageFallback />}>
          {displayEntry.id === 'settings/appearance' && <AppearanceSubpage />}
          {displayEntry.id === 'settings/schedule' && <ScheduleSubpage />}
          {displayEntry.id === 'settings/pet' && <PetSubpage />}
          {displayEntry.id === 'settings/widgets' && <WidgetsSubpage />}
          {displayEntry.id === 'settings/data' && (
            <DataSubpage
              autoCheck={
                typeof displayEntry.params?.autoCheck === 'number' ? displayEntry.params.autoCheck : undefined
              }
            />
          )}
          {displayEntry.id === 'settings/extensions' && <AdSkipSubpage />}
          {displayEntry.id === 'intervention/wind-down' && <WindDownSubpage />}
          {displayEntry.id === 'trends/history' && <TrendsHistorySubpage />}
          {displayEntry.id === 'trends/calendar' && <TrendsCalendarSubpage />}
          {displayEntry.id === 'trends/usage' && <TrendsUsageSubpage />}
          {displayEntry.id === 'eyecare/schedule' && <EyeCareScheduleSubpage />}
          {displayEntry.id === 'eyecare/health' && <EyeCareHealthSubpage />}
        </Suspense>
      </PaneErrorBoundary>
    </div>
  );
};

/**
 * 延迟加载占位：外层已是不透明同主题色滑动页，前 220ms 保持纯净底色不闪灰框骨架；
 * 仅在极慢设备上超过 220ms 仍未加载完成时才轻柔呈现旋转指示器。
 */
const DelayedSubpageFallback: React.FC = () => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), 220);
    return () => window.clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div aria-hidden className="w-full h-full flex items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-slate-700 border-t-indigo-400 animate-spin" />
    </div>
  );
};
