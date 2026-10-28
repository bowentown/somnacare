/**
 * App 壳层的原生 / 生命周期副作用（第 99 轮从 App.tsx 拆出）。
 *
 * 这些 effect 彼此独立、只依赖传入的参数与稳定 setter——原来平铺在
 * App.tsx 里 300 行，App 壳因此膨胀到 1400+ 行。抽到这里后 App.tsx 只保留
 * 状态编排与渲染。行为逐字迁移，依赖数组与原来完全一致。
 *
 * 相关护栏：verify-night-rescue（nightRescueSet）、verify-audit-hardening
 * （就寝提醒 fired 键）——它们读的是本文件。
 */
import { useEffect, useRef } from 'react';
import { UserProfile, CustomAlarmSetting } from '../types/sleep';
import { BedtimeReminderPhase } from '../components/BedtimeReminder';
import { NavTab } from '../components/BottomNavBar';
import { isNativePlatform, syncAlarmsToNative } from '../utils/nativeAlarmScheduler';
import { nativePlugin } from '../utils/nativeBridge';
import { subscribeAppResume, notifyAppResume } from '../utils/appResume';
import { consumePendingTab } from '../utils/petOverlay';
import { queryScreenOnEvents } from '../utils/usageSignal';
import { forceRefreshUsage } from '../utils/usageStore';
import { closeTopModalIfAny } from '../utils/modalA11y';

/**
 * APK 启动时无条件同步一次闹钟到原生 AlarmManager（重启/重装后打开即恢复调度）。
 * 依赖数组刻意为空：只在挂载时跑一次，读的是当时的 userProfile。
 */
