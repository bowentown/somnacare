import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TrendingUp,
  Activity,
  Layers,
  Clock,
  Sparkles,
  Calendar,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ShieldCheck,
  Award,
  Zap,
  Trash2,
  Info,
  CheckCircle2,
  Share2,
  Smartphone,
  Stethoscope,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SleepRecord } from '../types/sleep';
import { toLocalDateString } from '../utils/dateUtils';
import { regularityTier } from '../utils/sleepRegularity';
import { summarizeWeek } from '../utils/weekSummary';
import { ShareCardModal } from './ShareCardModal';
import { ClinicalSummaryModal } from './ClinicalSummaryModal';
import { nightsOnly, napsOnly } from '../utils/recordFilter';
import { computeWeekReport } from '../utils/weekReport';
import {
  usageHasPermission,
  usageOpenSettings,
  usagePrompted,
  clearUsageData,
  computeUsageRegularity,
  type UsageDay,
} from '../utils/usageSignal';
// 使用行为查询统一走共享 store：缓存/在途去重/过期都在那里管，
// 且查询结果回流给提议侧（此前这里直连 usageSignal，两套数据源不互通）
import { forceRefreshUsage, getCachedUsageDays } from '../utils/usageStore';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';
import { formatDurationChinese } from '../utils/sleepScore';
import { ThemeConfig } from '../utils/themeStyles';
import { hapticStep } from '../utils/haptics';
import { EmptyState, StatCard } from './ui';

interface TrendsTabProps {
  records: SleepRecord[];
  onDeleteRecord?: (id: string) => void;
  theme: ThemeConfig;
  /** 作息类型：使用信号按作息窗口采样，查询必须带上（否则拿夜窗数据当白窗用） */
  chronotype?: 'night' | 'day' | 'irregular';
  /** 目标作息窗（起卧图的参照带）；缺省时退回近 7 晚均值 */
  targetBedtime?: string;
  targetWakeTime?: string;
}

type MetricViewMode = 'quality' | 'stages' | 'circadian';

// 低饱和睡眠分期色：参考 Oura/Whoop 等成熟睡眠产品的克制配色，
// 不用荧光绿/电光蓝，避免“玩具感”；四色在深色底上保持可辨。
const STAGE_COLORS = {
  deep: '#3f9e8f',
  light: '#4f86d9',
  rem: '#8b7fd6',
  awake: '#d9955f',
} as const;

const STAGE_LABELS = {
  deep: '深睡',
  light: '浅睡',
  rem: 'REM',
  awake: '清醒',
} as const;

/** 历史记录窗口化（第 74 轮性能）：固定行高 64px、可视 320px（5 行），
 *  上下各 4 行 overscan——2000 条记录也只有 ~13 行 DOM 节点 */
const HISTORY_ROW_H = 64;
const HISTORY_VIEW_H = 320;
const HISTORY_OVERSCAN = 4;

