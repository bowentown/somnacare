import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Moon,
  Plus,
  Play,
  ArrowRight,
} from 'lucide-react';
import { SleepRecord, UserProfile } from '../types/sleep';
import { formatDurationChinese } from '../utils/sleepScore';
import { OneTapSleepTracker } from './OneTapSleepTracker';
import { nightsOnly, napsOnly } from '../utils/recordFilter';
import { toLocalDateString } from '../utils/dateUtils';
import { SoundscapePlayer } from './SoundscapePlayer';
import { Music2 } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { requestAlarmPermissions } from '../utils/nativeAlarmScheduler';
import { PondCard } from './PondCard';

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
}) => {
  // 首页主卡只显示夜睡（小睡另有紧凑行）——旧数据无 kind 视为夜睡
  const latestRecord = nightsOnly(records)[0] || null;
  const todayNaps = napsOnly(records).filter((r) => r.date === toLocalDateString());
  const [goalOpen, setGoalOpen] = useState(false);
  // 睡前提醒的悬浮窗授权态：null=未检查。此前开关只翻布尔、不申请任何权限，
  // 提醒的投递路径（悬浮窗 > 通知兜底）在 Android 13+ 上会静默全部失效
  const [bedtimePerm, setBedtimePerm] = useState<boolean | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);

  // 得分环 + 数字 count-up（进入页面时 0 → 目标值，800ms 缓出）
  const [displayScore, setDisplayScore] = useState(0);
  useEffect(() => {
    if (!latestRecord) return;
    const target = Math.min(99, Math.max(25, latestRecord.sleepScore));
    const start = performance.now();
    const dur = 800;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [latestRecord?.sleepScore, latestRecord?.id]);

  const getScoreColor = (score: number) => {
    if (score >= 88) return { text: theme.accentText, stroke: theme.accentHex, label: '优' };
    if (score >= 78) return { text: 'text-emerald-400', stroke: '#34d399', label: '良' };
    if (score >= 68) return { text: 'text-amber-400', stroke: '#fbbf24', label: '平' };
    return { text: 'text-rose-400', stroke: '#f87171', label: '差' };
  };

  const scoreInfo = latestRecord ? getScoreColor(latestRecord.sleepScore) : getScoreColor(85);

  return (
    <div className={`space-y-4 pb-28 ${theme.textPrimary}`}>
      {/* 1. Primary One-Tap Sleep Tracker */}
      {onSaveRecord && <OneTapSleepTracker onSaveRecord={onSaveRecord} startSignal={startSignal} theme={theme} targetDurationHours={userProfile.targetDurationHours} records={records} userProfile={userProfile} onOpenManualLogPrefilled={onOpenManualLogPrefilled} onUpdateProfile={onUpdateProfile} />}

      {/* 活的海：程序化脊柱鱼横幅（水色=睡眠债 / 萤火=昨晚深睡 / 星点=已记录夜） */}
      <PondCard records={records} userProfile={userProfile} theme={theme} />

      {/* 当天小睡紧凑行（主卡只显示夜睡；小睡不顶掉主卡） */}
      {todayNaps.length > 0 && (
        <div className={`${theme.cardBg} rounded-2xl px-4 py-3 border ${theme.cardBorder} flex items-center gap-2 text-[11px]`}>
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

      {/* 2. Last Sleep Overview Card with Unified Theme Colors */}
      {latestRecord ? (
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

          <div className="flex items-center justify-between gap-5 my-1">
            {/* Score Ring */}
            <div className="relative w-20 h-20 shrink-0 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  stroke={scoreInfo.stroke}
                  strokeWidth="8"
                  strokeDasharray={`${(displayScore / 100) * 251.2} 251.2`}
                  strokeLinecap="round"
                  fill="none"
                  className="transition-all duration-700 ease-out"
                />
              </svg>
              <div className="absolute flex flex-col items-center justify-center">
                <span className="text-2xl font-black font-mono text-white tabular-nums leading-none">
                  {displayScore}
                </span>
                <span className={`text-[11px] font-black mt-1 ${scoreInfo.text}`}>
                  {scoreInfo.label}
                </span>
              </div>
            </div>

            {/* Metrics */}
            <div className="flex-1 space-y-2 text-xs">
              <div className="flex items-baseline justify-between">
                <span className="text-slate-300 font-bold">总睡眠时长</span>
                <span className="font-black text-white font-mono text-sm">
                  {formatDurationChinese(latestRecord.durationMinutes)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-slate-300 font-bold">入睡 / 醒来</span>
                <span className="font-mono text-slate-100 font-bold">
                  {latestRecord.bedtime} - {latestRecord.wakeTime}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-slate-300 font-bold">深睡阶段</span>
                <span className="font-mono text-emerald-400 font-black">
                  {latestRecord.deepSleepMinutes}分 · {Math.round((latestRecord.deepSleepMinutes / Math.max(1, latestRecord.durationMinutes)) * 100)}%
                </span>
              </div>
              {userProfile.targetBedtime && (() => {
                // 白天主睡者 vs 夜间口径的默认目标（23:30）不在同一作息日历上：
                // 差 690 分钟既非"晚"也无行动意义，标红只会误导——诚实降级为提示，
                // 引导把就寝目标改成白天的目标时刻（设置后此处恢复真实对比）
                const nightCalibratedDefault =
                  userProfile.chronotype === 'day' && userProfile.targetBedtime === '23:30';
                if (nightCalibratedDefault) {
                  return (
                    <div className="flex items-baseline justify-between">
                      <span className="text-slate-300 font-bold">就寝 vs 目标</span>
                      <span className="font-mono font-bold text-xs text-slate-400">
                        目标仍为夜间口径 · 建议改设置
                      </span>
                    </div>
                  );
                }
                const [bh, bm] = latestRecord.bedtime.split(':').map(Number);
                const [th, tm] = userProfile.targetBedtime.split(':').map(Number);
                let diff = bh * 60 + bm - (th * 60 + tm);
                if (diff > 720) diff -= 1440;
                if (diff < -720) diff += 1440;
                const txt = diff === 0 ? '与目标一致' : diff > 0 ? `晚于目标 ${diff} 分钟` : `早于目标 ${-diff} 分钟`;
                return (
                  <div className="flex items-baseline justify-between">
                    <span className="text-slate-300 font-bold">就寝 vs 目标</span>
                    <span className={`font-mono font-bold text-sm ${diff > 30 ? 'text-rose-400' : diff < -30 ? 'text-sky-400' : 'text-emerald-400'}`}>
                      {txt}
                    </span>
                  </div>
                );
              })()}
              <div className="pt-1 text-[10px] text-slate-400">
                模型估算 · 非医疗诊断
              </div>
              {(() => {
                const t = latestRecord.durationMinutes + latestRecord.awakeMinutes || 1;
                const p = {
                  deep: Math.round((latestRecord.deepSleepMinutes / t) * 100),
                  light: Math.round((latestRecord.lightSleepMinutes / t) * 100),
                  rem: Math.round((latestRecord.remSleepMinutes / t) * 100),
                };
                const awakeP = Math.max(0, 100 - p.deep - p.light - p.rem);
                return (
                  <div className="pt-1.5 space-y-1.5">
                    <div className="flex h-2.5 rounded-full overflow-hidden gap-px">
                      <div style={{ width: `${p.deep}%` }} className="bg-emerald-400" />
                      <div style={{ width: `${p.light}%` }} className="bg-sky-400" />
                      <div style={{ width: `${p.rem}%` }} className="bg-violet-400" />
                      <div style={{ width: `${awakeP}%` }} className="bg-rose-400/70" />
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                      <span className="text-emerald-400">深 {p.deep}%</span>
                      <span className="text-sky-400">浅 {p.light}%</span>
                      <span className="text-violet-400">REM {p.rem}%</span>
                      <span className="text-rose-400/80">醒 {awakeP}%</span>
                    </div>
                  </div>
                );
              })()}
              {latestRecord.sleepScore < 75 && (
                <div className="pt-1 text-[11px] text-amber-300/90 font-medium">
                  💡 提示：睡眠评分自然波动属正常现象，身体今夜会自动通过增加深睡代偿，无需担忧。
                </div>
              )}
            </div>
          </div>

          {latestRecord.dreamNotes && (
            <div className="mt-3 pt-3 border-t border-slate-700/80 text-xs text-slate-200">
              <span className={`${theme.accentText} font-bold`}>梦境记录：</span>{latestRecord.dreamNotes}
            </div>
          )}
        </div>
      ) : (
        <div className={`rounded-3xl p-6 ${theme.cardBg} border ${theme.cardBorder} text-center space-y-2 shadow-lg`}>
          <div className={`w-12 h-12 rounded-2xl ${theme.cardInnerBg} border ${theme.cardBorder} flex items-center justify-center mx-auto shadow-inner`}>
            <Moon className={`w-6 h-6 ${theme.accentText}`} />
          </div>
          <h4 className="text-sm font-bold text-white pt-1">暂无睡眠记录</h4>
          <p className={`text-xs ${theme.textMuted}`}>点击上方开始就寝，或通过下方快速补录真实作息</p>
        </div>
      )}

      {/* 4. Action Cards for Manual Log & Bedside Monitor */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <button
          type="button"
          onClick={onOpenManualLog}
          className={`p-4 rounded-2xl ${theme.cardBg} border ${theme.cardBorder} hover:border-slate-500 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-md`}
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
          className={`p-4 rounded-2xl ${theme.cardBg} border ${theme.cardBorder} hover:border-slate-500 text-left transition-all active:scale-[0.98] group cursor-pointer shadow-md`}
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
      <button
        type="button"
        onClick={() => setMixerOpen(true)}
        className={`w-full p-4 rounded-2xl ${theme.cardBg} border ${theme.cardBorder} flex items-center justify-between cursor-pointer hover:border-white/20 transition-all active:scale-[0.99] shadow-md group`}
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

      {/* 5. 作息目标（默认折叠；编辑器内详尽） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
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
            <span className="text-[10px] text-slate-400">到点弹出提醒动画，早点睡</span>
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
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
                  userProfile.bedtimeReminderEnabled ? 'left-[22px]' : 'left-0.5'
                }`}
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
                onChange={(e) =>
                  onUpdateProfile({
                    targetBedtime: e.target.value,
                    targetWakeTime: toClock(toMin(e.target.value) + Math.round(userProfile.targetDurationHours * 60)),
                  })
                }
                className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme?.focusRing} cursor-pointer`}
              />
            </div>
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <span className="text-xs font-bold text-slate-200 block mb-1">目标醒来</span>
              <input
                type="time"
                value={userProfile.targetWakeTime}
                onChange={(e) => {
                  const durH = Math.min(12, Math.max(4, Math.round(((toMin(e.target.value) - toMin(userProfile.targetBedtime) + 1440) % 1440) / 30) * 0.5));
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
            <p className="text-[11px] text-slate-400 leading-relaxed">
              此目标将用于：睡眠评分基准、报告偏差分析与 AI 建议。
            </p>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