export function useStartupAlarmSync(
  userProfile: UserProfile,
  setUserProfile: (updater: (prev: UserProfile) => UserProfile) => void,
): void {
  useEffect(() => {
    if (!isNativePlatform()) return;
    void (async () => {
      // "仅一次"闹钟的时刻已过且原生表里已无此条 → 已响过、被原生剔除，
      // 这里在档案中停用；否则本次 enabled 全量同步会把它送回原生，
      // 被按"今天已过则明天"续排——一次性闹钟变相成为永久每日闹钟
      let nativeIds: Set<string> | null = null;
      try {
        const tbl = await nativePlugin('GemmaLLM')?.alarmRingTable?.();
        nativeIds = new Set<string>((JSON.parse(tbl?.json || '[]') as Array<{ id?: string }>).map((x) => x.id || ''));
      } catch { /* 读不到原生表时不动档案，只做常规同步 */ }
      let alarms = userProfile.alarms || [];
      if (nativeIds) {
        const now = new Date();
        let changed = false;
        alarms = alarms.map((a) => {
          if (!a.enabled || a.repeatDays.length !== 0 || nativeIds!.has(a.id)) return a;
          const [h, m] = a.time.split(':').map(Number);
          const t = new Date();
          t.setHours(h, m, 0, 0);
          if (t.getTime() <= now.getTime()) {
            changed = true;
            return { ...a, enabled: false };
          }
          return a;
        });
        if (changed) setUserProfile((prev) => ({ ...prev, alarms }));
      }
      syncAlarmsToNative(alarms);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * 时区跳变后重同步闹钟（第 81 轮审计 P2）：原生铃闹由 BootReceiver 的
 * TIMEZONE_CHANGED 自动重排，但 Capacitor 一次性通知锚定绝对时刻——
 * 跨时区后仍指旧本地时刻。回前台检测到时区偏移变化就全量重排一次。
 */
export function useTimezoneAlarmResync(alarms: CustomAlarmSetting[] | undefined): void {
  useEffect(() => {
    if (!isNativePlatform()) return;
    let lastOffset = new Date().getTimezoneOffset();
    const unsubscribe = subscribeAppResume(() => {
      const offset = new Date().getTimezoneOffset();
      if (offset === lastOffset) return;
      lastOffset = offset;
      syncAlarmsToNative(alarms || []);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarms]);
}

/** 鲸鱼娘速览卡点行后拉起 App：读取并清除原生写入的目标分区。 */
export function usePetTabLaunch(tabOrder: readonly string[], setActiveTab: (tab: NavTab) => void): void {
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    const apply = () => {
      void consumePendingTab().then((tab) => {
        if (cancelled || !tab) return;
        if (tabOrder.includes(tab)) setActiveTab(tab as NavTab);
      });
    };
    apply();
    // 从后台被桌宠拉起时 App 不重新挂载，靠 visibilitychange 补一次
    const onVisible = () => {
      if (document.visibilityState === 'visible') apply();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Android 返回键治理（第 52 轮）：有弹窗时先关弹窗（与 Escape 同通路），
 * 无弹窗才退出。@capacitor/app 的 backButton 一旦监听即接管返回键，
 * 不调 exitApp 就不会退出——默认行为必须显式补上。
 */
export function useAndroidBackButton(): void {
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    let handle: { remove: () => void } | null = null;
    // 动态 import（第 52 轮）：@capacitor/app 顶层 import 会让 @capacitor/core
    // 的 web 运行时在页面加载时改写 window.Capacitor（isNativePlatform →
    // false）——e2e mock 与 web 预览全被打回"网页预览环境"。只在真机守卫内
    // 异步加载，web 端永不触碰。
    void (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        const h = await CapApp.addListener('backButton', () => {
          if (closeTopModalIfAny()) return;
          void CapApp.exitApp();
        });
        if (cancelled) { try { h.remove(); } catch { /* ignore */ } return; }
        handle = h;
      } catch { /* 非 native / 桥异常静默 */ }
    })();
    return () => {
      cancelled = true;
      try { handle?.remove(); } catch { /* ignore */ }
    };
  }, []);
}

/**
 * 后台恢复即刷新使用信号（真机 10-14 实测的"每天早上必须去偏好页点自检
 * 才出卡"的根因）：隔夜驻留后台后恢复前台，提议引擎的 effect 依赖
 * （usageDays/records/handledDate…）一个都不会变——引擎跑在昨晚的旧
 * 观测上（observedUntil 停在放下手机那一刻），起床信号永远进不来。
 * 自检链路之所以"有效"，正是它 force 绕过了 30min 缓存并 kick 了引擎。
 * 这里把同一步自动化：恢复可见即强制刷新（先事件后聚合——聚合 emit
 * 驱动睡眠页引擎 effect 重跑，重跑时读到的是刚刷新的事件缓存）。
 */
export function useResumeUsageRefresh(chronotype: 'night' | 'day' | 'irregular'): void {
  useEffect(() => {
    if (!isNativePlatform()) return;
    let lastRun = 0;
    let inFlight = false;
    const refresh = (source: 'visibility' | 'appstate') => {
      if (chronotype === 'irregular') return;   // 不规律作息：自动提议整体关闭，无需刷新
      // 双通道去抖：appStateChange 与 visibilitychange 常在恢复时先后各发一次。
      // inFlight 是同步守卫（首个查询返回前第二通道不会双触发）；失败时
      // inFlight 立即释放且不写 lastRun，允许另一通道补位（第 54 轮修正）
      const now = Date.now();
      if (inFlight || now - lastRun < 1500) return;
      inFlight = true;
      // 广播给睡眠页引擎：即使下面的聚合查询失败/返回空，引擎也会被强制
      // 重跑一次（不依赖 usageStore emit 的间接链路）
      notifyAppResume(source);
      void (async () => {
        const ok = !!(await queryScreenOnEvents(14, true));
        if (ok) lastRun = Date.now();
        inFlight = false;
        await forceRefreshUsage(2, chronotype);
      })();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh('visibility');
    };
    // 双通道（第 53 轮）：部分 ROM/WebView 息屏恢复不派发 visibilitychange，
    // Capacitor 的 appStateChange 是原生 Activity 生命周期的权威信号
    let appStateHandle: { remove: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        const h = await CapApp.addListener('appStateChange', ({ isActive }) => {
          if (isActive) refresh('appstate');
        });
        if (cancelled) { try { h.remove(); } catch { /* ignore */ } return; }
        appStateHandle = h;
      } catch { /* 桥异常时仅保留 visibility 通道 */ }
    })();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { appStateHandle?.remove(); } catch { /* ignore */ }
    };
  }, [chronotype]);
}

/**
 * 作息目标到点提醒：目标就寝时刻起 15 分钟内、当日未提醒、且未在监测中 → 全屏提醒。
 */
export function useBedtimeReminderWatch(
  targetBedtime: string,
  enabled: boolean | undefined,
  active: BedtimeReminderPhase | null,
  set: (phase: BedtimeReminderPhase) => void,
): void {
  useEffect(() => {
    const check = () => {
      if (active || isNativePlatform()) return; // 原生端由悬浮窗提醒（跨应用）
      if (!enabled) return;
      try {
        if (localStorage.getItem('somnacare_bedtime_start')) return;
        const [th, tm] = (targetBedtime || '23:30').split(':').map(Number);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const targetMin = th * 60 + tm;
        // 15 分钟窗口跨午夜：目标 23:50 时，00:05 打开（nowMin=5）也应命中——
        // 否则就寝时间在最后十几分钟的用户整晚都收不到提醒（第 73 轮审计）
        const lateEvening = nowMin >= targetMin && nowMin <= targetMin + 15;
        const pastMidnight = nowMin + 1440 >= targetMin && nowMin + 1440 <= targetMin + 15;
        if (lateEvening || pastMidnight) {
          // 去重键=本夜的夜归属日（凌晨窗口归前一晚）。此前用自然日：
          // 00:05 补提醒存下"新的一天"，当晚 23:50 的提醒被误判已发，
          // 且 23:52→00:04 同一夜会触发两次（第 81 轮审计）
          const nightDate = pastMidnight
            ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
            : now;
          const nightKey = `${nightDate.getFullYear()}-${String(nightDate.getMonth() + 1).padStart(2, '0')}-${String(nightDate.getDate()).padStart(2, '0')}`;
          if (localStorage.getItem('somnacare_reminder_fired') === nightKey) return;
          localStorage.setItem('somnacare_reminder_fired', nightKey);
          set('ask');
        }
      } catch {
        // ignore
      }
    };
    check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, [targetBedtime, enabled, active, set]);
}

/**
 * 原生：开启提醒时按目标重排精确闹钟；关闭即取消。悬浮"好的"经冷启动标记或事件接续。
 * onGoodPath 经 ref 透传（它每次渲染重建，但只调用稳定 setter——与原先
 * effect 捕获当时闭包的行为等价）。
 */
export function useBedtimeNativeSync(
  targetBedtime: string,
  targetWakeTime: string,
  reminderEnabled: boolean | undefined,
  nightRescueEnabled: boolean | undefined,
  onGoodPath: () => void,
): void {
  const goodPathRef = useRef(onGoodPath);
  goodPathRef.current = onGoodPath;
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isNativePlatform()) return;
    let listenerHandle: any = null;
    try {
      if (reminderEnabled) {
        nativePlugin('GemmaLLM')?.bedtimeReminderSchedule?.({ time: targetBedtime });
      } else {
        nativePlugin('GemmaLLM')?.bedtimeReminderCancel?.();
      }
      // 深夜救援开关 + 醒来目标（夜间窗口用；默认开启，!== false 语义）
      nativePlugin('GemmaLLM')?.nightRescueSet?.({
        enabled: nightRescueEnabled !== false,
        wake: targetWakeTime,
      });
      nativePlugin('GemmaLLM')?.bedtimeAutoStartConsume?.().then((res: any) => {
        if (res?.consume) goodPathRef.current();
      });
      // addListener 返回句柄，卸载/依赖变化时必须移除（否则每次改目标都叠加
      // 一个监听器）。句柄经 Promise 异步到达：cleanup 先到时置 cancelled，
      // resolve 回调里补移除——否则旧监听器永久泄漏，一次"好的"触发多次
      let cancelled = false;
      Promise.resolve(nativePlugin('GemmaLLM')?.addListener?.('bedtimeGood', () => goodPathRef.current()))
        .then((h: any) => {
          if (cancelled) { try { h?.remove?.(); } catch { /* ignore */ } return; }
          listenerHandle = h;
        })
        .catch(() => {});
      listenerCleanupRef.current = () => { cancelled = true; try { listenerHandle?.remove?.(); } catch { /* ignore */ } };
    } catch {
      // ignore
    }
    return () => { listenerCleanupRef.current?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBedtime, targetWakeTime, reminderEnabled, nightRescueEnabled]);
}
