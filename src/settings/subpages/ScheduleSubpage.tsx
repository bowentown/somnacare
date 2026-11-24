import React, { useState } from 'react';
import { BellRing, Clock, Moon } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { Switch } from '../../shared/ui';
import type { CustomAlarmSetting } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { replaceSleepRecords, useSleepStore } from '../../features/sleep/store/sleepStore';
import { reclassifyForChronotype } from '../../features/sleep/utils/recordFilter';
import { relinkLedgerAfterReclassify } from '../../features/pet/services/travelService';
import { AlarmManager } from '../../features/sleep/components/AlarmManager';
import { computeMSFsc, computeSleepNeed } from '../../features/sleep/utils/sleepScore';
import { computeSuggestedSchedule } from '../../features/sleep/utils/scheduleSuggestion';
import { requestAlarmPermissions } from '../../features/sleep/utils/nativeAlarmScheduler';
import { nativePlugin } from '../../shared/native/nativeBridge';

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const toClock = (min: number): string => {
  const norm = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
};

/** 关怀提醒开关：localStorage 直读直写（'0'=关，缺省=开），读侧在 careNotifications 中对齐 */
function NotifyToggle({
  storageKey,
  label,
  desc,
  theme,
}: {
  storageKey: string;
  label: string;
  desc: string;
  theme: ThemeConfig;
}) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '0';
    } catch {
      return true;
    }
  });
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-bold text-white">{label}</p>
        <p className="text-[10px] text-slate-400 leading-relaxed">{desc}</p>
      </div>
      <Switch
        checked={on}
        onChange={(next) => {
          setOn(next);
          try {
            localStorage.setItem(storageKey, next ? '1' : '0');
          } catch {
            /* ignore */
          }
        }}
        ariaLabel={`${label}开关`}
        onClass={theme.accentBg}
      />
    </div>
  );
}

