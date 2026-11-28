import React, { Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCircle2 } from 'lucide-react';
import { DEFAULT_EYE_CARE } from '../shared/types/sleep';
import { getCurrentTheme, useProfileStore } from '../shared/store/profileStore';
import {
  saveActiveSleepRecord,
  saveManualSleepRecord,
  undoDeleteSleepRecord,
  useSleepStore,
} from '../features/sleep/store/sleepStore';
import {
  closeActiveSleepModal,
  closeManualLogModal,
  openMoments,
  setActiveTab,
  showToast,
  uiStore,
  useUIStore,
} from '../shared/store/uiStore';
import { BedtimeReminder } from '../features/sleep/components/BedtimeReminder';
import { isNativePlatform } from '../features/sleep/utils/nativeAlarmScheduler';
import { eyeCareInAppStyles, isInEyeCareWindow } from '../features/eyecare/utils/eyeCare';
import { clearPendingArrival } from '../features/pet/services/travelService';
import { useAlarmRinging } from './hooks/useAlarmRinging';

// 首屏不可见的全屏弹层（实时监测含 730 行 audioSynth、手动补录、图鉴与明信片）全部懒加载
const ActiveSleepModal = lazy(() =>
  import('../features/sleep/components/ActiveSleepModal').then((m) => ({ default: m.ActiveSleepModal })),
);
const ManualLogModal = lazy(() =>
  import('../features/sleep/components/ManualLogModal').then((m) => ({ default: m.ManualLogModal })),
);
const TravelCodexModal = lazy(() =>
  import('../features/pet/travel/TravelCodexModal').then((m) => ({ default: m.TravelCodexModal })),
);
const TripArrivalModal = lazy(() =>
  import('../features/pet/travel/TripArrivalModal').then((m) => ({ default: m.TripArrivalModal })),
);

/**
 * 全局弹层与状态条集合：Web 护眼滤镜、Web 就寝提醒、闹钟响铃横幅、Toast / 撤销条、
 * 睡眠监测弹窗、手动补录弹窗、大肥鱼漫游图鉴与明信片送达弹窗。
 */
