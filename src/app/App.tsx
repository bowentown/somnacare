import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { DEFAULT_EYE_CARE } from '../shared/types/sleep';
import { getCurrentTheme, updateProfile, useProfileStore } from '../shared/store/profileStore';
import { hydrateSleepStore, useSleepStore } from '../features/sleep/store/sleepStore';
import {
  openActiveSleepModal,
  setActiveTab,
  showToast,
  uiStore,
  useUIStore,
} from '../shared/store/uiStore';
import { TodayTab } from '../features/sleep/components/TodayTab';
import { CoachTab } from '../features/coach/CoachTab';
import { EyeCareTab } from '../features/eyecare/EyeCareTab';
import { SettingsTab } from '../settings/SettingsTab';
import { OnboardingCard } from '../features/sleep/components/OnboardingCard';
import { BottomNavBar } from '../shared/ui/BottomNavBar';
import { LaunchSplash } from '../shared/ui/LaunchSplash';
import { PaneErrorBoundary } from '../shared/ui/PaneErrorBoundary';
import { hasRecoverableActiveSleepSession } from '../features/sleep/components/ActiveSleepModal';
import { SubpageHost } from './SubpageHost';
import { AppOverlays } from './AppOverlays';
import { TAB_ORDER, useTabSwipe } from './hooks/useTabSwipe';
import {
  useAdSkipSystemGuardToast,
  useAndroidBackButton,
  useBedtimeNativeSync,
  useBedtimeReminderWatch,
  usePetTabLaunch,
  useResumeUsageRefresh,
  useStartupAlarmSync,
  useTimezoneAlarmResync,
} from './hooks/useAppWatchers';
import { isNativePlatform } from '../features/sleep/utils/nativeAlarmScheduler';
import { syncRecallNotify } from '../features/sleep/utils/careNotifications';
import { initProposalNotify } from '../features/sleep/utils/proposalNotify';
import { applyEyeCare } from '../features/eyecare/utils/eyeCare';
import { syncPet } from '../features/pet/utils/petOverlay';

// 趋势页含 Recharts+D3，独立按需分包以保持首包轻快
const TrendsTab = lazy(() => import('../features/trends/TrendsTab').then((m) => ({ default: m.TrendsTab })));

const PANE_LABELS: Record<string, string> = {
  today: '睡眠',
  trends: '趋势',
  coach: 'AI 顾问',
  eyecare: '护眼',
  settings: '偏好',
};

