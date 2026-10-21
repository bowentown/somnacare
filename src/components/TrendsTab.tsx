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
import { SleepRecord } from '../types/sleep';
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

const STAGE_COLORS = {
  deep: '#00d492',
  light: '#00bcff',
  rem: '#a684ff',
  awake: '#ff637e',
} as const;

const STAGE_LABELS = {
  deep: '深睡',
  light: '浅睡',
  rem: 'REM',
  awake: '清醒',
} as const;

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
  const [viewMode, setViewMode] = useState<MetricViewMode>('quality');
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
  const [historyLimit, setHistoryLimit] = useState(50);


  // Use up to last 7 days sorted chronologically
  const last7Records = nightsOnly(records).slice(0, 7).reverse();
  const activeRecord = hoveredRecord || last7Records[last7Records.length - 1];

  // ── 得分曲线的唯一坐标映射 ──
  // 数据点、折线、参考线【全部】走这一个函数，避免各写一份后漂移。
  const CHART_W = 280;
  const CHART_H = 80;
  const PLOT_LEFT = 24;
  const PLOT_RIGHT = 250;
  const PLOT_W = PLOT_RIGHT - PLOT_LEFT;
  const SCORE_MIN = 50;
  const SCORE_MAX = 100;
  const CHART_GRID = 'rgba(255,255,255,0.08)';
  const CHART_AXIS_TEXT = 'rgba(255,255,255,0.52)';
  const scoreToY = (rawScore: number) => {
    const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, rawScore));
    return CHART_H - ((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * (CHART_H - 20) - 10;
  };
  // 单条记录时居中，避免点贴在左边缘
  const scoreToX = (i: number) =>
    last7Records.length <= 1
      ? PLOT_LEFT + PLOT_W / 2
      : PLOT_LEFT + i * (PLOT_W / (last7Records.length - 1));

  const dayGap = (a: string, b: string): number => {
    const ta = new Date(`${a}T00:00:00`).getTime();
    const tb = new Date(`${b}T00:00:00`).getTime();
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 1;
    return Math.round(Math.abs(tb - ta) / 86400000);
  };
  // 缺记录的日期不连线：连续日期成段，缺口处断开（不制造“天天都睡了”的假象）
  const scoreSegments: SleepRecord[][] = [];
  for (const r of last7Records) {
    const current = scoreSegments[scoreSegments.length - 1];
    if (current && dayGap(current[current.length - 1].date, r.date) > 1) {
      scoreSegments.push([r]);
    } else if (current) {
      current.push(r);
    } else {
      scoreSegments.push([r]);
    }
  }
  const avgScore = last7Records.length
    ? Math.round(last7Records.reduce((sum, r) => sum + r.sleepScore, 0) / last7Records.length)
    : null;
  const scorePoint = (r: SleepRecord): string => {
    const index = last7Records.findIndex((item) => item.id === r.id);
    return `${scoreToX(index)},${scoreToY(r.sleepScore)}`;
  };

  // 拖拽 scrub（第 57 轮）：按住曲线横向滑动，十字线跟随、跨点轻触。
  // 图表区标 data-no-swipe——否则横向手势会被五分区翻页层接管
  const svgRef = useRef<SVGSVGElement>(null);
  const scrubbingRef = useRef(false);
  const scrubIdRef = useRef<string | null>(null);
  const scrubAt = (clientX: number): void => {
    const el = svgRef.current;
    if (!el || last7Records.length === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = last7Records.length <= 1 ? 0 : Math.round(ratio * (last7Records.length - 1));
    const rec = last7Records[idx];
    if (!rec) return;
    if (scrubIdRef.current !== rec.id) {
      scrubIdRef.current = rec.id;
      hapticStep();
    }
    setHoveredRecord(rec);
  };
  const onChartPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    scrubbingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scrubAt(e.clientX);
  };
  const onChartPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.pointerType === 'mouse' || scrubbingRef.current) scrubAt(e.clientX);
  };
  const onChartPointerEnd = (e: React.PointerEvent<SVGSVGElement>): void => {
    scrubbingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const activeIndex = activeRecord ? last7Records.findIndex((r) => r.id === activeRecord.id) : -1;

  // ── 参考线的唯一定义 ──
  // 线本身与右上角图例【都读这份数组】，所以图例不可能与线不一致。
  // 颜色：项目 @theme 已把 emerald-300/rose-300 覆盖为字面 hex
  //       （#5ee9b5 / #ffa1ad），因此不会引入 oklch，旧 WebView 安全。
  //       选 300 档而非 400 档：400 档红线在暖琥珀/晴蓝主题的最坏对比度只有
  //       3.0:1（零余量）；而 emerald-400 + rose-300 的灰度差仅 0.006，
  //       红绿色盲无法区分。emerald-300 + rose-300 两项都满足（见下）。
  // 对比度（非文字图形门槛 ≥3:1；图例文字 AA 小字 ≥4.5:1）。
  // ⚠️ 参考线【必须完全不透明】：折线下方有 scoreGrad 渐变填充，
  //    会把局部底色从 #0c1222 提亮到约 rgb(53,61,109)。
  //    半透明红线压在该填充上只有 ≈2.6:1 —— 达不到 3:1（四套主题实测过）。
  //    不透明 + 300 档后，最坏情况（四套主题 × 相邻底色/裸底色取最小）：
  //    绿 9.64:1，红 4.54:1（门槛 3:1），灰度差 0.142（色盲可辨）。
  // 线型：两者都是虚线（用户要求），但【节奏不同】，红绿色盲可凭线型配对图例。
  const REF_LINES = [
    { score: 90, dash: '5 3',  tone: 'text-emerald-300', label: '90 达标' },
    { score: 75, dash: '2 3',  tone: 'text-rose-300',    label: '75 警戒' },
  ] as const;

  // 周报卡已删除（与近期小结重复）；连胜仍保留为小结里的一行
  const weekReport = computeWeekReport(records);

  const shortMinutes = (minutes: number): string =>
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
      : `${minutes}m`;

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
              onClick={() => setViewMode('stages')}
              className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
                viewMode === 'stages'
                  ? accentBg + ' ' + accentFg + ' shadow'
                  : `${textMuted} hover:text-white`
              }`}
            >
              分期比例
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
          </div>
        </div>

        {/* 空态（第 51 轮审计）：无任何夜睡记录时三种视图都只剩参考线空壳，
            视觉如坏图——统一以空态文案替代三视图 */}
        {nightsOnly(records).length === 0 && (
          <div className="relative h-40 rounded-2xl border border-dashed border-slate-600 bg-black/20 flex flex-col items-center justify-center gap-1.5 animate-tab-fade-in">
            <span className="text-sm font-black text-slate-300">暂无睡眠数据</span>
            <span className="text-[10px] text-slate-500 leading-relaxed text-center px-6">
              记录第一晚后这里就会出现曲线
            </span>
          </div>
        )}
        {nightsOnly(records).length > 0 && (<>
        {/* View Mode 1: Quality Score Trend */}
        {viewMode === 'quality' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div data-no-swipe className={`relative ${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-1.5`}>
              {/* 顶部：当前点 + 7 晚均值（比图内叠字更稳） */}
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

              <svg
                ref={svgRef}
                data-testid="score-chart"
                className="w-full h-24 overflow-visible"
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                role="group"
                aria-label="近 7 晚睡眠评分趋势图，可左右拖动查看每一晚"
                style={{ touchAction: 'pan-y' }}
                onPointerDown={onChartPointerDown}
                onPointerMove={onChartPointerMove}
                onPointerUp={onChartPointerEnd}
                onPointerCancel={onChartPointerEnd}
              >
                <defs>
                  <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.accentHex} stopOpacity="0.30" />
                    <stop offset="100%" stopColor={theme.accentHex} stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* 75–100 目标带：先给“好区间”一个底色，再读曲线 */}
                <rect
                  x={PLOT_LEFT}
                  y={scoreToY(100)}
                  width={PLOT_W}
                  height={scoreToY(75) - scoreToY(100)}
                  fill={theme.accentHex}
                  opacity="0.06"
                  rx="2"
                />

                {/* Y 轴刻度 + 网格：50 / 75 / 90 / 100 */}
                {[100, 90, 75, 50].map((value) => (
                  <g key={`grid-${value}`}>
                    <line
                      x1={PLOT_LEFT} y1={scoreToY(value)}
                      x2={PLOT_RIGHT} y2={scoreToY(value)}
                      stroke={CHART_GRID}
                      strokeWidth="0.75"
                    />
                    <text
                      x={PLOT_LEFT - 4}
                      y={scoreToY(value) + 2.5}
                      textAnchor="end"
                      fontSize="9"
                      fill={CHART_AXIS_TEXT}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                      pointerEvents="none"
                    >
                      {value}
                    </text>
                  </g>
                ))}

                {/* 参考线：与数据点共用 scoreToY；右端直接标 90/75 */}
                {REF_LINES.map((l) => (
                  <g key={l.score}>
                    <line
                      x1={PLOT_LEFT} y1={scoreToY(l.score)}
                      x2={PLOT_RIGHT} y2={scoreToY(l.score)}
                      stroke="currentColor"
                      strokeWidth="1"
                      strokeDasharray={l.dash}
                      className={l.tone}
                    />
                    <text
                      x={PLOT_RIGHT + 4}
                      y={scoreToY(l.score) + 2.5}
                      fontSize="9"
                      fill="currentColor"
                      className={l.tone}
                      pointerEvents="none"
                    >
                      {l.score}
                    </text>
                  </g>
                ))}

                {/* 拖拽十字线：只在用户真的拖动/悬停时出现 */}
                {hoveredRecord && activeIndex >= 0 && (
                  <line
                    x1={scoreToX(activeIndex)} y1={scoreToY(100)} x2={scoreToX(activeIndex)} y2={CHART_H}
                    stroke="rgba(255,255,255,0.40)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                )}

                {/* 缺记录处断开：连续日期才画面积/折线 */}
                {scoreSegments.map((segment, index) => {
                  if (segment.length < 2) return null;
                  const start = last7Records.findIndex((r) => r.id === segment[0].id);
                  const end = last7Records.findIndex((r) => r.id === segment[segment.length - 1].id);
                  const points = segment.map(scorePoint).join(' ');
                  return (
                    <g key={`segment-${index}`}>
                      <polygon
                        points={`${scoreToX(start)},${CHART_H} ${points} ${scoreToX(end)},${CHART_H}`}
                        fill="url(#scoreGrad)"
                      />
                      <polyline
                        fill="none"
                        stroke={theme.accentHex}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={points}
                      />
                    </g>
                  );
                })}

                {last7Records.map((r, i) => {
                  const x = scoreToX(i);
                  const y = scoreToY(r.sleepScore);
                  const isHovered = activeRecord?.id === r.id;

                  return (
                    <g
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看 ${r.date} 的睡眠详情`}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHoveredRecord(r); } }}
                      onFocus={() => setHoveredRecord(r)}
                      className="cursor-pointer focus:outline-none"
                      style={{ outline: 'none' }}
                      onClick={() => setHoveredRecord(r)}
                    >
                      {/* 隐形命中区：r=4 的点直径只有 8px，手指根本点不中 */}
                      <circle cx={x} cy={y} r={16} fill="transparent" pointerEvents="all" />
                      {isHovered && (
                        <circle cx={x} cy={y} r={8} fill="none" stroke={theme.accentHex} strokeOpacity="0.35" strokeWidth="1.5" />
                      )}
                      <circle
                        cx={x}
                        cy={y}
                        r={isHovered ? 4.5 : 3.5}
                        fill={isHovered ? '#ffffff' : theme.accentHex}
                        stroke={theme.accentHex}
                        strokeWidth="2"
                      />
                      <text
                        x={x}
                        y={CHART_H - 1}
                        textAnchor="middle"
                        fontSize="9"
                        fill={isHovered ? theme.accentHex : CHART_AXIS_TEXT}
                        fontWeight={isHovered ? 700 : 400}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        pointerEvents="none"
                      >
                        {r.date.slice(5)}
                      </text>
                    </g>
                  );
                })}
              </svg>

              <div className={`flex items-center justify-between text-[9px] ${textMuted} leading-none`}>
                <span>
                  虚线 <span className="text-emerald-300">90 达标</span>
                  <span className="mx-1 text-slate-600">·</span>
                  <span className="text-rose-300">75 警戒</span>
                </span>
                <span className="text-slate-500">点按曲线查看</span>
              </div>
            </div>
          </div>
        )}

        {/* View Mode 2: Sleep Stages（100% 横带，逐晚一行） */}
        {viewMode === 'stages' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2.5`}>
              <div className="flex items-start justify-between gap-2 text-[10px]">
                <span className="text-slate-300 font-mono min-w-0 leading-tight">
                  {activeStage ? (
                    <>
                      <span className="text-slate-400">{activeStage.record.date.slice(5)}</span>
                      <span className="block text-[9px] text-slate-400 tabular-nums">
                        深 {activeStage.record.deepSleepMinutes}m · 浅 {activeStage.record.lightSleepMinutes}m · REM {activeStage.record.remSleepMinutes}m · 醒 {activeStage.record.awakeMinutes}m
                      </span>
                    </>
                  ) : '点按任一晚查看明细'}
                </span>
              </div>

              <div className="space-y-1.5">
                {stageRows.map((row) => {
                  const isHovered = activeRecord?.id === row.record.id;
                  const segments = [
                    { key: 'deep', value: row.deep, minutes: row.record.deepSleepMinutes, label: '深睡' },
                    { key: 'light', value: row.light, minutes: row.record.lightSleepMinutes, label: '浅睡' },
                    { key: 'rem', value: row.rem, minutes: row.record.remSleepMinutes, label: 'REM' },
                    { key: 'awake', value: row.awake, minutes: row.record.awakeMinutes, label: '醒' },
                  ] as const;
                  return (
                    <button
                      key={row.record.id}
                      type="button"
                      onClick={() => setHoveredRecord(row.record)}
                      aria-label={`${row.record.date} 睡眠分期：深睡 ${row.record.deepSleepMinutes} 分钟，浅睡 ${row.record.lightSleepMinutes} 分钟，REM ${row.record.remSleepMinutes} 分钟，清醒 ${row.record.awakeMinutes} 分钟`}
                      className="w-full flex items-center gap-2 text-left cursor-pointer group min-h-9"
                    >
                      <span className={`w-9 text-[10px] font-mono shrink-0 tabular-nums ${
                        isHovered ? accentText + ' font-bold' : textMuted
                      }`}>
                        {row.record.date.slice(5)}
                      </span>
                      <span className={`flex-1 h-6 rounded-md overflow-hidden flex ${
                        isHovered ? `ring-1 ${theme.accentRing}` : ''
                      }`}>
                        {segments.map((segment) => {
                          const width = Math.max(0, segment.value);
                          const shortLabel = segment.key === 'rem' ? 'R' : segment.label.slice(0, 1);
                          const label = width >= 22
                            ? `${segment.label} ${Math.round(width)}`
                            : width >= 9
                              ? `${Math.round(width)}%`
                              : width >= 5
                                ? shortLabel
                                : '';
                          return (
                            <span
                              key={segment.key}
                              title={`${segment.label} ${shortMinutes(segment.minutes)}（${Math.round(width)}%）`}
                              style={{ width: `${width}%`, background: STAGE_COLORS[segment.key] }}
                              className="h-full flex items-center justify-center overflow-hidden whitespace-nowrap text-[8px] font-black text-[#06121f] tabular-nums"
                            >
                              {label}
                            </span>
                          );
                        })}
                      </span>
                      <span className={`w-11 text-right text-[10px] font-mono shrink-0 tabular-nums ${
                        isHovered ? accentText + ' font-bold' : textMuted
                      }`}>
                        {shortMinutes(row.record.durationMinutes)}
                      </span>
                    </button>
                  );
                })}
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

        {/* View Mode 3: Circadian（哑铃/区间图） */}
        {viewMode === 'circadian' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2`}>
              <div className={`flex justify-between text-[10px] ${textMuted} font-mono pb-1 border-b ${innerBorder}`}>
                <span>21:00</span>
                <span>00:00</span>
                <span>03:00</span>
                <span>06:00</span>
                <span>09:00</span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[9px]">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span
                    className="w-3 h-2 rounded-sm border"
                    style={{ background: `${theme.accentHex}18`, borderColor: `${theme.accentHex}55` }}
                  />
                  {targetLabel}
                </span>
                <span className="text-slate-500">点按任一行查看</span>
              </div>

              <div className="space-y-1.5">
                {sleepRows.map(({ record, start, end }) => {
                  const isHovered = activeRecord?.id === record.id;
                  const left = rangePct(start);
                  const right = rangePct(end);
                  const width = Math.max(1.5, right - left);
                  const dotLeft = Math.min(99, Math.max(1, left));
                  const dotRight = Math.min(99, Math.max(1, right));
                  return (
                    <button
                      key={record.id}
                      type="button"
                      onClick={() => setHoveredRecord(record)}
                      aria-label={`${record.date} 就寝 ${record.bedtime}，醒来 ${record.wakeTime}`}
                      className="w-full flex items-center gap-2 text-left cursor-pointer group min-h-9"
                    >
                      <span className={`w-9 text-[10px] font-mono shrink-0 tabular-nums ${
                        isHovered ? accentText + ' font-bold' : textMuted
                      }`}>
                        {record.date.slice(5)}
                      </span>

                      <span className={`flex-1 h-6 rounded-md relative overflow-hidden border ${innerBorder} ${
                        isHovered ? `ring-1 ${theme.accentRing}` : ''
                      }`} style={{ background: 'rgba(2,6,23,0.55)' }}>
                        {/* 目标/均值窗口 */}
                        {targetStart !== null && targetEnd !== null && (
                          <span
                            className="absolute inset-y-0 pointer-events-none"
                            style={{
                              left: `${rangePct(targetStart)}%`,
                              width: `${Math.max(0, rangePct(targetEnd) - rangePct(targetStart))}%`,
                              background: `${theme.accentHex}14`,
                              borderLeft: `1px dashed ${theme.accentHex}55`,
                              borderRight: `1px dashed ${theme.accentHex}55`,
                            }}
                          />
                        )}
                        {/* 时间网格 */}
                        {[0, 3, 6, 9].map((hour) => (
                          <span
                            key={`grid-${hour}`}
                            className="absolute inset-y-0 w-px pointer-events-none"
                            style={{
                              left: `${rangePct((hour + 24) * 60)}%`,
                              background: 'rgba(255,255,255,0.07)',
                            }}
                          />
                        ))}
                        {/* 起卧连接线 + 两个端点 */}
                        <span
                          className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded-full pointer-events-none"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            background: `${theme.accentHex}${isHovered ? 'dd' : '99'}`,
                          }}
                        />
                        <span
                          className="absolute top-1/2 w-[7px] h-[7px] rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                          style={{
                            left: `${dotLeft}%`,
                            background: theme.accentHex,
                            boxShadow: `0 0 0 2px rgba(2,6,23,0.9)`,
                          }}
                        />
                        <span
                          className="absolute top-1/2 w-[7px] h-[7px] rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                          style={{
                            left: `${dotRight}%`,
                            background: '#ffffff',
                            border: `2px solid ${theme.accentHex}`,
                            boxShadow: `0 0 0 2px rgba(2,6,23,0.9)`,
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
          </div>
        )}
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
          <div className="mt-3 pt-3 border-t border-slate-700/60 divide-y divide-slate-800 text-xs animate-tab-fade-in">
            {records.length === 0 ? (
              <div className={`py-4 text-center ${textMuted}`}>暂无数据记录</div>
            ) : (
              // 单帧渲染 2000 条 ≈ 2 万 DOM 节点会卡顿：分页展示
              records.slice(0, historyLimit).map((r) => (
                <div
                  key={r.id}
                  className="py-3 flex items-center justify-between hover:bg-slate-800/30 px-2 rounded-xl transition-colors group"
                >
                  <div className="flex-1">
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
              ))
            )}
            {records.length > historyLimit && (
              <button
                type="button"
                onClick={() => setHistoryLimit((v) => v + 50)}
                className={`w-full py-2 text-center text-[10px] font-bold ${textMuted} hover:text-white cursor-pointer`}
              >
                加载更多（已显示 {historyLimit} / {records.length} 条）
              </button>
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
              <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3`}>
                <span className={`text-[10px] ${textMuted} block mb-0.5`}>平均评分</span>
                <span className={`text-xl font-black font-mono ${theme.accentText} tabular-nums`}>{sum.avgScore}</span>
              </div>
              <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3`}>
                <span className={`text-[10px] ${textMuted} block mb-0.5`}>日均时长</span>
                <span className="text-xl font-black font-mono text-white tabular-nums">
                  {Math.floor(sum.avgDurationMin / 60)}<span className="text-sm">H</span>
                  {sum.avgDurationMin % 60}<span className="text-sm">M</span>
                </span>
              </div>
              <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3`}>
                <span className={`text-[10px] ${textMuted} block mb-0.5`}>平均效率</span>
                <span className="text-xl font-black font-mono text-emerald-400 tabular-nums">
                  {avgEfficiency}<span className="text-sm">%</span>
                </span>
              </div>
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