export const TrendsTab: React.FC<TrendsTabProps> = ({
  records,
  onDeleteRecord,
  theme,
  chronotype = 'night',
  targetBedtime,
  targetWakeTime,
}) => {
  const innerBg = theme?.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme?.cardInnerBorder || 'border-slate-700/80';
  const accentText = theme?.accentText || 'text-indigo-400';
  const textMuted = theme?.textMuted || 'text-slate-400';
  const textSecondary = theme?.textSecondary || 'text-slate-300';
  const accentBg = theme.accentBg;
  const accentFg = theme?.accentFg || 'text-white';
  // 默认视图 = 起卧时段（Phase 1 数据诚实重构）：主视图只放真实测量的
  // 数据只含用户真实记录的起卧时间；估算分期降为次要 tab
  const [viewMode, setViewMode] = useState<MetricViewMode>('circadian');
  const [hoveredRecord, setHoveredRecord] = useState<SleepRecord | null>(null);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showClinical, setShowClinical] = useState(false);
  // ── 手机使用对照（P3）：native-only，权限/数据/引导标记 ──
  const [usagePerm, setUsagePerm] = useState<'checking' | 'granted' | 'denied'>('checking');
  const [usageDays, setUsageDays] = useState<UsageDay[]>(() => getCachedUsageDays());
  const [usagePromptedOnce, setUsagePromptedOnce] = useState(() => usagePrompted());
  // 手机使用对照折叠：持久化——收过的人不必每次展开整块
  const [usageOpen, setUsageOpen] = useState(() => localStorage.getItem('somnacare_usage_card_open') !== '0');
  const toggleUsageOpen = () => {
    setUsageOpen((v) => {
      try { localStorage.setItem('somnacare_usage_card_open', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };

  useEffect(() => {
    if (!isNativePlatform()) return;
    void (async () => {
      const granted = await usageHasPermission();
      setUsagePerm(granted ? 'granted' : 'denied');
      if (granted) setUsageDays(await forceRefreshUsage(7, chronotype));
    })();
  }, [chronotype]);
  const [historyScrollTop, setHistoryScrollTop] = useState(0);


  // 历史列表可视窗口：只渲染滚动位置附近的行
  const historyWindow = (() => {
    const visible = Math.ceil(HISTORY_VIEW_H / HISTORY_ROW_H) + HISTORY_OVERSCAN * 2;
    const start = Math.max(0, Math.floor(historyScrollTop / HISTORY_ROW_H) - HISTORY_OVERSCAN);
    const end = Math.min(records.length, start + visible);
    return { start, end };
  })();

  // Use up to last 7 days sorted chronologically
  const last7Records = nightsOnly(records).slice(0, 7).reverse();
  const activeRecord = hoveredRecord || last7Records[last7Records.length - 1];

  // ── 评分趋势：交给 Recharts（MIT）处理坐标轴/平滑曲线/Tooltip ──
  // 参考 shadcn/ui Charts 与 Tremor 的图表语法：轴在绘图区外、网格低对比、
  // 参考区间用底色、交互用十字线 + 浮层，而不是把数字堆在曲线里。
  const avgScore = last7Records.length
    ? Math.round(last7Records.reduce((sum, r) => sum + r.sleepScore, 0) / last7Records.length)
    : null;
  const scoreData = (() => {
    if (last7Records.length === 0) return [];
    const byDate = new Map(last7Records.map((r) => [r.date, r]));
    const end = new Date(`${last7Records[last7Records.length - 1].date}T00:00:00`);
    // 从最早一条记录铺到最晚一条：与分期/起卧的 7 条记录口径一致，
    // 中间缺记录的日期保留为空点，曲线断开。
    let start = new Date(`${last7Records[0].date}T00:00:00`);
    const rawSpan = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
    const span = Math.min(30, rawSpan);
    if (rawSpan > 30) {
      start = new Date(end);
      start.setDate(end.getDate() - span);
    }
    const out: Array<{ date: string; label: string; score: number | null; record: SleepRecord | null }> = [];
    for (let i = 0; i <= span; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const date = toLocalDateString(day);
      const record = byDate.get(date) ?? null;
      out.push({ date, label: date.slice(5), score: record ? record.sleepScore : null, record });
    }
    return out;
  })();
  const scoreHapticRef = useRef<string | null>(null);
  const scoreScrubRef = useRef(false);
  const selectScoreAt = (record: SleepRecord | null | undefined): void => {
    if (!record) return;
    if (scoreHapticRef.current !== record.id) {
      scoreHapticRef.current = record.id;
      hapticStep();
    }
    setHoveredRecord(record);
  };
  const onScoreHover = (state: any): void => {
    // Recharts 3 的 onMouseMove 只给 activeTooltipIndex/activeLabel，
    // 不再给 activePayload（v2 的写法会静默拿不到数据）。
    const rawIndex = state?.activeTooltipIndex;
    const index = typeof rawIndex === 'string' ? Number(rawIndex) : rawIndex;
    selectScoreAt(Number.isInteger(index) ? scoreData[index]?.record : null);
  };
  // 自己按指针位置取最近点：不依赖 Recharts 的 rAF 节流，
  // 在 Playwright 假时钟/低帧率 WebView 下也能稳定更新顶部读数。
  const pickScoreAt = (clientX: number, el: HTMLElement): void => {
    if (scoreData.length === 0) return;
    const rect = el.getBoundingClientRect();
    const plotLeft = 30;   // YAxis width
    const plotRight = 6;   // AreaChart right margin
    const usable = Math.max(1, rect.width - plotLeft - plotRight);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - plotLeft) / usable));
    const index = Math.round(ratio * (scoreData.length - 1));
    selectScoreAt(scoreData[index]?.record);
  };

  const ScoreTooltip = (props: any) => {
    const record = props?.payload?.[0]?.payload?.record as SleepRecord | undefined;
    if (!props?.active || !record) return null;
    return (
      <div className="rounded-xl border border-slate-600/80 bg-slate-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
        <p className="text-[10px] text-slate-300 font-mono tabular-nums">
          {record.date.slice(5)} <span className="text-white font-bold">{record.sleepScore} 分</span>
        </p>
        <p className="text-[9px] text-slate-400 font-mono">{formatDurationChinese(record.durationMinutes)}</p>
      </div>
    );
  };

  // 周报卡已删除（与近期小结重复）；连胜仍保留为小结里的一行
  const weekReport = computeWeekReport(records);

  // 分期横带：分母必须是卧床总长（纯睡眠 + 清醒），否则四段和会超过 100%
  const stageRows = last7Records.map((record) => {
    const total = Math.max(1, record.durationMinutes + record.awakeMinutes);
    return {
      record,
      total,
      deep: (record.deepSleepMinutes / total) * 100,
      light: (record.lightSleepMinutes / total) * 100,
      rem: (record.remSleepMinutes / total) * 100,
      awake: (record.awakeMinutes / total) * 100,
    };
  });
  const stageAvg = stageRows.length
    ? (() => {
        const count = stageRows.length;
        const deep = Math.round(stageRows.reduce((sum, row) => sum + row.deep, 0) / count);
        const light = Math.round(stageRows.reduce((sum, row) => sum + row.light, 0) / count);
        const rem = Math.round(stageRows.reduce((sum, row) => sum + row.rem, 0) / count);
        return { deep, light, rem, awake: Math.max(0, 100 - deep - light - rem) };
      })()
    : null;
  const activeStage = stageRows.find((row) => row.record.id === activeRecord?.id)
    ?? stageRows[stageRows.length - 1]
    ?? null;

  // ── 分期比例：Recharts 100% 堆叠横条（数据 = 百分比，浮层给分钟） ──
  const stageData = stageRows.map((row) => ({
    record: row.record,
    label: row.record.date.slice(5),
    deep: row.deep,
    light: row.light,
    rem: row.rem,
    awake: row.awake,
  }));
  const StageTooltip = (props: any) => {
    const row = props?.payload?.[0]?.payload;
    if (!props?.active || !row?.record) return null;
    const r = row.record as SleepRecord;
    const total = Math.max(1, r.durationMinutes + r.awakeMinutes);
    const items = [
      { key: 'deep', label: '深睡', minutes: r.deepSleepMinutes },
      { key: 'light', label: '浅睡', minutes: r.lightSleepMinutes },
      { key: 'rem', label: 'REM', minutes: r.remSleepMinutes },
      { key: 'awake', label: '清醒', minutes: r.awakeMinutes },
    ] as const;
    return (
      <div className="rounded-xl border border-slate-600/80 bg-slate-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
        <p className="text-[10px] text-white font-bold font-mono mb-1">{row.label}</p>
        {items.map((it) => (
          <p key={it.key} className="text-[9px] text-slate-300 font-mono flex items-center gap-1.5 tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STAGE_COLORS[it.key] }} />
            {it.label} {it.minutes}m · {Math.round((it.minutes / total) * 100)}%
          </p>
        ))}
      </div>
    );
  };
  const stageScrubRef = useRef(false);
  const stageHapticRef = useRef<string | null>(null);
  // 按指针 Y 坐标取行：不依赖 Recharts 的 rAF 事件（假时钟/低帧率 WebView 下稳定）
  const pickStageAt = (clientY: number, el: HTMLElement): void => {
    if (stageData.length === 0) return;
    const rect = el.getBoundingClientRect();
    const plotTop = 6;
    const plotBottom = 20; // X 轴刻度区
    const band = Math.max(1, (rect.height - plotTop - plotBottom) / stageData.length);
    const index = Math.max(0, Math.min(stageData.length - 1, Math.floor((clientY - rect.top - plotTop) / band)));
    const record = stageData[index]?.record;
    if (!record) return;
    if (stageHapticRef.current !== record.id) {
      stageHapticRef.current = record.id;
      hapticStep();
    }
    setHoveredRecord(record);
  };

  // 起卧图统一时间窗：21:00 → 次日 10:00
  const RANGE_START = 21 * 60;
  const RANGE_MINUTES = 13 * 60;
  const clockToMinutes = (time: string): number => {
    const [hour, minute] = time.split(':').map(Number);
    return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
  };
  const toRangeMinutes = (time: string): number => {
    const minutes = clockToMinutes(time);
    return minutes < RANGE_START ? minutes + 24 * 60 : minutes;
  };
  const sleepRows = last7Records.map((record) => {
    const start = toRangeMinutes(record.bedtime);
    let end = toRangeMinutes(record.wakeTime);
    if (end <= start) end += 24 * 60;
    return { record, start, end };
  });
  const avgStart = sleepRows.length
    ? Math.round(sleepRows.reduce((sum, row) => sum + row.start, 0) / sleepRows.length)
    : null;
  const avgEnd = sleepRows.length
    ? Math.round(sleepRows.reduce((sum, row) => sum + row.end, 0) / sleepRows.length)
    : null;
  const targetStart = targetBedtime ? toRangeMinutes(targetBedtime) : avgStart;
  let targetEnd = targetWakeTime ? toRangeMinutes(targetWakeTime) : avgEnd;
  if (targetStart !== null && targetEnd !== null && targetEnd <= targetStart) targetEnd += 24 * 60;
  const targetLabel = targetBedtime && targetWakeTime
    ? `目标 ${targetBedtime}–${targetWakeTime}`
    : '近 7 晚均值窗口';
  const rangePct = (minutes: number): number =>
    Math.max(0, Math.min(100, ((minutes - RANGE_START) / RANGE_MINUTES) * 100));
  const activeSleep = sleepRows.find((row) => row.record.id === activeRecord?.id)
    ?? sleepRows[sleepRows.length - 1]
    ?? null;
  // 分钟 → HH:MM（跨午夜取模，均值线/均值文案共用）
  const fmtClock = (minutes: number): string => {
    const norm = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
  };
  // 偏离目标判定（第 69 轮）：就寝比目标晚/早 ≥45 分钟的晚上，整条哑铃
  // （线 + 入睡点）染成琥珀色——比画须线干净，一眼能数出"有几天没睡在窗口里"
  const DEV_THRESHOLD = 45;
  const isOffTarget = (start: number): boolean =>
    targetStart !== null && Math.abs(start - targetStart) >= DEV_THRESHOLD;
  const offTargetCount = sleepRows.filter((row) => isOffTarget(row.start)).length;
  const avgBedDev = targetStart !== null && sleepRows.length
    ? Math.round(sleepRows.reduce((sum, row) => sum + Math.abs(row.start - targetStart), 0) / sleepRows.length)
    : null;


  return (
    <div className={`space-y-3 pb-28 ${theme.textPrimary}`}>
      {/* Visual Trends Container */}
      <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} space-y-3`}>
        {/* Toggle Switch */}
        <div className={`flex items-center justify-between gap-2 pb-2 border-b ${innerBorder}`}>
          <span className="text-xs font-bold text-white shrink-0">趋势与结构</span>

          <div className={`flex ${innerBg} p-0.5 rounded-xl border ${innerBorder} text-[10px]`}>
            <button
              type="button"
              onClick={() => setViewMode('quality')}
              className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
                viewMode === 'quality'
                  ? accentBg + ' ' + accentFg + ' shadow'
                  : `${textMuted} hover:text-white`
              }`}
            >
              得分曲线
            </button>
            <button
              type="button"
              onClick={() => setViewMode('circadian')}
              className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
                viewMode === 'circadian'
                  ? accentBg + ' ' + accentFg + ' shadow'
                  : `${textMuted} hover:text-white`
              }`}
            >
              起卧时段
            </button>
            <button
              type="button"
              onClick={() => setViewMode('stages')}
              aria-label="睡眠分期比例（模型估算，非测量）"
              className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
                viewMode === 'stages'
                  ? accentBg + ' ' + accentFg + ' shadow'
                  : `${textMuted} hover:text-white`
              }`}
            >
              分期估算
            </button>
          </div>
        </div>

        {/* 空态（第 51 轮审计）：无任何夜睡记录时三种视图都只剩参考线空壳，
            视觉如坏图——统一以空态文案替代三视图 */}
        {nightsOnly(records).length === 0 && (
          <EmptyState
            theme={theme}
            illustration="no-data"
            title="暂无睡眠数据"
            hint="记录第一晚后这里就会出现曲线"
            className="animate-tab-fade-in"
          />
        )}
        {nightsOnly(records).length > 0 && (<>
        {/* View Mode 1: Quality Score Trend */}
        {viewMode === 'quality' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div data-no-swipe className={`relative ${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2`}>
              {/* 顶部：当前点 + 7 晚均值 */}
              <div className="flex items-center justify-between gap-3 text-[10px] font-mono shrink-0 leading-none">
                <span data-testid="score-detail" className="text-slate-400 truncate">
                  {activeRecord ? (
                    <>
                      <span className="text-slate-300">{activeRecord.date.slice(5)}</span>
                      <span className="mx-1 text-slate-600">·</span>
                      <span className="text-white font-bold tabular-nums">{activeRecord.sleepScore} 分</span>
                      <span className="mx-1 text-slate-600">·</span>
                      {formatDurationChinese(activeRecord.durationMinutes)}
                    </>
                  ) : null}
                </span>
                {avgScore !== null && (
                  <span className="text-slate-400 shrink-0">
                    均值 <span className="text-white font-bold tabular-nums">{avgScore}</span>
                  </span>
                )}
              </div>

              {/* Recharts：坐标轴在绘图区外，曲线用 monotone，Tooltip/十字线自带 */}
              <div
                data-testid="score-chart"
                role="group"
                aria-label="近 7 晚睡眠评分趋势图，可点按或拖动查看每一晚"
                className="w-full"
                style={{ height: 150, touchAction: 'pan-y' }}
                onPointerDown={(e) => {
                  // 不能在这里 setState：Recharts 会因重渲染替换 SVG 节点，
                  // 事件目标随即脱离文档，父级翻页层再查 closest('[data-no-swipe]')
                  // 会得到 false，把图表拖拽误判成翻页。
                  scoreScrubRef.current = true;
                  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' || scoreScrubRef.current) {
                    pickScoreAt(e.clientX, e.currentTarget);
                  }
                }}
                onPointerUp={(e) => {
                  pickScoreAt(e.clientX, e.currentTarget);
                  scoreScrubRef.current = false;
                  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
                }}
                onPointerCancel={() => { scoreScrubRef.current = false; }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={scoreData}
                    margin={{ top: 8, right: 6, left: 0, bottom: 0 }}
                    onMouseMove={onScoreHover}
                    onClick={onScoreHover}
                  >
                    <defs>
                      <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={theme.accentHex} stopOpacity={0.24} />
                        <stop offset="100%" stopColor={theme.accentHex} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <ReferenceArea y1={75} y2={100} fill={theme.accentHex} fillOpacity={0.05} />
                    <XAxis
                      dataKey="label"
                      axisLine={false}
                      tickLine={false}
                      tickMargin={7}
                      minTickGap={12}
                      interval="preserveStartEnd"
                      tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }}
                    />
                    <YAxis
                      domain={[50, 100]}
                      ticks={[50, 75, 90, 100]}
                      width={30}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={4}
                      allowDecimals={false}
                      tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 10 }}
                    />
                    <ReferenceLine y={90} stroke="#5ee9b5" strokeDasharray="5 3" strokeWidth={1} />
                    <ReferenceLine y={75} stroke="#ffa1ad" strokeDasharray="2 3" strokeWidth={1} />
                    <Tooltip
                      content={<ScoreTooltip />}
                      cursor={{ stroke: 'rgba(255,255,255,0.28)', strokeDasharray: '3 3' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="score"
                      stroke={theme.accentHex}
                      strokeWidth={2.5}
                      fill="url(#scoreGrad)"
                      connectNulls={false}
                      isAnimationActive={false}
                      dot={{ r: 2.2, fill: theme.accentHex, stroke: 'none' }}
                      activeDot={{ r: 4, fill: '#ffffff', stroke: theme.accentHex, strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className={`flex items-center justify-between text-[9px] ${textMuted} leading-none`}>
                <span className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-4 h-[2px] rounded-full bg-emerald-300" />90 达标
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-4 h-[2px] rounded-full bg-rose-300" />75 警戒
                  </span>
                </span>
                <span className="text-slate-500">拖动或点按查看</span>
              </div>
            </div>
          </div>
        )}

        {/* View Mode 2: Sleep Stages — Recharts 100% 堆叠横条（shadcn/ui Charts 语法）：
            轴在绘图区外、网格低对比、悬浮浮层给精确分钟；不再手绘色带。 */}
        {viewMode === 'stages' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2.5`}>
              <div className="flex items-start justify-between gap-2 text-[10px]">
                <span className="text-slate-300 font-mono min-w-0 leading-tight">
                  {activeStage ? (
                    <>
                      <span className="text-slate-400">{activeStage.record.date.slice(5)}</span>
                      <span className="block text-[9px] text-slate-400 tabular-nums">
                        深 {activeStage.record.deepSleepMinutes}m · 浅 {activeStage.record.lightSleepMinutes}m
                      </span>
                      <span className="block text-[9px] text-slate-400 tabular-nums">
                        REM {activeStage.record.remSleepMinutes}m · 醒 {activeStage.record.awakeMinutes}m
                      </span>
                    </>
                  ) : '点按任一晚查看明细'}
                </span>
              </div>

              <div
                data-testid="stage-chart"
                role="group"
                aria-label="近 7 晚睡眠分期比例图，可点按或拖动查看每一晚"
                className="w-full"
                style={{ height: 196, touchAction: 'pan-y' }}
                onPointerDown={(e) => {
                  // 与得分图同因：pointerdown 里 setState 会让 Recharts 重建 SVG，
                  // 事件目标脱离文档，父级翻页层把图表拖拽误判成横向翻页
                  stageScrubRef.current = true;
                  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' || stageScrubRef.current) {
                    pickStageAt(e.clientY, e.currentTarget);
                  }
                }}
                onPointerUp={(e) => {
                  pickStageAt(e.clientY, e.currentTarget);
                  stageScrubRef.current = false;
                  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
                }}
                onPointerCancel={() => { stageScrubRef.current = false; }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stageData} layout="vertical" margin={{ top: 4, right: 6, left: 0, bottom: 0 }} barCategoryGap="32%">
                    <CartesianGrid horizontal={false} stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={6}
                      tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={34}
                      interval={0}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={4}
                      tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 10 }}
                    />
                    <Tooltip content={<StageTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                    <Bar dataKey="deep" stackId="stage" fill={STAGE_COLORS.deep} isAnimationActive={false} />
                    <Bar dataKey="light" stackId="stage" fill={STAGE_COLORS.light} isAnimationActive={false} />
                    <Bar dataKey="rem" stackId="stage" fill={STAGE_COLORS.rem} isAnimationActive={false} />
                    <Bar dataKey="awake" stackId="stage" fill={STAGE_COLORS.awake} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t ${innerBorder} text-[9px] ${textMuted}`}>
                {stageAvg && ([
                  ['deep', '深睡'],
                  ['light', '浅睡'],
                  ['rem', 'REM'],
                  ['awake', '清醒'],
                ] as const).map(([key, label]) => (
                  <span key={key} className="flex items-center gap-1 tabular-nums">
                    <span className="w-2 h-2 rounded-sm" style={{ background: STAGE_COLORS[key] }} />
                    {label} {stageAvg[key]}%
                  </span>
                ))}
                <span className="ml-auto text-slate-500">近 7 晚平均</span>
              </div>
            </div>
          </div>
        )}

        {/* View Mode 3: Circadian — 哑铃图（dumbbell plot，参考 Observable Plot/ECharts 的语法）：
            入睡点 → 醒来点细线相连；偏离目标 ≥45 分的晚上整条染琥珀。
            和"分期比例"的满宽色带在视觉语法上完全区分：
            这张图回答"作息准不准"，不是"睡了多久"。 */}
        {viewMode === 'circadian' && (() => {
          // 轴刻度按真实百分比绝对定位：justify-between 会把 09:00 顶到轨道
          // 右缘（100%），而它的真实位置是 92.3%——轴错位是"看着别扭"的来源
          const axisTicks = ([
            { h: 21, label: '21:00', show: true },
            // 00:00 与 21:00 只差 23% 轨道宽，标签会重叠——留网格线不给刻度
            { h: 3, label: '03:00', show: true },
            { h: 6, label: '06:00', show: true },
            { h: 9, label: '09:00', show: true },
          ] as const).map((t) => ({
            ...t,
            pct: rangePct(t.h === 21 ? 21 * 60 : (t.h + 24) * 60),
          }));
          return (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2`}>
              {/* 时间轴只对齐中间轨道，刻度按真实位置绝对定位 */}
              <div className={`flex items-end gap-2 pb-1 border-b ${innerBorder}`}>
                <span className="w-9 shrink-0" />
                <div className={`relative flex-1 h-4 text-[10px] ${textMuted} font-mono`}>
                  {axisTicks.map((t) => (
                    <span
                      key={t.label}
                      className={`absolute top-0 ${t.show ? '' : 'hidden min-[360px]:inline'}`}
                      style={{
                        left: `${t.pct}%`,
                        transform: t.h === 21 ? 'none' : 'translateX(-50%)',
                      }}
                    >
                      {t.label}
                    </span>
                  ))}
                </div>
                <span className="w-[74px] shrink-0" />
              </div>

              <div className="flex items-center justify-between gap-2 text-[9px]">
                <span className="flex items-center gap-1.5 text-slate-400 min-w-0 truncate">
                  <span
                    className="w-4 h-2 rounded-full border shrink-0"
                    style={{ background: `${theme.accentHex}16`, borderColor: `${theme.accentHex}55` }}
                  />
                  {targetLabel}
                </span>
                <span className="text-slate-500 shrink-0 font-mono tabular-nums">
                  {activeSleep
                    ? `${activeSleep.record.date.slice(5)} ${activeSleep.record.bedtime}→${activeSleep.record.wakeTime}`
                    : '点按任一行查看'}
                </span>
              </div>

              <div className="relative">
                {/* 目标窗纯填充（无边框）+ 竖网格：竖线越少越干净，均值只留页脚文案 */}
                <div className="absolute inset-y-0 z-0 pointer-events-none" style={{ left: 44, right: 82 }}>
                  {[0, 3, 6, 9].map((hour) => (
                    <div
                      key={`grid-${hour}`}
                      className="absolute inset-y-0 w-px"
                      style={{ left: `${rangePct((hour + 24) * 60)}%`, background: 'rgba(255,255,255,0.05)' }}
                    />
                  ))}
                  {targetStart !== null && targetEnd !== null && (
                    <div
                      className="absolute inset-y-0 rounded-xl"
                      style={{
                        left: `${rangePct(targetStart)}%`,
                        width: `${Math.max(0, rangePct(targetEnd) - rangePct(targetStart))}%`,
                        background: `${theme.accentHex}14`,
                      }}
                    />
                  )}
                </div>

                <div className="relative z-10 space-y-1">
                  {sleepRows.map(({ record, start, end }) => {
                    const isHovered = activeRecord?.id === record.id;
                    const offTarget = isOffTarget(start);
                    const left = rangePct(start);
                    const right = rangePct(end);
                    const dotLeft = Math.min(99, Math.max(1, left));
                    const dotRight = Math.min(99, Math.max(1, right));
                    const bedDev = targetStart !== null ? start - targetStart : null;
                    const wakeDev = targetEnd !== null ? end - targetEnd : null;
                    // 偏离目标的晚上：整条哑铃染琥珀（线 + 入睡点）
                    const bedColor = offTarget ? '#fbbf24' : theme.accentHex;
                    return (
                      <button
                        key={record.id}
                        type="button"
                        onClick={() => { hapticStep(); setHoveredRecord(record); }}
                        aria-label={`${record.date} 就寝 ${record.bedtime}，醒来 ${record.wakeTime}${offTarget ? '，偏离目标' : ''}`}
                        title={`就寝 ${record.bedtime}${bedDev !== null ? `（比目标${bedDev >= 0 ? '晚' : '早'} ${Math.abs(Math.round(bedDev / 5) * 5)} 分）` : ''}，醒来 ${record.wakeTime}${wakeDev !== null ? `（比目标${wakeDev >= 0 ? '晚' : '早'} ${Math.abs(Math.round(wakeDev / 5) * 5)} 分）` : ''}`}
                        className="w-full flex items-center gap-2 text-left cursor-pointer group min-h-8"
                      >
                        <span className={`w-9 text-[10px] font-mono shrink-0 tabular-nums ${
                          isHovered ? accentText + ' font-bold' : textMuted
                        }`}>
                          {record.date.slice(5)}
                        </span>

                        {/* 哑铃轨道：整数几何居中（calc 定位）——此前 7px 点配
                            -translate-y-1/2 产生 ±3.5px 的半像素偏移，部分设备
                            取整后点与线肉眼可见地不在同一高度 */}
                        <span className="flex-1 h-6 relative">
                          <span
                            className="absolute h-[2px] rounded-full pointer-events-none"
                            style={{
                              top: 'calc(50% - 1px)',
                              left: `${left}%`,
                              width: `${Math.max(0, right - left)}%`,
                              background: offTarget
                                ? `rgba(251,191,36,${isHovered ? '0.95' : '0.7'})`
                                : `${theme.accentHex}${isHovered ? 'cc' : '80'}`,
                            }}
                          />
                          <span
                            className="absolute w-2 h-2 rounded-full pointer-events-none"
                            style={{
                              top: 'calc(50% - 4px)',
                              left: `calc(${dotLeft}% - 4px)`,
                              background: bedColor,
                              boxShadow: isHovered ? `0 0 0 3px ${bedColor}33` : '0 0 0 2px rgba(2,6,23,0.9)',
                            }}
                          />
                          <span
                            className="absolute w-2 h-2 rounded-full pointer-events-none"
                            style={{
                              top: 'calc(50% - 4px)',
                              left: `calc(${dotRight}% - 4px)`,
                              background: '#f1f5f9',
                              boxShadow: isHovered ? '0 0 0 3px rgba(241,245,249,0.25)' : '0 0 0 2px rgba(2,6,23,0.9)',
                            }}
                          />
                        </span>

                        <span className={`w-[74px] text-right text-[9px] font-mono shrink-0 tabular-nums ${
                          isHovered ? accentText + ' font-bold' : textMuted
                        }`}>
                          {record.bedtime}→{record.wakeTime}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t ${innerBorder} text-[9px] ${textMuted}`}>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: theme.accentHex }} />
                  入睡
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-slate-100" />
                  醒来
                </span>
                {offTargetCount > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    偏离目标≥45分 ×{offTargetCount}
                  </span>
                )}
                <span className="ml-auto font-mono tabular-nums">
                  {avgStart !== null && avgEnd !== null && `均值 ${fmtClock(avgStart)}→${fmtClock(avgEnd)}`}
                  {avgBedDev !== null && ` · 目标偏差±${avgBedDev}分`}
                </span>
              </div>

            </div>
          </div>
          );
        })()}
        </>)}
      </div>

      {/* 3. Collapsible Historical Records List with Delete Capability */}
      <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder}`}>
        <button
          type="button"
          onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
          className="w-full flex items-center justify-between text-left cursor-pointer group py-2 -my-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white">历史记录</span>
            <span className={`text-[10px] ${textMuted} font-mono ${innerBg} px-2 py-0.5 rounded-full border ${innerBorder}`}>
              {nightsOnly(records).length} 夜 · {napsOnly(records).length} 次小睡
            </span>
          </div>

          <div className={`flex items-center gap-1 text-xs ${accentText} font-medium`}>
            <span>{isHistoryExpanded ? '收起' : '展开'}</span>
            {isHistoryExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </button>

        {/* Collapsible Content */}
        {isHistoryExpanded && (
          <div className="mt-3 pt-3 border-t border-slate-700/60 text-xs animate-tab-fade-in">
            {records.length === 0 ? (
              <EmptyState theme={theme} illustration="no-data" title="暂无数据记录" compact />
            ) : (
              // 窗口化渲染（第 74 轮性能）：固定行高 + 滚动窗口，DOM 恒定为
              // 可视行数 + 上下各 4 行 overscan——2000 条记录也只有 ~13 行节点，
              // 不再是「加载更多」堆到 2 万节点
              <div
                data-testid="history-list"
                className="overflow-y-auto no-scrollbar"
                style={{ height: HISTORY_VIEW_H }}
                onScroll={(e) => setHistoryScrollTop(e.currentTarget.scrollTop)}
              >
                <div className="relative" style={{ height: records.length * HISTORY_ROW_H }}>
                  {records
                    .slice(historyWindow.start, historyWindow.end)
                    .map((r, i) => {
                      const index = historyWindow.start + i;
                      return (
                        <div
                          key={r.id}
                          style={{ top: index * HISTORY_ROW_H, height: HISTORY_ROW_H }}
                          className="absolute left-0 right-0 flex items-center justify-between hover:bg-slate-800/30 px-2 rounded-xl transition-colors group"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-white text-xs">{r.date}</span>
                              {r.kind === 'nap' && <span className="text-[8px] font-black text-sky-300 bg-[#082f49]/80 px-1 py-0.5 rounded">😴 小睡</span>}
                              <span className={`font-mono ${accentText} font-bold text-xs`}>{r.sleepScore}分</span>
                            </div>
                            <div className={`text-[11px] ${textMuted} flex items-center gap-2 mt-0.5 font-mono`}>
                              <span>{r.bedtime} - {r.wakeTime}</span>
                              <span>·</span>
                              <span>{formatDurationChinese(r.durationMinutes)}</span>
                              <span>·</span>
                              <span className="text-emerald-400">深睡 {r.deepSleepMinutes}m</span>
                            </div>
                          </div>

                          {/* Delete Button */}
                          {onDeleteRecord && (
                            <button
                              type="button"
                              aria-label={`删除 ${r.date} ${r.bedtime} 的睡眠记录`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`确认删除 ${r.date} 的睡眠记录？`)) {
                                  onDeleteRecord(r.id);
                                }
                              }}
                              title="删除此条记录"
                              className={`p-2 ${textMuted} hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
            {records.length > historyWindow.end && (
              <p className={`text-center text-[10px] ${textMuted} pt-2`}>
                向下滚动查看更多（共 {records.length} 条）
              </p>
            )}
          </div>
        )}
      </div>

      {/* 近期睡眠小结：填充留白 + 可读洞察（滚动窗 = 最近 7 晚，标题不叫"本周"） */}
      {records.length > 0 && (() => {
        // 周小结只聚合夜睡（第 21 轮 #3：混入午睡会少报时长）；聚合唯一实现
        // summarizeWeek（第 22 轮：页面上曾有一份平行聚合，全小睡输入时
        // best=undefined 白屏）。第 24 轮：不再平行推导 nightsOnly，
        // 也不用 ! 断言（全小睡时三个均值确实是 null——用空值收窄消费）
        const sum = summarizeWeek(records);
        const recentNights = nightsOnly(records).slice(0, 7);
        const avgEfficiency = recentNights.length
          ? Math.round(recentNights.reduce((a, r) => a + r.sleepEfficiency, 0) / recentNights.length)
          : null;
        return (
          <div
            role="button"
            tabIndex={0}
            aria-label="展开近期睡眠小结详情"
            onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsHistoryExpanded(true); } }}
            onClick={() => setIsHistoryExpanded(true)}
            className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4 cursor-pointer hover:border-white/20 active:scale-[0.99] transition-all`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
              <h3 className="text-sm font-bold text-white">近期睡眠小结</h3>
              <span className={`text-[10px] ${textMuted} font-mono`}>近 {sum.nights} 晚</span>
              {/* 分享卡入口 + 就诊摘要（第 56 轮）：生成前都可预览 */}
              <div className="ml-auto mr-1 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowClinical(true); }}
                  aria-label="生成就诊摘要"
                  className="flex items-center justify-center gap-1 px-3 py-2.5 min-h-11 rounded-full bg-slate-800/80 border border-slate-600 text-slate-200 text-[10px] font-bold cursor-pointer active:scale-95 transition-transform"
                >
                  <Stethoscope className="w-3.5 h-3.5" />
                  <span>就诊摘要</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowShare(true); }}
                  aria-label="生成每周睡眠分享卡"
                  className={`flex items-center justify-center gap-1 px-3 py-2.5 min-h-11 rounded-full ${theme.accentBg} ${theme.accentFg} text-[10px] font-bold cursor-pointer active:scale-95 transition-transform`}
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>分享</span>
                </button>
              </div>
            </div>
            {sum.avgScore === null || sum.avgDurationMin === null || avgEfficiency === null ? (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                还没有夜睡记录——白天的午睡不计入周小结。
              </p>
            ) : (
            <div className="grid grid-cols-3 gap-2.5">
              <StatCard theme={theme} label="平均评分" value={sum.avgScore} />
              <StatCard
                theme={theme}
                label="日均时长"
                valueClassName="text-white"
                value={<>
                  {Math.floor(sum.avgDurationMin / 60)}<span className="text-sm">H</span>
                  {sum.avgDurationMin % 60}<span className="text-sm">M</span>
                </>}
              />
              <StatCard
                theme={theme}
                label="平均效率"
                valueClassName="text-emerald-400"
                value={<>{avgEfficiency}<span className="text-sm">%</span></>}
              />
            </div>
            )}
            {sum.regularity ? (
              <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 space-y-1.5`}>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-200">作息规律度</span>
                  <span className={`font-mono font-black text-lg ${
                    sum.regularity.score >= 80 ? 'text-emerald-400' : sum.regularity.score >= 50 ? 'text-amber-400' : 'text-rose-400'
                  }`}>{sum.regularity.score}</span>
                </div>
                <p className={`text-[10px] ${textMuted} leading-relaxed`}>
                  就寝 ±{sum.regularity.bedDev} 分钟 · 起床 ±{sum.regularity.wakeDev} 分钟 ·{' '}
                  {regularityTier(sum.regularity.score) === 'steady' ? '作息很稳' : regularityTier(sum.regularity.score) === 'ok' ? '基本规律' : '作息波动大'}
                </p>
              </div>
            ) : (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                📊 记录满 3 晚后，这里会显示作息规律度（就寝与起床的稳定程度）
              </p>
            )}
            {weekReport.streak > 0 && (
              <p className={`text-[11px] font-bold ${theme.accentText}`}>
                🔥 连续达标 {weekReport.streak} 晚{weekReport.graceUsed ? '（今晚续上）' : ''}
              </p>
            )}
            {sum.best && (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                最佳 <span className="text-white font-bold">{sum.best.date}</span> · {sum.best.sleepScore} 分
              </p>
            )}
            {sum.napCount > 0 && (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                😴 近期小睡 {sum.napCount} 次，共 {Math.floor(sum.napMinutes / 60)} 小时 {sum.napMinutes % 60} 分（不计入规律度）
              </p>
            )}
          </div>
        );
      })()}

      {/* 手机使用对照（P3）：native-only。对照而非替代——"手机显示"永远
          不说"入睡"；权限是特殊授权，拒绝后不反复弹引导（一次性标记） */}
      {isNativePlatform() && (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={toggleUsageOpen}
              aria-expanded={usageOpen}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Smartphone className={`w-4 h-4 ${theme.accentText}`} />
              <h3 className="text-sm font-bold text-white">手机使用对照</h3>
              <ChevronDown className={`w-4 h-4 ${textMuted} transition-transform ${usageOpen ? 'rotate-180' : ''}`} />
            </button>
            {usagePerm === 'granted' && usageOpen && (
              <button
                type="button"
                onClick={() => {
                    if (!window.confirm('清除本机缓存的手机使用对照数据？系统使用记录不受影响，可重新查询。')) return;
                    clearUsageData(); setUsageDays([]);
                  }}
                className={`text-[10px] ${textMuted} hover:text-slate-300 underline cursor-pointer py-1.5 -my-1.5`}
              >
                清除手机使用数据
              </button>
            )}
          </div>

          {usageOpen && usagePerm === 'checking' && (
            <p className={`text-[11px] ${textMuted}`}>检查使用情况访问权限…</p>
          )}

          {usageOpen && usagePerm === 'denied' && (
            usagePromptedOnce ? (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                使用情况访问未开启。
                <button
                  type="button"
                  onClick={() => void usageOpenSettings()}
                  className="underline cursor-pointer hover:text-white py-1.5 -my-1.5"
                >
                  点此前往系统设置
                </button>
                ，开启后她会知道你几点真正放下手机——数据只留在手机上。
              </p>
            ) : (
              <div className="space-y-2.5">
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  开启"使用情况访问"，她会知道你昨晚几点真正放下手机、早上几点拿起——
                  和你的记录并排对照，数据只留在手机上。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setUsagePromptedOnce(true);
                    void usageOpenSettings().then(async () => {
                      const granted = await usageHasPermission();
                      setUsagePerm(granted ? 'granted' : 'denied');
                      if (granted) setUsageDays(await forceRefreshUsage(7, chronotype));
                    });
                  }}
                  className={`w-full py-2.5 rounded-xl ${theme.accentText} border ${theme.accentBorder} text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform`}
                  style={{ background: `${theme.accentHex}1a` }}
                >
                  前往系统设置开启
                </button>
              </div>
            )
          )}

          {usageOpen && usagePerm === 'granted' && (() => {
            const uReg = computeUsageRegularity(usageDays);
            const shown = usageDays.filter((d) => d.lastActive).slice(0, 7);
            return (
              <div className="space-y-2">
                {uReg && (
                  <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3 flex items-center justify-between`}>
                    <span className="text-[11px] font-bold text-slate-200">手机使用规律度</span>
                    <span className={`font-mono font-black ${
                      uReg.score >= 80 ? 'text-emerald-400' : uReg.score >= 50 ? 'text-amber-400' : 'text-rose-400'
                    }`}>{uReg.score}</span>
                  </div>
                )}
                {shown.length === 0 ? (
                  <p className={`text-[11px] ${textMuted}`}>还没有可用的使用数据，明天再来看看。</p>
                ) : shown.map((d) => (
                  <div key={d.date} className={`${innerBg} border ${innerBorder} rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-[11px]`}>
                    {/* 夜归属日期（MM-DD）：7 行连续夜的数据没有日期就无法区分是哪晚 */}
                    <span className={`${textMuted} font-mono shrink-0 tabular-nums`}>{d.date.slice(5)}</span>
                    <span className="text-slate-300 font-mono">
                      {d.lastActive || '--:--'} 放下 → {d.firstActive || '--:--'} 拿起
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {createPortal(
        <ShareCardModal open={showShare} onClose={() => setShowShare(false)} records={records} theme={theme} />,
        document.body,
      )}
      {createPortal(
        <ClinicalSummaryModal open={showClinical} onClose={() => setShowClinical(false)} records={records} theme={theme} />,
        document.body,
      )}
    </div>
  );
};