export const AppOverlays: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const currentTheme = getCurrentTheme(userProfile);

  const records = useSleepStore((s) => s.records);
  const undoDeleted = useSleepStore((s) => s.undoDeleted);

  const toastMessage = useUIStore((s) => s.toastMessage);
  const activeSleepOpen = useUIStore((s) => s.activeSleepOpen);
  const manualLogOpen = useUIStore((s) => s.manualLogOpen);
  const manualLogPrefill = useUIStore((s) => s.manualLogPrefill);
  const editTarget = useUIStore((s) => s.editTarget);
  const codexOpen = useUIStore((s) => s.codexOpen);
  const pendingPostcardId = useUIStore((s) => s.pendingPostcardId);
  const bedtimeReminder = useUIStore((s) => s.bedtimeReminder);

  const { ringingAlarm, handleStopRinging, handleSnoozeRinging, ringA11y } = useAlarmRinging(userProfile.alarms);
  const eyeCareCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;

  return (
    <>
      {/* Web 预览回退护眼层（APK 端走系统全局悬浮窗） */}
      {!isNativePlatform() &&
        (eyeCareCfg.enabled
          ? (() => {
              if (!isInEyeCareWindow(eyeCareCfg)) return null;
              const { warm, dim } = eyeCareInAppStyles(eyeCareCfg);
              return (
                <>
                  <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: warm, mixBlendMode: 'multiply' }} />
                  <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: dim }} />
                </>
              );
            })()
          : (
            <>
              {userProfile.warmthFilter && (
                <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: 'rgba(255,147,41,0.10)', mixBlendMode: 'multiply' }} />
              )}
              {userProfile.brightnessLevel < 100 && (
                <div
                  className="fixed inset-0 z-[70] pointer-events-none"
                  style={{ background: `rgba(0,0,0,${((100 - userProfile.brightnessLevel) / 100) * 0.55})` }}
                />
              )}
            </>
          ))}

      {/* Web 预览就寝到点提醒 */}
      {!isNativePlatform() && bedtimeReminder && (
        <BedtimeReminder
          theme={currentTheme}
          phase={bedtimeReminder}
          onGood={() => uiStore.setState({ bedtimeReminder: 'good' })}
          onIgnore={() => uiStore.setState({ bedtimeReminder: 'ignore' })}
          onDone={(finalPhase) => {
            if (finalPhase === 'good') {
              const now = Date.now();
              try {
                localStorage.setItem('somnacare_bedtime_start', String(now));
              } catch {
                /* ignore */
              }
              uiStore.setState({ sleepStartSignal: now });
              setActiveTab('today');
              showToast('晚安💤');
            }
            uiStore.setState({ bedtimeReminder: null });
          }}
        />
      )}

      {/* 全局闹钟响铃横幅 */}
      {ringingAlarm &&
        createPortal(
          <div
            ref={ringA11y.ref}
            {...ringA11y.dialogProps}
            className="fixed top-0 left-0 right-0 z-[300] p-4 bg-gradient-to-r from-amber-800 via-indigo-600 to-violet-600 text-white shadow-2xl space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                  <Bell className="w-6 h-6 animate-spin text-amber-200" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-amber-100">闹钟响铃中 · 晨安唤醒</div>
                  <h4 className="text-xl font-black truncate">
                    {ringingAlarm.time} {ringingAlarm.label}
                  </h4>
                </div>
              </div>
              <button
                type="button"
                onClick={handleStopRinging}
                className="px-4 py-2.5 bg-white text-slate-900 font-black text-sm rounded-xl shadow-lg active:scale-95 transition-all cursor-pointer shrink-0"
              >
                停止响铃
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSnoozeRinging(5)}
                className="flex-1 py-2 rounded-xl bg-black/30 border border-white/30 text-white font-bold text-xs active:scale-95 transition-all cursor-pointer"
              >
                再睡 5 分钟
              </button>
              <button
                type="button"
                onClick={() => handleSnoozeRinging(10)}
                className="flex-1 py-2 rounded-xl bg-black/30 border border-white/30 text-white font-bold text-xs active:scale-95 transition-all cursor-pointer"
              >
                再睡 10 分钟
              </button>
            </div>
          </div>,
          document.body,
        )}

      {/* 全局 Toast 与 5 秒删除撤销条 */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed ${undoDeleted ? 'bottom-36' : 'bottom-24'} left-0 right-0 mx-auto w-fit max-w-[calc(100vw-2rem)] z-[350] px-5 py-3 rounded-2xl ${currentTheme.accentBg.split(' ')[0]} ${currentTheme.accentFg} text-xs font-black shadow-2xl flex items-center gap-2.5 animate-fadeIn border border-white/10`}
        >
          <CheckCircle2 className="w-5 h-5 shrink-0 opacity-90" />
          <span>{toastMessage}</span>
        </div>
      )}
      {undoDeleted && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-24 left-0 right-0 mx-auto w-fit z-[340] px-4 py-2.5 rounded-2xl bg-slate-900 border border-slate-700 text-xs text-slate-200 shadow-2xl flex items-center gap-3 animate-fadeIn"
        >
          <span>已删除 {undoDeleted.date} 的记录</span>
          <button
            type="button"
            onClick={undoDeleteSleepRecord}
            className={`px-2 py-1 rounded-lg font-black ${currentTheme.accentText} cursor-pointer active:scale-95 transition-transform`}
          >
            撤销
          </button>
        </div>
      )}

      {/* 核心弹窗：实时睡眠监测 / 手动补录 / 漫游图鉴 / 明信片送达 */}
      {activeSleepOpen && (
        <Suspense fallback={null}>
          <ActiveSleepModal
            isOpen={activeSleepOpen}
            onClose={closeActiveSleepModal}
            onFinishSleep={saveActiveSleepRecord}
            theme={currentTheme}
            targetDurationHours={userProfile.targetDurationHours}
            records={records}
            chronotype={userProfile.chronotype ?? 'night'}
          />
        </Suspense>
      )}
      {manualLogOpen && (
        <Suspense fallback={null}>
          <ManualLogModal
            isOpen={manualLogOpen}
            onClose={closeManualLogModal}
            editing={editTarget ?? undefined}
            onSaveRecord={saveManualSleepRecord}
            theme={currentTheme}
            targetDurationHours={userProfile.targetDurationHours}
            records={records}
            initialDate={manualLogPrefill?.date}
            initialBedtime={manualLogPrefill?.bedtime}
            initialWakeTime={manualLogPrefill?.wakeTime}
            chronotype={userProfile.chronotype ?? 'night'}
          />
        </Suspense>
      )}
      {codexOpen &&
        createPortal(
          <Suspense fallback={null}>
            <TravelCodexModal onClose={() => uiStore.setState({ codexOpen: false })} />
          </Suspense>,
          document.body,
        )}
      {pendingPostcardId && (
        <Suspense fallback={null}>
          <TripArrivalModal
            postcardId={pendingPostcardId}
            onClose={() => {
              clearPendingArrival();
              uiStore.setState({ pendingPostcardId: null });
            }}
            onOpenMoments={() => {
              uiStore.setState({ pendingPostcardId: null });
              openMoments();
            }}
          />
        </Suspense>
      )}
    </>
  );
};