export const ScheduleSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);
  const [bedtimePerm, setBedtimePerm] = useState<boolean | null>(null);

  const suggestion = (() => {
    const needMin = computeSleepNeed(
      records,
      Math.round(userProfile.targetDurationHours * 60),
      userProfile.chronotype ?? 'night',
    ).needMinutes;
    const msfMin = computeMSFsc(records, userProfile.chronotype ?? 'night')?.msfMinutes ?? null;
    return computeSuggestedSchedule(needMin, msfMin, {
      bed: userProfile.targetBedtime,
      wake: userProfile.targetWakeTime,
      durationHours: userProfile.targetDurationHours,
    });
  })();

  return (
    <SubpageShell title="我的作息与闹钟" subtitle="作息目标、夜间守护与定制闹钟" theme={theme}>
      {/* 1. 作息目标与夜间守护（从首页聚合至此） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-amber-500/20 text-amber-300 flex items-center justify-center border border-amber-400">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">作息目标</h3>
              <p className="text-[10px] font-mono text-slate-400">
                {userProfile.targetBedtime} 入睡 · {userProfile.targetDurationHours}h · {userProfile.targetWakeTime} 醒来
              </p>
            </div>
          </div>
        </div>

        {suggestion && (
          <button
            type="button"
            data-no-swipe
            aria-label={`按科学建议采用作息：${suggestion.bed} 入睡，${suggestion.wake} 醒来`}
            onClick={() =>
              updateProfile({
                targetBedtime: suggestion.bed,
                targetWakeTime: suggestion.wake,
                targetDurationHours: suggestion.durationHours,
              })
            }
            className={`w-full flex items-center justify-between gap-2 min-h-10 px-3.5 rounded-xl border ${theme.cardInnerBorder} ${theme.cardInnerBg} cursor-pointer active:scale-[0.98] transition-transform`}
          >
            <span className="text-[11px] font-bold text-slate-200">
              按科学建议采用 <span className="font-display">{suggestion.bed} – {suggestion.wake}</span>
            </span>
            <span className={`text-[10px] font-bold ${theme.accentText}`}>
              {suggestion.basis === 'msf' ? 'MSFsc 锚定 ›' : '需求推算 ›'}
            </span>
          </button>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner`}>
            <span className="text-xs font-bold text-slate-200 block mb-1">目标就寝</span>
            <input
              type="time"
              aria-label="目标就寝"
              value={userProfile.targetBedtime}
              onChange={(e) => {
                if (!e.target.value) return;
                updateProfile({
                  targetBedtime: e.target.value,
                  targetWakeTime: toClock(toMin(e.target.value) + Math.round(userProfile.targetDurationHours * 60)),
                });
              }}
              className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme.focusRing} cursor-pointer`}
            />
          </div>
          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner`}>
            <span className="text-xs font-bold text-slate-200 block mb-1">目标醒来</span>
            <input
              type="time"
              aria-label="目标醒来"
              value={userProfile.targetWakeTime}
              onChange={(e) => {
                if (!e.target.value) return;
                const durH = Math.min(
                  12,
                  Math.max(
                    4,
                    Math.round(((toMin(e.target.value) - toMin(userProfile.targetBedtime) + 1440) % 1440) / 30) * 0.5,
                  ),
                );
                if (!Number.isFinite(durH)) return;
                updateProfile({ targetWakeTime: e.target.value, targetDurationHours: durH });
              }}
              className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme.focusRing} cursor-pointer`}
            />
          </div>
        </div>

        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner space-y-2`}>
          <div className="flex justify-between text-xs font-bold">
            <span className="text-slate-200">目标睡眠时长</span>
            <span className={`${theme.accentText} font-display text-sm`}>{userProfile.targetDurationHours} 小时</span>
          </div>
          <input
            type="range"
            min={4}
            max={12}
            step={0.5}
            aria-label="目标睡眠时长"
            value={userProfile.targetDurationHours}
            onChange={(e) => {
              const h = Number(e.target.value);
              updateProfile({
                targetDurationHours: h,
                targetWakeTime: toClock(toMin(userProfile.targetBedtime) + Math.round(h * 60)),
              });
            }}
            className="w-full cursor-pointer h-2 bg-slate-700 rounded-lg"
            style={{ accentColor: theme.accentHex }}
          />
        </div>

        {/* 到点提醒与深夜救援 */}
        <div className="space-y-2.5 pt-1">
          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between`}>
            <div>
              <span className="text-xs font-bold text-slate-200 block">到点提醒我</span>
              <span className="text-[10px] text-slate-400">到达目标就寝时刻轻柔提醒减速</span>
            </div>
            <button
              type="button"
              data-no-swipe
              onClick={() => {
                const next = !userProfile.bedtimeReminderEnabled;
                updateProfile({ bedtimeReminderEnabled: next });
                if (next) {
                  void requestAlarmPermissions();
                  try {
                    const plugin = nativePlugin<{ bedtimePermission?: () => Promise<{ granted?: boolean }> }>('SleepCore');
                    if (plugin?.bedtimePermission) {
                      void plugin.bedtimePermission().then((res) => setBedtimePerm(!!res?.granted));
                    }
                  } catch {
                    /* 网页端无原生层 */
                  }
                }
              }}
              aria-pressed={!!userProfile.bedtimeReminderEnabled}
              aria-label="到点提醒我"
              className="relative inline-flex items-center cursor-pointer shrink-0"
            >
              <span
                className={`block w-10 h-5 rounded-full transition-colors relative ${
                  userProfile.bedtimeReminderEnabled ? 'bg-amber-500' : 'bg-slate-600'
                }`}
              >
                <span
                  className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                  style={{ left: userProfile.bedtimeReminderEnabled ? '22px' : '2px' }}
                />
              </span>
            </button>
          </div>

          {userProfile.bedtimeReminderEnabled && bedtimePerm === false && (
            <button
              type="button"
              data-no-swipe
              onClick={() => {
                try {
                  void nativePlugin<{ bedtimeOpenPermission?: () => Promise<void> }>('SleepCore')?.bedtimeOpenPermission?.();
                } catch {
                  /* ignore */
                }
              }}
              className="w-full py-2.5 rounded-xl bg-orange-500/20 border border-orange-400 text-orange-200 text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform"
            >
              提醒需要悬浮窗权限 · 前往系统设置授权
            </button>
          )}

          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between`}>
            <div>
              <span className="text-xs font-bold text-slate-200 block">深夜救援</span>
              <span className="text-[10px] text-slate-400">半夜亮屏超过 5 分钟时由通知栏静默守护</span>
            </div>
            <button
              type="button"
              data-no-swipe
              onClick={() => {
                updateProfile({ nightRescueEnabled: userProfile.nightRescueEnabled === false });
              }}
              aria-pressed={userProfile.nightRescueEnabled !== false}
              aria-label="深夜救援"
              className="relative inline-flex items-center cursor-pointer shrink-0"
            >
              <span
                className={`block w-10 h-5 rounded-full transition-colors relative ${
                  userProfile.nightRescueEnabled !== false ? 'bg-sky-500' : 'bg-slate-600'
                }`}
              >
                <span
                  className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                  style={{ left: userProfile.nightRescueEnabled !== false ? '22px' : '2px' }}
                />
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. 作息类型（决定自动记录提议的适用时段；选"不规律"则不做自动提议） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
            <Moon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white">我的作息</h3>
            <p className="text-[10px] text-slate-400">决定自动记录的主睡时段</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          {([
            { key: 'night', label: '夜间为主' },
            { key: 'day', label: '白天为主' },
            { key: 'irregular', label: '不规律' },
          ] as const).map((opt) => {
            const active = (userProfile.chronotype ?? 'night') === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  const reclassified = reclassifyForChronotype(records, opt.key);
                  const changed = JSON.stringify(reclassified) !== JSON.stringify(records);
                  updateProfile({ chronotype: opt.key });
                  if (changed) {
                    relinkLedgerAfterReclassify(records, reclassified);
                    replaceSleepRecords(reclassified);
                  }
                }}
                aria-pressed={active}
                className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                  active ? `${theme.accentText} border ${theme.accentBorder}` : 'bg-slate-800 border-slate-600 text-slate-400'
                }`}
                style={active ? { background: `${theme.accentHex}14` } : undefined}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {(userProfile.chronotype ?? 'night') === 'irregular' && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            已关闭自动提议；手动补录不受影响。
          </p>
        )}
      </div>

      {/* 3. 关怀提醒：晨间确认 + 断记召回 */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl p-5 space-y-3`}>
        <div className="flex items-center gap-2.5">
          <div
            className={`w-9 h-9 rounded-2xl ${theme.accentText} flex items-center justify-center border ${theme.accentBorder} shrink-0`}
            style={{ background: `${theme.accentHex}1f` }}
          >
            <BellRing className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-black text-white">关怀提醒</h3>
            <p className="text-[10px] text-slate-400">只在原生应用生效；权限沿用首次询问纪律</p>
          </div>
        </div>
        {([
          [
            'somnacare_notify_morning',
            '晨间确认提醒',
            '夜间监测过夜后，次日 09:00 提醒你确认记录',
          ],
          [
            'somnacare_notify_recall',
            '断记召回',
            '连续 2 晚没记录时，本周一条 21:00 的温和提醒',
          ],
        ] as const).map(([key, label, desc]) => (
          <NotifyToggle key={key} storageKey={key} label={label} desc={desc} theme={theme} />
        ))}
      </div>

      {/* 4. 自定义闹钟管理器 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl`}>
        <AlarmManager
          alarms={userProfile.alarms || []}
          onUpdateAlarms={(input) =>
            updateProfile((prev) => ({
              alarms:
                typeof input === 'function'
                  ? (input as (p: CustomAlarmSetting[]) => CustomAlarmSetting[])(
                      (prev.alarms ?? []) as CustomAlarmSetting[],
                    )
                  : input,
            }))
          }
          theme={theme}
        />
      </div>
    </SubpageShell>
  );
};
