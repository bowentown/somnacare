import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useMinuteTick } from '../../../shared/hooks/useMinuteTick';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Hourglass,
  Music2,
  Plus,
  Play,
  ShieldAlert,
  Wind,
} from 'lucide-react';
import { EmptyState } from '../../../shared/ui';
import { computeSleepDebt, computeSleepNeed, formatDurationChinese } from '../utils/sleepScore';
import { OneTapSleepTracker } from './OneTapSleepTracker';
import { nightsOnly, napsOnly } from '../utils/recordFilter';
import { nightKeyOfBed, toLocalDateString, localDateOffset } from '../../../shared/utils/dateUtils';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';
import { queryWindDownApps, type WindDownResult } from '../utils/usageSignal';
import { getDayPhase } from '../../../shared/utils/dayPhase';
import { computeWeekReport } from '../../trends/utils/weekReport';
import { getTravelProgress, loadTravelState, TRIP_ENERGY_TARGET } from '../../pet/services/travelService';
import { scheduleMorningConfirmNotify } from '../utils/careNotifications';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../../shared/store/profileStore';
import { saveManualSleepRecord, useSleepStore } from '../store/sleepStore';
import {
  openActiveSleepModal,
  openAutoCheckSubpage,
  openManualLogModal,
  pushSubpage,
  setActiveTab,
  uiStore,
  useUIStore,
} from '../../../shared/store/uiStore';
import { PondCard } from './PondCard';
import { SleepDial } from './SleepDial';
import { MoonEnergy } from './MoonEnergy';

// 助眠音景弹窗含 730 行 Web Audio 合成器，仅点击打开时懒加载
const SoundscapePlayer = lazy(() =>
  import('../../intervention/SoundscapePlayer').then((m) => ({ default: m.SoundscapePlayer })),
);

