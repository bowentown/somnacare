import React, { useState } from 'react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { DurationValue } from '../../../shared/ui';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { useSleepStore } from '../../sleep/store/sleepStore';
import { nightsOnly } from '../../sleep/utils/recordFilter';
import type { SleepRecord } from '../../../shared/types/sleep';
import { SleepCalendar } from '../SleepCalendar';

export const TrendsCalendarSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);

  const nightRecs = nightsOnly(records);
  const latestNight = nightRecs.reduce<SleepRecord | null>((a, r) => (!a || r.date > a.date ? r : a), null);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => latestNight?.date ?? null);

  const calSel = selectedDate ?? latestNight?.date ?? null;
  const calRec = calSel
    ? (records.find((r) => r.date === calSel && r.kind !== 'nap') ?? records.find((r) => r.date === calSel))
    : undefined;

  const innerBg = theme.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme.cardInnerBorder || 'border-slate-700/80';
  const accentText = theme.accentText || 'text-indigo-400';
  const textMuted = theme.textMuted || 'text-slate-400';

  return (
    <SubpageShell title="睡眠日历" subtitle="按月回看每日睡眠质量与枕边声事件" theme={theme}>
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-black text-white">月度概览</span>
          <span className="text-[10px] font-mono text-slate-400">
            {calSel ? `${Number(calSel.slice(5, 7))}月${Number(calSel.slice(8, 10))}日` : ''}
          </span>
        </div>

        <SleepCalendar records={records} accentHex={theme.accentHex} selected={calSel} onSelect={setSelectedDate} />

        <div className={`${innerBg} border ${innerBorder} rounded-2xl p-4`}>
          {calRec ? (
            <div className="space-y-2" data-testid="calendar-detail">
              <div className="grid grid-cols-3 gap-2.5">
                <div className="min-w-0">
                  <span className={`text-[10px] ${textMuted} block`}>评分</span>
                  <span className={`text-xl font-bold font-display tabular-nums ${accentText}`}>
                    {calRec.sleepScore ?? '—'}
                  </span>
                </div>
                <div className="min-w-0">
                  <span className={`text-[10px] ${textMuted} block`}>时长</span>
                  <DurationValue minutes={calRec.durationMinutes ?? 0} className="text-xl text-white" />
                </div>
                <div className="min-w-0">
                  <span className={`text-[10px] ${textMuted} block`}>效率</span>
                  <span className="text-xl font-bold font-display tabular-nums text-emerald-400">
                    {calRec.sleepEfficiency ?? '—'}
                    <span className="text-sm">%</span>
                  </span>
                </div>
              </div>
              <p className="text-[10px] font-mono text-slate-400 whitespace-nowrap overflow-hidden">
                就寝 {calRec.bedtime} · 起床 {calRec.wakeTime}
                {typeof calRec.latencyMinutes === 'number' && <> · 潜伏 {calRec.latencyMinutes} 分</>}
                {typeof calRec.wakeCount === 'number' && <> · 夜醒 {calRec.wakeCount} 次</>}
              </p>
              {calRec.soundEvents && calRec.soundEvents.length > 0 && (() => {
                const loudest = Math.max(...calRec.soundEvents.map((s) => s.decibel));
                return (
                  <p className="text-[10px] font-mono text-slate-400" data-testid="sound-events-line">
                    夜间声事件 {calRec.soundEvents.length} 次（最响 {loudest}dB）
                  </p>
                );
              })()}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400 leading-relaxed" data-testid="calendar-detail">
              {calSel ? '该日无记录' : '点击上方日期查看当夜睡眠详情'}
            </p>
          )}
        </div>
      </div>
    </SubpageShell>
  );
};
