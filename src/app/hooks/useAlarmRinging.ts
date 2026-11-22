import { useEffect, useRef } from 'react';
import { CustomAlarmSetting } from '../../shared/types/sleep';
import { updateProfile } from '../../shared/store/profileStore';
import { uiStore, useUIStore } from '../../shared/store/uiStore';
import { isNativePlatform } from '../../features/sleep/utils/nativeAlarmScheduler';
import { nativePlugin } from '../../shared/native/nativeBridge';
import { sleepAudio } from '../../features/intervention/utils/audioSynth';
import { tapTick } from '../../shared/utils/haptics';
import { useModalA11y } from '../../shared/utils/modalA11y';

/**
 * 全局闹钟响铃守护（10s 对表 + 原生 AlarmRingService 状态同步 + 焦点陷阱）。
 */
export function useAlarmRinging(alarms: CustomAlarmSetting[] | undefined) {
  const ringingAlarm = useUIStore((s) => s.ringingAlarm);
  const ringingBannerSetAtRef = useRef(0);
  const lastFiredKeyRef = useRef<string>('');
  const justStoppedRef = useRef(0);

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
          sleepAudio.stop();
          if (!isNativePlatform()) sleepAudio.playAlarm(alarm.tone);
          if (alarm.repeatDays.length === 0) {
            updateProfile((prev) => ({
              alarms: (prev.alarms || []).map((a) => (a.id === alarm.id ? { ...a, enabled: false } : a)),
            }));
          }
          if (!isNativePlatform()) {
            window.setTimeout(() => {
              sleepAudio.stop();
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
              if (!uiStore.getState().ringingAlarm) sleepAudio.stop();
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

  const handleStopRinging = () => {
    tapTick();
    justStoppedRef.current = Date.now();
    sleepAudio.stop();
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
