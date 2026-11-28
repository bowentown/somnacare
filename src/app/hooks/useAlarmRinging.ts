import { useEffect, useRef } from 'react';
import { CustomAlarmSetting } from '../../shared/types/sleep';
import { updateProfile } from '../../shared/store/profileStore';
import { uiStore, useUIStore } from '../../shared/store/uiStore';
import { isNativePlatform } from '../../features/sleep/utils/nativeAlarmScheduler';
import { nativePlugin } from '../../shared/native/nativeBridge';
import { tapTick } from '../../shared/utils/haptics';
import { useModalA11y } from '../../shared/utils/modalA11y';

/** 按需加载音频合成器，避免首包携带 730 行 Web Audio 合成逻辑。 */
const loadAudio = () => import('../../features/intervention/utils/audioSynth').then((m) => m.sleepAudio);

/**
 * 全局闹钟响铃守护（10s 对表 + 原生 AlarmRingService 状态同步 + 焦点陷阱）。
 */
export function useAlarmRinging(alarms: CustomAlarmSetting[] | undefined) {
  const ringingAlarm = useUIStore((s) => s.ringingAlarm);
  const ringingBannerSetAtRef = useRef(0);
  const lastFiredKeyRef = useRef<string>('');
  const justStoppedRef = useRef(0);
  const autoStopTimerRef = useRef<number | null>(null);

  useEffect(() => {
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

      if (isNativePlatform()) {
        void (async () => {
          try {
            const queryStartedAt = Date.now();
            const st = await nativePlugin('SleepCore')?.alarmRingStatus?.();
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
                        tone: 'gentle_chime',
                        vibrate: true,
                        smartWakeEnabled: false,
                        smartWakeWindowMinutes: 20,
                      },
                    },
              );
            } else {
              if (queryStartedAt < ringingBannerSetAtRef.current) return;
              uiStore.setState((cur) => (cur.ringingAlarm ? { ringingAlarm: null } : cur));
            }
          } catch {
            /* 状态查询失败不打扰 */
          }
        })();
      }
    };
    const interval = window.setInterval(checkAlarm, 10000);
    return () => window.clearInterval(interval);
  }, [alarms]);

  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current !== null) {
        window.clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
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

  const ringA11y = useModalA11y(!!ringingAlarm, handleStopRinging, '闹钟响铃');

  return { ringingAlarm, handleStopRinging, ringA11y };
}
