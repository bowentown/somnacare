import React, { useState } from 'react';
import { BellRing, Moon } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { Switch } from '../../shared/ui';
import type { CustomAlarmSetting } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { replaceSleepRecords, useSleepStore } from '../../features/sleep/store/sleepStore';
import { reclassifyForChronotype } from '../../features/sleep/utils/recordFilter';
import { relinkLedgerAfterReclassify } from '../../features/pet/services/travelService';
import { AlarmManager } from '../../features/sleep/components/AlarmManager';

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

  return (
    <SubpageShell title="我的作息与闹钟" subtitle="主睡时段、晨间关怀与定制闹钟" theme={theme}>
      {/* 作息类型（决定自动记录提议的适用时段；选"不规律"则不做自动提议） */}
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

      {/* 关怀提醒：晨间确认 + 断记召回 */}
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

      {/* 自定义闹钟管理器 */}
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
