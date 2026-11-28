import { useEffect, useRef } from 'react';
import { CustomAlarmSetting } from '../../shared/types/sleep';
import { updateProfile } from '../../shared/store/profileStore';
import { showToast, uiStore, useUIStore } from '../../shared/store/uiStore';
import { isNativePlatform } from '../../features/sleep/utils/nativeAlarmScheduler';
import { nativePlugin } from '../../shared/native/nativeBridge';
import { subscribeAppResume } from '../../shared/utils/appResume';
import { tapTick } from '../../shared/utils/haptics';
import { useModalA11y } from '../../shared/utils/modalA11y';

/** 按需加载音频合成器，避免首包携带 730 行 Web Audio 合成逻辑。 */
const loadAudio = () => import('../../features/intervention/utils/audioSynth').then((m) => m.sleepAudio);

/**
 * 全局闹钟响铃守护（10s 对表 + 原生 AlarmRingService 状态同步 + 贪睡 + 焦点陷阱）。
 */
export function useAlarmRinging(alarms: CustomAlarmSetting[] | undefined) {
  const ringingAlarm = useUIStore((s) => s.ringingAlarm);
  const ringingBannerSetAtRef = useRef(0);
  const lastFiredKeyRef = useRef<string>('');
  const justStoppedRef = useRef(0);
  const autoStopTimerRef = useRef<number | null>(null);
  const webSnoozeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ringListenerHandle: { remove?: () => void } | null = null;

    const applyNativeState = (st: any, queryStartedAt: number) => {
      if (!st) return;
      if (st.ringing) {
        if (Date.now() - justStoppedRef.current < 3000) return;
        if (!uiStore.getState().ringingAlarm) {
          void loadAudio().then((audio) => audio.stop());
        }
        ringingBannerSetAtRef.current = Date.now();
        uiStore.setState((cur) =>
          cur.ringingAlarm
            ? cur
            : {
                ringingAlarm: {
                  id: 'native-ring',
                  time: st.time || '',
                  label: st.label || '',
                  enabled: true,
                  repeatDays: [],
                  tone: st.tone === 'aurora_melody' || st.tone === 'radar_beep' ? st.tone : 'gentle_chime',
                  vibrate: st.vibrate !== false,
                  smartWakeEnabled: false,
                  smartWakeWindowMinutes: 20,
                },
              },
        );
      } else {
        if (queryStartedAt < ringingBannerSetAtRef.current) return;
        // JS 刚命中的本地同分钟横幅给原生服务留出 3s 启动宽限期，防瞬态 st.ringing=false 误清横幅
        const cur = uiStore.getState().ringingAlarm;
        if (cur && cur.id !== 'native-ring' && Date.now() - ringingBannerSetAtRef.current < 3000) {
          return;
        }
        uiStore.setState((c) => (c.ringingAlarm ? { ringingAlarm: null } : c));
      }
    };

    const syncNativeStatus = () => {
      if (!isNativePlatform()) return;
      void (async () => {
        try {
          const queryStartedAt = Date.now();
          const st = await nativePlugin('SleepCore')?.alarmRingStatus?.();
          if (!cancelled) applyNativeState(st, queryStartedAt);
        } catch {
          /* 状态查询失败不打扰 */
        }
      })();
    };

    // 原生服务启停/锁屏全屏拉起时实时推送 alarmRingState，零延迟显示/收起横幅
    if (isNativePlatform()) {
      void Promise.resolve(
        nativePlugin('SleepCore')?.addListener?.('alarmRingState', (st: any) => {
          if (!cancelled) applyNativeState(st, Date.now());
        }),
      )
        .then((h: any) => {
          if (cancelled) {
            try { h?.remove?.(); } catch { /* ignore */ }
            return;
          }
          ringListenerHandle = h;
        })
        .catch(() => {});
    }

    const checkAlarm = () => {
      const now = new Date();
      const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const currentDay = now.getDay() === 0 ? 7 : now.getDay();
      const list = alarms || [];
      for (const alarm of list) {
        const fireKey = `${alarm.id}|${alarm.time}|${currentDay}`;
        if (
          alarm.enabled &&
          alarm.time === currentTimeStr &&
          (alarm.repeatDays.length === 0 || alarm.repeatDays.includes(currentDay)) &&
          lastFiredKeyRef.current !== fireKey &&
          !uiStore.getState().ringingAlarm
        ) {
          lastFiredKeyRef.current = fireKey;
          ringingBannerSetAtRef.current = Date.now();
          uiStore.setState({ ringingAlarm: alarm });
          const native = isNativePlatform();
          void loadAudio().then((audio) => {
            // 懒加载 chunk 尚未就绪期间若用户已点停或横幅已关闭，不再起播滞后铃声
            if (uiStore.getState().ringingAlarm?.id !== alarm.id) return;
            audio.stop();
            if (!native) audio.playAlarm(alarm.tone);
          });
          if (alarm.repeatDays.length === 0) {
            updateProfile((prev) => ({
              alarms: (prev.alarms || []).map((a) => (a.id === alarm.id ? { ...a, enabled: false } : a)),
            }));
          }
          if (!native) {
            if (autoStopTimerRef.current !== null) {
              window.clearTimeout(autoStopTimerRef.current);
            }
            autoStopTimerRef.current = window.setTimeout(() => {
              autoStopTimerRef.current = null;
              if (uiStore.getState().ringingAlarm?.id !== alarm.id) return;
              void loadAudio().then((audio) => audio.stopAlarm());
              uiStore.setState((cur) => (cur.ringingAlarm?.id === alarm.id ? { ringingAlarm: null } : cur));
            }, 5 * 60 * 1000);
          }
          break;
        }
      }

      syncNativeStatus();
    };

    // 锁屏 setFullScreenIntent 拉起 App 时立即查询原生响铃状态，无需等待 10s 轮询
    syncNativeStatus();
    const unsubResume = subscribeAppResume(syncNativeStatus);
    const interval = window.setInterval(checkAlarm, 10000);
    return () => {
      cancelled = true;
      unsubResume();
      window.clearInterval(interval);
      try { ringListenerHandle?.remove?.(); } catch { /* ignore */ }
    };
  }, [alarms]);

  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current !== null) {
        window.clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      if (webSnoozeTimerRef.current !== null) {
        window.clearTimeout(webSnoozeTimerRef.current);
        webSnoozeTimerRef.current = null;
      }
    };
  }, []);

  const handleStopRinging = () => {
    tapTick();
    justStoppedRef.current = Date.now();
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    void loadAudio().then((audio) => audio.stopAlarm());
    try {
      void nativePlugin('SleepCore')?.alarmRingStop?.();
    } catch {
      /* ignore */
    }
    uiStore.setState({ ringingAlarm: null });
  };

  const handleSnoozeRinging = (minutes: 5 | 10) => {
    tapTick();
    const current = uiStore.getState().ringingAlarm;
    justStoppedRef.current = Date.now();
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    void loadAudio().then((audio) => audio.stopAlarm());
    if (isNativePlatform()) {
      try {
        void nativePlugin('SleepCore')?.alarmRingSnooze?.({
          minutes,
          label: current?.label || '',
          tone: current?.tone || 'gentle_chime',
          vibrate: current?.vibrate !== false,
        });
      } catch {
        /* ignore */
      }
    } else if (current) {
      if (webSnoozeTimerRef.current !== null) {
        window.clearTimeout(webSnoozeTimerRef.current);
      }
      const target = new Date(Date.now() + minutes * 60 * 1000);
      const snoozeTime = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
      const snoozed: CustomAlarmSetting = {
        ...current,
        id: `snooze-${Date.now()}`,
        time: snoozeTime,
        label: current.label.includes('贪睡') ? current.label : `${current.label || '起床闹钟'}（贪睡）`,
      };
      webSnoozeTimerRef.current = window.setTimeout(() => {
        webSnoozeTimerRef.current = null;
        ringingBannerSetAtRef.current = Date.now();
        uiStore.setState({ ringingAlarm: snoozed });
        void loadAudio().then((audio) => {
          if (uiStore.getState().ringingAlarm?.id !== snoozed.id) return;
          audio.stop();
          audio.playAlarm(snoozed.tone);
        });
        if (autoStopTimerRef.current !== null) {
          window.clearTimeout(autoStopTimerRef.current);
        }
        autoStopTimerRef.current = window.setTimeout(() => {
          autoStopTimerRef.current = null;
          if (uiStore.getState().ringingAlarm?.id !== snoozed.id) return;
          void loadAudio().then((audio) => audio.stopAlarm());
          uiStore.setState((cur) => (cur.ringingAlarm?.id === snoozed.id ? { ringingAlarm: null } : cur));
        }, 5 * 60 * 1000);
      }, minutes * 60 * 1000);
    }
    uiStore.setState({ ringingAlarm: null });
    showToast(`已设贪睡，${minutes} 分钟后再次响铃`, 3500);
  };

  const ringA11y = useModalA11y(!!ringingAlarm, handleStopRinging, '闹钟响铃');

  return { ringingAlarm, handleStopRinging, handleSnoozeRinging, ringA11y };
}
