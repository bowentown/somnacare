import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Plus,
  Play,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { EmptyState } from './ui';
import { SleepRecord, UserProfile } from '../types/sleep';
import { formatDurationChinese } from '../utils/sleepScore';
import { OneTapSleepTracker } from './OneTapSleepTracker';
import { nightsOnly, napsOnly } from '../utils/recordFilter';
import { toLocalDateString } from '../utils/dateUtils';
import { SoundscapePlayer } from './SoundscapePlayer';
import { Music2 } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { isNativePlatform, requestAlarmPermissions } from '../utils/nativeAlarmScheduler';
import { localDateOffset } from '../utils/dateUtils';
import { getDayPhase } from '../utils/dayPhase';
import { computeWeekReport } from '../utils/weekReport';
import { getTravelProgress, loadTravelState, TRIP_ENERGY_TARGET } from '../services/travelService';
import { PondCard } from './PondCard';
import { SleepDial } from './SleepDial';
import { MoonEnergy } from './MoonEnergy';

interface TodayTabProps {
  records: SleepRecord[];
  userProfile: UserProfile;
  onOpenActiveSleep: () => void;
  onOpenManualLog: () => void;
  onOpenManualLogPrefilled?: (p: { date: string; bedtime: string; wakeTime: string }) => void;
  onNavigateToTrends?: () => void;
  onSaveRecord?: (record: SleepRecord) => void;
  onUpdateProfile: (updated: Partial<UserProfile>) => void;
  /** 到点提醒'好的'后的开始监测信号（时间戳 ms） */
  startSignal?: number;
  theme: ThemeConfig;
  /** 早上自动记录没出卡时，带用户去偏好页跑链路自检（第 56 轮） */
  onOpenAutoCheck?: () => void;
  /** 首页月相挂件：直达梦境旅行图鉴（第 57 轮） */
  onOpenCodex?: () => void;
  /** 记录保存后递增：池塘落涟漪（第 57 轮） */
  celebrateSignal?: number;
}

// 作息目标联动工具：HH:MM ↔ 当日分钟数（跨午夜安全）
const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toClock = (min: number): string => {
  const norm = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
};