const TodayTabInner: React.FC = () => {
  const records = useSleepStore((s) => s.records);
  const celebrateSignal = useSleepStore((s) => s.pondCelebrateCount);
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const startSignal = useUIStore((s) => s.sleepStartSignal);
  const chronotype = userProfile.chronotype;

  const onUpdateProfile = updateProfile;
  const onOpenActiveSleep = openActiveSleepModal;
  const onOpenManualLog = useCallback(() => openManualLogModal(), []);
  const onOpenManualLogPrefilled = useCallback(
    (p: { date: string; bedtime: string; wakeTime: string }) => openManualLogModal(p),
    [],
  );
  const onMonitoringStart = useCallback(() => {
    void scheduleMorningConfirmNotify(
      nightKeyOfBed(Date.now(), chronotype === 'day' ? 'day' : 'night'),
    );
  }, [chronotype]);
  const onNavigateToTrends = useCallback(() => setActiveTab('trends'), []);
  const onSaveRecord = saveManualSleepRecord;
  const onOpenAutoCheck = openAutoCheckSubpage;
  const onOpenCodex = useCallback(() => uiStore.setState({ codexOpen: true }), []);

  const latestRecord = useMemo(() => nightsOnly(records)[0] || null, [records]);
  const todayNaps = useMemo(
    () => napsOnly(records).filter((r) => r.date === toLocalDateString()),
    [records],
  );

  const phaseNow = useMinuteTick();
  const dayPhase = getDayPhase(phaseNow);
  const isEvening = dayPhase === 'evening' || dayPhase === 'late';
  const [sleepExpanded, setSleepExpanded] = useState(() => !isEvening);
  useEffect(() => {
    setSleepExpanded(!isEvening);
  }, [isEvening]);

  const travel = useMemo(() => loadTravelState(), [records]);
  const travelProgress = useMemo(() => getTravelProgress(), [records]);
  const streak = useMemo(() => computeWeekReport(records).streak, [records]);

  const [windDown, setWindDown] = useState<WindDownResult | null>(null);
  const phaseDate = useMemo(() => toLocalDateString(phaseNow), [phaseNow]);
  const windDownKey = useMemo(
    () => (userProfile.chronotype === 'day' ? toLocalDateString() : localDateOffset(-1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userProfile.chronotype, phaseDate],
  );
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    void queryWindDownApps(windDownKey, userProfile.chronotype ?? 'night')
      .then((r) => {
        if (!cancelled && r) setWindDown(r);
      })
      .catch(() => {
        /* 无权限/不支持：卡片不出现 */
      });
    return () => {
      cancelled = true;
    };
  }, [windDownKey, records.length, userProfile.chronotype]);

  const [mixerOpen, setMixerOpen] = useState(false);

  const [proposalPresence, setProposalPresence] = useState(false);
  const nowHour = phaseNow.getHours();
  const autoRescue = (() => {
    if (!onOpenAutoCheck || !isNativePlatform()) return false;
    if ((userProfile.sleepRecordMode ?? 'manual') !== 'auto') return false;
    if ((userProfile.chronotype ?? 'night') !== 'night') return false;
    if (nowHour < 8 || nowHour >= 13) return false;
    if (proposalPresence) return false;
    const lastNight = localDateOffset(-1);
    if (nightsOnly(records).some((r) => r.date === lastNight)) return false;
    try {
      if (localStorage.getItem('somnacare_proposal_handled') === lastNight) return false;
      if (localStorage.getItem('somnacare_bedtime_start')) return false;
    } catch {
      /* ignore */
    }
    return true;
  })();

  const getScoreColor = (score: number) => {
    if (score >= 88) return { text: theme.accentText, stroke: theme.accentHex, label: '优' };
    if (score >= 78) return { text: 'text-emerald-400', stroke: '#34d399', label: '良' };
    if (score >= 68) return { text: 'text-amber-400', stroke: '#fbbf24', label: '平' };
    return { text: 'text-rose-400', stroke: '#f87171', label: '差' };
  };

  const scoreInfo = latestRecord ? getScoreColor(latestRecord.sleepScore) : getScoreColor(85);

  const targetCompare = (() => {
    if (!latestRecord || !userProfile.targetBedtime || !userProfile.targetWakeTime) return null;
    const target = `${userProfile.targetBedtime}–${userProfile.targetWakeTime}`;
    const nightCalibratedDefault =
      userProfile.chronotype === 'day' && userProfile.targetBedtime === '23:30';
    if (nightCalibratedDefault) {
      return { target, text: '目标仍为夜间口径 · 建议改设置', tone: 'text-slate-400' };
    }
    const [bh, bm] = latestRecord.bedtime.split(':').map(Number);
    const [th, tm] = userProfile.targetBedtime.split(':').map(Number);
    let diff = bh * 60 + bm - (th * 60 + tm);
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    if (diff === 0) return { target, text: '与目标一致', tone: 'text-emerald-400' };
    return diff > 0
      ? { target, text: `晚于目标 ${diff} 分钟`, tone: 'text-rose-400' }
      : { target, text: `早于目标 ${-diff} 分钟`, tone: theme.accentText };
  })();

  const sectionOrder = isEvening
    ? { tracker: 1, actions: 2, moon: 3, pond: 4, sleep: 5, nap: 6 }
    : dayPhase === 'morning'
      ? { tracker: 1, sleep: 2, moon: 3, pond: 4, nap: 5, actions: 6 }
      : { tracker: 1, nap: 2, sleep: 3, moon: 4, pond: 5, actions: 6 };

  const enabledAlarms = (userProfile.alarms || []).filter((a) => a.enabled).length;

  return (
    <div className={`flex flex-col gap-3.5 pb-28 ${theme.textPrimary}`}>
      {/* 1. 一键就寝与自动记录提议 */}
      <div style={{ order: sectionOrder.tracker }} className="space-y-3.5">
        {onSaveRecord && (
          <OneTapSleepTracker
            onSaveRecord={onSaveRecord}
            startSignal={startSignal}
            onMonitoringStart={onMonitoringStart}
            theme={theme}
            targetDurationHours={userProfile.targetDurationHours}
            records={records}
            userProfile={userProfile}
            onOpenManualLogPrefilled={onOpenManualLogPrefilled}
            onUpdateProfile={onUpdateProfile}
            onProposalPresenceChange={setProposalPresence}
          />
        )}

        {autoRescue && (
          <button
            type="button"
            onClick={onOpenAutoCheck}
            aria-label="检查自动记录链路"
            className={`w-full ${theme.cardBg} rounded-3xl px-4 py-3 border ${theme.cardBorder} flex items-center justify-between gap-3 text-left cursor-pointer active:scale-[0.99] transition-transform shadow-md`}
          >
            <span className="flex items-center gap-2 text-[11px] font-bold text-slate-200">
              <ShieldAlert className={`w-4 h-4 ${theme.accentText}`} />
              自动记录没出现？
            </span>
            <span className={`flex items-center gap-1 text-[11px] font-black ${theme.accentText}`}>
              检查一下 <ChevronRight className="w-3.5 h-3.5" />
            </span>
          </button>
        )}
      </div>

      {/* 2. 锦鲤池 */}
      <div style={{ order: sectionOrder.pond }}>
        <PondCard
          theme={theme}
          records={records}
          userProfile={userProfile}
          celebrateSignal={celebrateSignal}
          streak={streak}
        />
      </div>

      {/* 3. 当天小睡紧凑行 */}
      {todayNaps.length > 0 && (
        <div style={{ order: sectionOrder.nap }}>
          <div className={`${theme.cardBg} rounded-3xl px-4 py-3 border ${theme.cardBorder} flex items-center gap-2 text-[11px]`}>
            <span>😴</span>
            <span className="font-bold text-white">
              今天已小睡 {todayNaps.length} 次 · 共{' '}
              {Math.floor(todayNaps.reduce((a, r) => a + r.durationMinutes, 0) / 60) > 0
                ? `${Math.floor(todayNaps.reduce((a, r) => a + r.durationMinutes, 0) / 60)} 小时 `
                : ''}
              {todayNaps.reduce((a, r) => a + r.durationMinutes, 0) % 60} 分
            </span>
            <span className="text-slate-400 ml-auto">不计入规律度</span>
          </div>
        </div>
      )}

      {/* 4. 梦境漫游能量条 */}
      {onOpenCodex && (
        <div style={{ order: sectionOrder.moon }}>
          <button
            type="button"
            onClick={onOpenCodex}
            aria-label="打开梦境旅行图鉴"
            className={`w-full ${theme.cardBg} rounded-3xl px-4 py-3 border ${theme.cardBorder} flex items-center gap-3 text-left cursor-pointer active:scale-[0.99] transition-transform shadow-md`}
          >
            <MoonEnergy value={travel.currentEnergy} target={TRIP_ENERGY_TARGET} size={38} />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black text-white">梦境漫游</p>
              <p className="text-[10px] font-mono text-slate-400 mt-0.5">
                {travel.currentEnergy} / {TRIP_ENERGY_TARGET}
              </p>
            </div>
            <span className={`flex items-center gap-1 text-[10px] font-black ${theme.accentText}`}>
              图鉴 {travelProgress.unlockedCount}
              <ChevronRight className="w-3.5 h-3.5" />
            </span>
          </button>
        </div>
      )}

      {/* 5. 昨晚睡眠主卡 + 放下手机前的一小时 */}
      <div style={{ order: sectionOrder.sleep }} className="space-y-3.5">
        {latestRecord ? (
          isEvening && !sleepExpanded ? (
            <div className={`rounded-3xl p-4 ${theme.cardBg} border ${theme.cardBorder} shadow-xl`}>
              <button
                type="button"
                onClick={() => setSleepExpanded(true)}
                aria-label="展开昨晚睡眠详情"
                className="w-full flex items-center gap-3 text-left cursor-pointer active:scale-[0.99] transition-transform"
              >
                <SleepDial
                  record={latestRecord}
                  scoreHex={scoreInfo.stroke}
                  scoreLabel={scoreInfo.label}
                  size={64}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-black text-xs">昨晚睡眠</span>
                    <span className="font-mono text-slate-400 text-[10px]">{latestRecord.date}</span>
                  </div>
                  <p className="font-mono text-slate-200 text-[11px] mt-1">
                    {formatDurationChinese(latestRecord.durationMinutes)} · {latestRecord.bedtime} → {latestRecord.wakeTime}
                  </p>
                </div>
                <ChevronDown className={`w-4 h-4 ${theme.accentText}`} />
              </button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label="查看最近一晚睡眠详情，跳转到趋势"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onNavigateToTrends?.();
                }
              }}
              onClick={() => onNavigateToTrends?.()}
              className={`rounded-3xl p-5 ${theme.cardBg} border ${theme.cardBorder} shadow-xl transition-all cursor-pointer hover:border-white/20 active:scale-[0.99]`}
            >
              <div className="flex items-center justify-between text-xs mb-3 font-medium">
                <span className="text-white font-black flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${theme.dot}`}></span>
                  昨晚睡眠
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-slate-300 font-bold">{latestRecord.date}</span>
                  <ChevronRight className={`w-3.5 h-3.5 ${theme.accentText}`} />
                </span>
              </div>

              <div className="flex items-center gap-5 my-1">
                <SleepDial
                  record={latestRecord}
                  scoreHex={scoreInfo.stroke}
                  scoreLabel={scoreInfo.label}
                  size={96}
                />

                <div className="flex-1 min-w-0 space-y-2.5 text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-slate-300 font-bold whitespace-nowrap">总睡眠时长</span>
                    <span className="font-bold text-white font-display text-sm whitespace-nowrap">
                      {formatDurationChinese(latestRecord.durationMinutes)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-slate-300 font-bold whitespace-nowrap">入睡 / 醒来</span>
                    <span className="font-display text-slate-100 font-bold whitespace-nowrap">
                      {latestRecord.bedtime} - {latestRecord.wakeTime}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-slate-300 font-bold whitespace-nowrap">睡眠效率</span>
                    <span className="font-display text-emerald-400 font-bold whitespace-nowrap">
                      {latestRecord.sleepEfficiency}%
                    </span>
                  </div>
                </div>
              </div>

              {targetCompare && (
                <div className="mt-3 pt-3 border-t border-slate-700/60 flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-slate-400 font-mono whitespace-nowrap">目标 {targetCompare.target}</span>
                  <span className={`font-bold whitespace-nowrap ${targetCompare.tone}`}>{targetCompare.text}</span>
                </div>
              )}

              {latestRecord.dreamNotes && (
                <div className="mt-3 pt-3 border-t border-slate-700/80 text-xs text-slate-200">
                  <span className={`${theme.accentText} font-bold`}>梦境记录：</span>
                  <span className="line-clamp-3 break-words">{latestRecord.dreamNotes}</span>
                </div>
              )}
            </div>
          )
        ) : (
          <EmptyState
            theme={theme}
            illustration="no-data"
            title="暂无睡眠记录"
            hint="点下方「晨起手动补录」记下第一晚"
          />
        )}

        {windDown && windDown.apps.length > 0 && (() => {
          const totalMin = windDown.apps.reduce((a, x) => a + x.minutes, 0);
          const wNeed = computeSleepNeed(
            records,
            Math.round(userProfile.targetDurationHours * 60),
            userProfile.chronotype ?? 'night',
          );
          const wDebt =
            wNeed.basis === 'personal'
              ? computeSleepDebt(records, wNeed.baselineMinutes, userProfile.chronotype ?? 'night')
              : null;
          const debtNudge =
            wDebt && wDebt.debtMinutes >= 60
              ? `近 7 晚欠下 ${formatDurationChinese(wDebt.debtMinutes)} 睡债——今晚建议提前 30 分钟放下手机。`
              : null;
          const putDown = new Date(windDown.windowEnd);
          const hm = `${String(putDown.getHours()).padStart(2, '0')}:${String(putDown.getMinutes()).padStart(2, '0')}`;
          return (
            <div
              className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}
              data-testid="winddown-card"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Hourglass className={`w-4 h-4 ${theme.accentText}`} />
                  <h3 className="text-sm font-bold text-white">放下手机前的一小时</h3>
                </div>
                <span className="text-[10px] text-slate-400 font-mono shrink-0">{hm} 放下</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-bold font-display tabular-nums ${theme.accentText}`}>{totalMin}</span>
                <span className="text-xs text-slate-300">分钟还在亮屏</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {windDown.apps.slice(0, 4).map((a) => (
                  <span
                    key={a.pkg}
                    className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-full px-2.5 py-1 text-[11px] text-slate-200 font-bold`}
                  >
                    {a.label}
                    <span className={`ml-1 font-mono ${theme.accentText}`}>{a.minutes}m</span>
                  </span>
                ))}
              </div>
              {totalMin >= 55 && (
                <p className="text-[10px] text-amber-300 leading-relaxed">
                  放下前手机几乎没停过——大脑可能需要更久才能平静下来。
                </p>
              )}
              {debtNudge && (
                <p className={`text-[10px] ${theme.accentText} leading-relaxed`} data-testid="winddown-debt">
                  {debtNudge}
                </p>
              )}
            </div>
          );
        })()}
      </div>

      {/* 6. 统一快捷入口区（2×2 紧凑网格 + 单行作息与闹钟入口） */}
      <div style={{ order: sectionOrder.actions }} className="space-y-3">
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={onOpenManualLog}
            className={`p-3.5 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-white/20 text-left transition-all active:scale-[0.98] flex items-center gap-3 cursor-pointer shadow-md`}
          >
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Plus className="w-4 h-4 stroke-[3]" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-black text-white block truncate">晨起手动补录</span>
              <span className="text-[10px] text-slate-400 block truncate">补记或补小睡</span>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenActiveSleep}
            className={`p-3.5 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-white/20 text-left transition-all active:scale-[0.98] flex items-center gap-3 cursor-pointer shadow-md`}
          >
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Play className="w-4 h-4 fill-current ml-0.5" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-black text-white block truncate">床头夜钟伴眠</span>
              <span className="text-[10px] text-slate-400 block truncate">极暗时钟守护</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMixerOpen(true)}
            className={`p-3.5 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-white/20 text-left transition-all active:scale-[0.98] flex items-center gap-3 cursor-pointer shadow-md`}
          >
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Music2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-black text-white block truncate">助眠音景</span>
              <span className="text-[10px] text-slate-400 block truncate">多层混音定时</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => pushSubpage('intervention/wind-down')}
            className={`p-3.5 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-white/20 text-left transition-all active:scale-[0.98] flex items-center gap-3 cursor-pointer shadow-md`}
          >
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Wind className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-black text-white block truncate">睡前仪式</span>
              <span className="text-[10px] text-slate-400 block truncate">呼吸与微习惯</span>
            </div>
          </button>
        </div>

        {/* 单行作息速览与调整直达（完整设置已收纳至偏好 → 我的作息与闹钟） */}
        <button
          type="button"
          onClick={() => pushSubpage('settings/schedule')}
          className={`w-full px-4 py-3 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-white/20 flex items-center justify-between gap-2 text-left cursor-pointer active:scale-[0.99] transition-all shadow-md`}
        >
          <span className="flex items-center gap-2 text-xs font-bold text-slate-200 min-w-0">
            <Clock className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="truncate">
              作息目标 <span className="font-mono text-white">{userProfile.targetBedtime} – {userProfile.targetWakeTime}</span>
              {enabledAlarms > 0 ? ` · ${enabledAlarms} 个闹钟` : ''}
            </span>
          </span>
          <span className={`flex items-center gap-0.5 text-[11px] font-bold ${theme.accentText} shrink-0`}>
            调整与提醒 <ChevronRight className="w-3.5 h-3.5" />
          </span>
        </button>

        {mixerOpen && (
          <Suspense fallback={null}>
            <SoundscapePlayer theme={theme} onClose={() => setMixerOpen(false)} />
          </Suspense>
        )}
      </div>
    </div>
  );
};

export const TodayTab = React.memo(TodayTabInner);