export const App: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const currentTheme = getCurrentTheme(userProfile);

  const records = useSleepStore((s) => s.records);
  const hydrated = useSleepStore((s) => s.hydrated);

  const activeTab = useUIStore((s) => s.activeTab);
  const chatTyping = useUIStore((s) => s.chatTyping);
  const bedtimeReminder = useUIStore((s) => s.bedtimeReminder);
  const hasSubpage = useUIStore((s) => s.subpageStack.length > 0);

  const [firstFrameReady, setFirstFrameReady] = useState(false);
  const [ambientHour, setAmbientHour] = useState(() => new Date().getHours());
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try {
      if (localStorage.getItem('somnacare_onboarded_v1') === '1') return false;
      if (sessionStorage.getItem('somnacare_onboarded_v1') === '1') return false;
      return true;
    } catch {
      return false;
    }
  });

  // 首帧就绪（双 rAF）+ 恢复未结束监测 + 二段式数据补水
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFirstFrameReady(true));
    });
    if (hasRecoverableActiveSleepSession()) openActiveSleepModal();
    void hydrateSleepStore();
    initProposalNotify();
    const hourTimer = window.setInterval(() => setAmbientHour(new Date().getHours()), 60_000);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearInterval(hourTimer);
    };
  }, []);

  // 一次性旧版午睡覆盖存量体检提示
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (localStorage.getItem('somnacare_nap_overwrite_notice_shown')) return;
      const suspect = records.filter(
        (r) =>
          r.durationMinutes < 180 &&
          (() => {
            const h = parseInt(r.bedtime.split(':')[0], 10);
            return h >= 10 && h < 20;
          })(),
      );
      localStorage.setItem('somnacare_nap_overwrite_notice_shown', '1');
      if (suspect.length > 0) {
        showToast(`发现 ${suspect.length} 条记录像白天小睡。若你的夜间记录曾消失过，可能是被它覆盖了——新版本已修复，可手动补回`);
      }
    } catch {
      /* ignore */
    }
  }, [hydrated, records]);

  // 主题类名挂到 <html> 以便 portal 弹窗共享主题规则
  useEffect(() => {
    const root = document.documentElement;
    const cls = `theme-${userProfile.themeColor || 'midnight'}`;
    root.classList.remove('theme-midnight', 'theme-pure_dark', 'theme-warm_amber', 'theme-serene_blue');
    root.classList.add(cls);
    return () => root.classList.remove(cls);
  }, [userProfile.themeColor]);

  // 原生服务与系统守护副作用
  useStartupAlarmSync(userProfile, updateProfile);
  useTimezoneAlarmResync(userProfile.alarms);
  usePetTabLaunch(TAB_ORDER, setActiveTab);
  useAndroidBackButton();
  useAdSkipSystemGuardToast();
  useResumeUsageRefresh(userProfile?.chronotype ?? 'night');
  useBedtimeReminderWatch(
    userProfile.targetBedtime,
    userProfile.bedtimeReminderEnabled,
    bedtimeReminder,
    (phase) => uiStore.setState({ bedtimeReminder: phase }),
  );
  useBedtimeNativeSync(
    userProfile.targetBedtime,
    userProfile.targetWakeTime,
    userProfile.bedtimeReminderEnabled,
    userProfile.nightRescueEnabled,
    () => {
      try {
        if (localStorage.getItem('somnacare_bedtime_start')) return;
        const now = Date.now();
        localStorage.setItem('somnacare_bedtime_start', String(now));
        uiStore.setState({ sleepStartSignal: now });
        setActiveTab('today');
        showToast('晚安💤');
      } catch {
        /* ignore */
      }
    },
  );

  useEffect(() => { void syncPet(records, userProfile); }, [records, userProfile]);
  useEffect(() => { void syncRecallNotify(records); }, [records]);

  const eyeCareCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
  useEffect(() => {
    void applyEyeCare(eyeCareCfg);
    const t = setInterval(() => void applyEyeCare(eyeCareCfg), 30_000);
    return () => clearInterval(t);
  }, [eyeCareCfg]);

  const { trackRef, mountedPanes } = useTabSwipe(activeTab, hydrated);

  const finishOnboarding = () => {
    try { localStorage.setItem('somnacare_onboarded_v1', '1'); } catch {
      try { sessionStorage.setItem('somnacare_onboarded_v1', '1'); } catch { /* ignore */ }
    }
    setOnboardingOpen(false);
  };

  const ambientOn = userProfile.ambientLightEnabled !== false;
  const ambientTint = !ambientOn
    ? null
    : ambientHour >= 5 && ambientHour < 9
      ? 'rgba(255,138,76,0.055)'
      : ambientHour >= 9 && ambientHour < 17
        ? 'rgba(80,170,255,0.035)'
        : ambientHour >= 17 && ambientHour < 20
          ? 'rgba(255,110,70,0.05)'
          : 'rgba(40,80,200,0.06)';

  return (
    <div
      className={`app-shell w-full theme-${currentTheme.id} ${currentTheme.pageBg} ${currentTheme.textPrimary} ${currentTheme.selectionBg} relative flex flex-col overflow-hidden transition-colors duration-300`}
    >
      {/* 品牌氛围极光带与环境光层 */}
      <div aria-hidden className="pointer-events-none absolute top-0 left-0 right-0 h-44 overflow-hidden">
        <div
          className={`absolute -top-28 left-[-15%] w-[130%] h-56 blur-3xl opacity-[0.2] ${ambientOn ? 'animate-aurora-drift will-change-transform' : ''}`}
          style={{ background: `linear-gradient(100deg, transparent 12%, ${currentTheme.accentHex} 38%, transparent 52%, #8b5cf6 66%, transparent 84%)` }}
        />
      </div>
      {ambientTint && (
        <div
          aria-hidden="true"
          className="ambient-tint pointer-events-none fixed inset-0 z-[1]"
          style={{ background: ambientTint, mixBlendMode: 'soft-light' }}
        />
      )}

      <LaunchSplash theme={currentTheme} ready={firstFrameReady} />
      {onboardingOpen && (
        <OnboardingCard theme={currentTheme} allowAutoRecordStep={isNativePlatform()} onFinish={finishOnboarding} />
      )}

      {/* 主内容区：顶栏 + 五分区跟手滑动轨道（子页展开时对无障碍树隐藏避免底层按钮被读屏/聚焦） */}
      <div
        aria-hidden={hasSubpage || undefined}
        className="relative z-[2] w-full flex-1 max-w-lg mx-auto flex flex-col min-h-0"
      >
        <header className={`px-5 pt-5 pb-3.5 flex items-center justify-between border-b ${currentTheme.cardBorder} shrink-0`}>
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-2xl ${currentTheme.accentFg} flex items-center justify-center shadow-md`} style={{ background: `linear-gradient(135deg, ${currentTheme.accentHex}, ${currentTheme.accentHex}55)` }}>
              <Moon className="w-5 h-5 fill-current opacity-90" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-white">极光睡眠</h1>
          </div>
          <span className={`text-xs ${currentTheme.textPrimary} font-bold ${currentTheme.cardBg} px-3.5 py-1.5 rounded-full border ${currentTheme.cardBorder} shadow-md`}>
            {new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })}
          </span>
        </header>

        {hydrated && (
          <main className="flex-1 min-h-0 overflow-hidden">
            <div ref={trackRef} className="flex h-full swipe-track" style={{ width: `${TAB_ORDER.length * 100}%` }}>
              {TAB_ORDER.map((id) => (
                <div key={id} className="h-full overflow-y-auto no-scrollbar swipe-pane" style={{ width: `${100 / TAB_ORDER.length}%` }}>
                  <div className="p-4 space-y-4">
                    {mountedPanes.has(id) && (
                      <PaneErrorBoundary label={PANE_LABELS[id] ?? id}>
                        <Suspense fallback={<PaneSkeleton />}>
                          {id === 'today' && <TodayTab />}
                          {id === 'trends' && <TrendsTab />}
                          {id === 'coach' && <CoachTab />}
                          {id === 'eyecare' && <EyeCareTab />}
                          {id === 'settings' && <SettingsTab />}
                        </Suspense>
                      </PaneErrorBoundary>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </main>
        )}
      </div>

      {/* 二级子页栈 + 底栏 + 全局弹窗与状态条 */}
      <SubpageHost />
      {!chatTyping && !hasSubpage && (
        <BottomNavBar activeTab={activeTab} onChangeTab={setActiveTab} theme={currentTheme} />
      )}
      <AppOverlays />
    </div>
  );
};

const PaneSkeleton: React.FC = () => (
  <div className="space-y-3" aria-hidden>
    {[0, 1, 2].map((i) => (
      <div key={i} className="rounded-3xl border border-slate-700/60 bg-slate-900/40 p-5">
        <div className="h-3 w-24 rounded-full bg-slate-700/60" />
        <div className="mt-3 h-24 rounded-2xl bg-slate-800/50" />
      </div>
    ))}
  </div>
);

export default App;