export const TodayTab: React.FC<TodayTabProps> = ({
  records,
  userProfile,
  onOpenActiveSleep,
  onOpenManualLog,
    onOpenManualLogPrefilled,
  onNavigateToTrends,
  onSaveRecord,
  onUpdateProfile,
  startSignal,
  theme,
  onOpenAutoCheck,
  onOpenCodex,
  celebrateSignal,
}) => {
  // 首页主卡只显示夜睡（小睡另有紧凑行）——旧数据无 kind 视为夜睡
  const latestRecord = nightsOnly(records)[0] || null;
  const todayNaps = napsOnly(records).filter((r) => r.date === toLocalDateString());
  // 昼夜双布局（第 57 轮）：晚上把"开始/音景/目标"放前面，昨晚评分折叠到最后
  const [phaseNow, setPhaseNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setPhaseNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const dayPhase = getDayPhase(phaseNow);
  const isEvening = dayPhase === 'evening' || dayPhase === 'late';
  const [sleepExpanded, setSleepExpanded] = useState(() => !isEvening);
  useEffect(() => { setSleepExpanded(!isEvening); }, [isEvening]);
  // useMemo（第 81 轮性能）：travel 状态含同步 JSON.parse、周报要全量扫
  // 记录——此前每次渲染（60s 时钟/父级状态）都重算一遍，纯浪费
  const travel = useMemo(() => loadTravelState(), [records]);
  const travelProgress = useMemo(() => getTravelProgress(), [records]);
  const streak = useMemo(() => computeWeekReport(records).streak, [records]);
  const [goalOpen, setGoalOpen] = useState(false);
  // 睡前提醒的悬浮窗授权态：null=未检查。此前开关只翻布尔、不申请任何权限，
  // 提醒的投递路径（悬浮窗 > 通知兜底）在 Android 13+ 上会静默全部失效
  const [bedtimePerm, setBedtimePerm] = useState<boolean | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);

  // 早上自救助手（第 56 轮）：自动档 + 8:00–13:00 + 昨晚没记录 + 提议卡也没出
  // → 给一个直达链路自检的入口，而不是让用户自己去偏好页深处找
  const [proposalPresence, setProposalPresence] = useState(false);
  const [nowHour, setNowHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const t = window.setInterval(() => setNowHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(t);
  }, []);
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
    } catch { /* ignore */ }
    return true;
  })();

  const getScoreColor = (score: number) => {
    if (score >= 88) return { text: theme.accentText, stroke: theme.accentHex, label: '优' };
    if (score >= 78) return { text: 'text-emerald-400', stroke: '#34d399', label: '良' };
    if (score >= 68) return { text: 'text-amber-400', stroke: '#fbbf24', label: '平' };
    return { text: 'text-rose-400', stroke: '#f87171', label: '差' };
  };

  const scoreInfo = latestRecord ? getScoreColor(latestRecord.sleepScore) : getScoreColor(85);

  // 目标对比单独成行（不再挤在右侧窄列里导致"目标"竖排换行）
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
      : { target, text: `早于目标 ${-diff} 分钟`, tone: 'text-sky-400' };
  })();

  // 首页昼夜双布局的排序表：晚上先给"现在要做的事"，昨晚评分收到最后
  const sectionOrder = isEvening
    ? { tracker: 1, sound: 2, goals: 3, moon: 4, pond: 5, actions: 6, sleep: 7, nap: 8 }
    : dayPhase === 'morning'
      ? { tracker: 1, sleep: 2, moon: 3, pond: 4, nap: 5, actions: 6, sound: 7, goals: 8 }
      : { tracker: 1, nap: 2, sleep: 3, moon: 4, pond: 5, actions: 6, sound: 7, goals: 8 };

  return (
    <div className={`flex flex-col gap-4 pb-28 ${theme.textPrimary}`}>
      {/* 1. Primary One-Tap Sleep Tracker */}
      <div style={{ order: sectionOrder.tracker }} className="space-y-4">
      {onSaveRecord && <OneTapSleepTracker onSaveRecord={onSaveRecord} startSignal={startSignal} theme={theme} targetDurationHours={userProfile.targetDurationHours} records={records} userProfile={userProfile} onOpenManualLogPrefilled={onOpenManualLogPrefilled} onUpdateProfile={onUpdateProfile} onProposalPresenceChange={setProposalPresence} />}

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

      {/* 活的海：nagomi 程序化锦鲤池（主题 → 月夜/晴日/黄昏/雨），点水聚鱼 */}
      <div style={{ order: sectionOrder.pond }}>
        <PondCard theme={theme} records={records} userProfile={userProfile} celebrateSignal={celebrateSignal} streak={streak} />
      </div>

      {/* 当天小睡紧凑行（主卡只显示夜睡；小睡不顶掉主卡） */}
      <div style={{ order: sectionOrder.nap }}>
      {todayNaps.length > 0 && (
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
      )}
      </div>

      {/* 梦境漫游 · 月相能量（第 57 轮）：首页小挂件，点开直达图鉴 */}
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

      {/* 2. Last Sleep Overview Card with Unified Theme Colors */}
      <div style={{ order: sectionOrder.sleep }}>
      {latestRecord ? (
        isEvening && !sleepExpanded ? (
          /* 晚间折叠态：把评分收到一张小卡里，不占"准备入睡"的视线 */
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
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigateToTrends?.(); } }}
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
            {/* 睡眠完成度环（第 58 轮）：干净轨道 + 渐变弧 + 端点高光 */}
            <SleepDial
              record={latestRecord}
              scoreHex={scoreInfo.stroke}
              scoreLabel={scoreInfo.label}
              size={96}
            />

            {/* Metrics：标签/数值都不换行，避免"目 标"式的断字 */}
            <div className="flex-1 min-w-0 space-y-2.5 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-300 font-bold whitespace-nowrap">总睡眠时长</span>
                <span className="font-black text-white font-mono text-sm whitespace-nowrap">
                  {formatDurationChinese(latestRecord.durationMinutes)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-300 font-bold whitespace-nowrap">入睡 / 醒来</span>
                <span className="font-mono text-slate-100 font-bold whitespace-nowrap">
                  {latestRecord.bedtime} - {latestRecord.wakeTime}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-300 font-bold whitespace-nowrap">睡眠效率</span>
                <span className="font-mono text-emerald-400 font-black whitespace-nowrap">
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
      </div>

      {/* 4. Action Cards for Manual Log & Bedside Monitor */}
      <div className="grid grid-cols-2 gap-3 pt-1" style={{ order: sectionOrder.actions }}>
        <button
          type="button"
          onClick={onOpenManualLog}
          className={`p-4 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-slate-500 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-md`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <Plus className="w-4 h-4 stroke-[3]" />
            </div>
            <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
          </div>
          <span className="text-sm font-bold text-white block">晨起手动补录</span>
        </button>

        <button
          type="button"
          onClick={onOpenActiveSleep}
          className={`p-4 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} hover:border-slate-500 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-md`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <Play className="w-4 h-4 fill-current ml-0.5" />
            </div>
            <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
          </div>
          <span className="text-sm font-bold text-white block">床头夜钟伴眠</span>
        </button>
      </div>

      {/* 4.5 助眠音景混音器（BetterSleep 式多层叠加） */}
      <div style={{ order: sectionOrder.sound }} className="space-y-4">
      <button
        type="button"
        onClick={() => setMixerOpen(true)}
        className={`w-full p-4 rounded-3xl ${theme.cardBg} border ${theme.cardBorder} flex items-center justify-between cursor-pointer hover:border-white/20 transition-all active:scale-[0.99] shadow-md group`}
      >
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
            <Music2 className="w-4 h-4" />
          </div>
          <div className="text-left">
            <h4 className="text-sm font-black text-white">助眠音景</h4>
            <p className="text-[11px] text-slate-400">多层混音 · 呼吸放松 · 定时关闭</p>
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 ${theme.accentText} group-hover:translate-x-0.5 transition-transform`} />
      </button>

      {mixerOpen && (
        <SoundscapePlayer theme={theme} onClose={() => setMixerOpen(false)} />
      )}
      </div>

      {/* 5. 作息目标（默认折叠；编辑器内详尽） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`} style={{ order: sectionOrder.goals }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setGoalOpen(!goalOpen)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setGoalOpen(!goalOpen);
            }
          }}
          className="w-full flex items-center justify-between cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center border border-amber-400">
              <Clock className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-bold text-white">作息目标</h3>
          </div>
          <span className="flex items-center gap-2 text-[11px] font-mono text-slate-400 font-bold">
            {!goalOpen && `${userProfile.targetBedtime} · ${userProfile.targetDurationHours}h · ${userProfile.targetWakeTime}`}
            <ChevronDown className={`w-4 h-4 transition-transform ${goalOpen ? 'rotate-180' : ''}`} />
          </span>
        </div>

        {/* 到点提醒开关（常驻显示；默认关闭） */}
        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between`}>
          <div>
            <span className="text-xs font-bold text-slate-200 block">到点提醒我</span>
          </div>
          <button
            type="button"
            data-no-swipe
            onClick={(e) => {
              e.stopPropagation();
              const next = !userProfile.bedtimeReminderEnabled;
              onUpdateProfile({ bedtimeReminderEnabled: next });
              if (next) {
                // 打开即检查两条投递路径的权限：通知（兜底路径）+ 悬浮窗（主路径）
                void requestAlarmPermissions();
                try {
                  const cap = (window as any).Capacitor;
                  const plugin = cap?.isNativePlatform?.() ? cap.Plugins?.GemmaLLM : null;
                  if (plugin?.bedtimePermission) {
                    void plugin.bedtimePermission().then((res: any) => setBedtimePerm(!!res?.granted));
                  }
                } catch { /* 网页端无原生层，按钮不显示 */ }
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

        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between`}>
          <div>
            <span className="text-xs font-bold text-slate-200 block">深夜救援</span>
          </div>
          <button
            type="button"
            data-no-swipe
            onClick={(e) => {
              e.stopPropagation();
              onUpdateProfile({ nightRescueEnabled: userProfile.nightRescueEnabled === false });
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

        {userProfile.bedtimeReminderEnabled && bedtimePerm === false && (
          <button
            type="button"
            data-no-swipe
            onClick={(e) => {
              e.stopPropagation();
              try {
                const cap = (window as any).Capacitor;
                const plugin = cap?.isNativePlatform?.() ? cap.Plugins?.GemmaLLM : null;
                void plugin?.bedtimeOpenPermission?.();
              } catch { /* ignore */ }
            }}
            className="w-full mt-2.5 py-2.5 rounded-xl bg-orange-500/20 border border-orange-400 text-orange-200 text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform"
          >
            提醒需要悬浮窗权限 · 前往系统设置授权
          </button>
        )}

        {goalOpen && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <span className="text-xs font-bold text-slate-200 block mb-1">目标就寝</span>
              <input
                type="time"
                value={userProfile.targetBedtime}
                onChange={(e) => {
                  // 清空的 <input type="time"> 会产出 "" → NaN 持久化成
                  // "NaN:NaN" 并流入原生 nightRescueSet（第 51 轮审计 P1）
                  if (!e.target.value) return;
                  onUpdateProfile({
                    targetBedtime: e.target.value,
                    targetWakeTime: toClock(toMin(e.target.value) + Math.round(userProfile.targetDurationHours * 60)),
                  });
                }}
                className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme?.focusRing} cursor-pointer`}
              />
            </div>
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <span className="text-xs font-bold text-slate-200 block mb-1">目标醒来</span>
              <input
                type="time"
                value={userProfile.targetWakeTime}
                onChange={(e) => {
                  if (!e.target.value) return;   // 清空不落库（NaN 防护）
                  const durH = Math.min(12, Math.max(4, Math.round(((toMin(e.target.value) - toMin(userProfile.targetBedtime) + 1440) % 1440) / 30) * 0.5));
                  if (!Number.isFinite(durH)) return;
                  onUpdateProfile({ targetWakeTime: e.target.value, targetDurationHours: durH });
                }}
                className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme?.focusRing} cursor-pointer`}
              />
            </div>
          </div>

          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner space-y-2`}>
            <div className="flex justify-between text-xs font-bold">
              <span className="text-slate-200">目标睡眠时长</span>
              <span className={`${theme.accentText} font-mono text-sm`}>{userProfile.targetDurationHours} 小时</span>
            </div>
            <input
              type="range"
              min={4}
              max={12}
              step={0.5}
              value={userProfile.targetDurationHours}
              onChange={(e) => {
                const h = Number(e.target.value);
                onUpdateProfile({
                  targetDurationHours: h,
                  targetWakeTime: toClock(toMin(userProfile.targetBedtime) + Math.round(h * 60)),
                });
              }}
              className="w-full cursor-pointer h-2 bg-slate-700 rounded-lg"
              style={{ accentColor: theme.accentHex }}
            />
          </div>

          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 space-y-1.5`}>
            <p className={`text-xs font-mono font-bold ${theme.accentText}`}>
              {userProfile.targetBedtime} 入睡 · {userProfile.targetDurationHours} 小时 · {userProfile.targetWakeTime} 醒来
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {(() => {
                const now = new Date();
                const nowMin = now.getHours() * 60 + now.getMinutes();
                let untilBed = toMin(userProfile.targetBedtime) - nowMin;
                if (untilBed < 0) untilBed += 1440;
                if (untilBed <= 90) {
                  return untilBed <= 15
                    ? `⏰ 距目标就寝仅剩约 ${untilBed} 分钟——该开始减速了`
                    : `🌙 距目标就寝约 ${Math.floor(untilBed / 60)}小时${untilBed % 60}分——适合现在启动睡前流程`;
                }
                return `🕐 距今晚目标就寝约 ${Math.floor(untilBed / 60)} 小时${untilBed % 60} 分`;
              })()}
            </p>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
