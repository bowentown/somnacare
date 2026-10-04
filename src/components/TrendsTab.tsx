import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { SleepRecord } from '../types/sleep';
import { regularityTier } from '../utils/sleepRegularity';
import { summarizeWeek } from '../utils/weekSummary';
import { ShareCardModal } from './ShareCardModal';
import { nightsOnly, napsOnly } from '../utils/recordFilter';
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

interface TrendsTabProps {
  records: SleepRecord[];
  onDeleteRecord?: (id: string) => void;
  theme: ThemeConfig;
  /** 作息类型：使用信号按作息窗口采样，查询必须带上（否则拿夜窗数据当白窗用） */
  chronotype?: 'night' | 'day' | 'irregular';
}

type MetricViewMode = 'quality' | 'stages' | 'circadian';

export const TrendsTab: React.FC<TrendsTabProps> = ({ records, onDeleteRecord, theme, chronotype = 'night' }) => {
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
  const SCORE_MIN = 50;
  const SCORE_MAX = 100;
  const scoreToY = (rawScore: number) => {
    const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, rawScore));
    return CHART_H - ((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * (CHART_H - 20) - 10;
  };
  // 单条记录时居中，避免点贴在左边缘
  const scoreToX = (i: number) =>
    last7Records.length <= 1 ? CHART_W / 2 : i * (CHART_W / (last7Records.length - 1));

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

  // Helper for SVG smooth trend line points
  const getScoreCoordinates = () => {
    if (last7Records.length === 0) return '';
    return last7Records.map((r, i) => `${scoreToX(i)},${scoreToY(r.sleepScore)}`).join(' ');
  };

  return (
    <div className={`space-y-3 pb-28 ${theme.textPrimary}`}>
      {/* Visual Trends Container */}
      <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} space-y-3`}>
        {/* Toggle Switch */}
        <div className={`flex items-center justify-between pb-2 border-b ${innerBorder}`}>
          <span className="text-xs font-bold text-white">趋势与结构</span>

          <div className={`flex ${innerBg} p-1 rounded-xl border ${innerBorder} text-[11px]`}>
            <button
              type="button"
              onClick={() => setViewMode('quality')}
              className={`px-3 py-2 rounded-lg font-bold transition-all cursor-pointer ${
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
              className={`px-3 py-2 rounded-lg font-bold transition-all cursor-pointer ${
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
              className={`px-3 py-2 rounded-lg font-bold transition-all cursor-pointer ${
                viewMode === 'circadian'
                  ? accentBg + ' ' + accentFg + ' shadow'
                  : `${textMuted} hover:text-white`
              }`}
            >
              起卧时段
            </button>
          </div>
        </div>

        {/* View Mode 1: Quality Score Trend */}
        {viewMode === 'quality' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`relative h-40 ${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} flex flex-col justify-between`}>
              {/* ── 图例：与参考线读同一份 REF_LINES，色/线型都不可能不一致 ── */}
              <div className="flex items-center justify-end gap-3 text-[9px] font-mono shrink-0 leading-none">
                {REF_LINES.map((l) => (
                  <span key={l.score} className={`flex items-center gap-1 ${l.tone}`}>
                    <svg width="14" height="6" viewBox="0 0 14 6" aria-hidden="true" focusable="false">
                      <line
                        x1="0" y1="3" x2="14" y2="3"
                        stroke="currentColor" strokeWidth="1" strokeDasharray={l.dash}
                      />
                    </svg>
                    {l.label}
                  </span>
                ))}
              </div>

              <svg className="w-full h-24 overflow-visible" viewBox="0 0 280 80">
                <defs>
                  <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.accentHex} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={theme.accentHex} stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* ── 参考线：与数据点共用 scoreToY，绝不另写坐标 ── */}
                {REF_LINES.map((l) => (
                  <line
                    key={l.score}
                    x1="0" y1={scoreToY(l.score)} x2={CHART_W} y2={scoreToY(l.score)}
                    stroke="currentColor"
                    strokeWidth="1" strokeDasharray={l.dash}
                    className={l.tone}
                  />
                ))}

                {last7Records.length > 1 && (
                  <polygon
                    points={`0,80 ${getScoreCoordinates()} 280,80`}
                    fill="url(#scoreGrad)"
                  />
                )}

                <polyline
                  fill="none"
                  stroke={theme.accentHex}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={getScoreCoordinates()}
                />

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
                      className="cursor-pointer"
                      onClick={() => setHoveredRecord(r)}
                    >
                      {/* 隐形命中区：r=4 的点直径只有 8px，手指根本点不中 */}
                      <circle cx={x} cy={y} r={16} fill="transparent" pointerEvents="all" />
                      <circle
                        cx={x}
                        cy={y}
                        r={isHovered ? 5.5 : 4}
                        fill={isHovered ? '#ffffff' : theme.accentHex}
                        stroke={theme.accentHex}
                        strokeWidth="2"
                      />
                      {isHovered && (
                        <text
                          x={x}
                          y={y - 8}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="10"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {r.sleepScore}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              <div className={`flex ${last7Records.length === 1 ? 'justify-center' : 'justify-between'} text-[10px] ${textMuted} font-mono pt-1 border-t ${innerBorder}`}>
                {last7Records.map((r) => (
                  <span
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${r.date} 的睡眠详情`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHoveredRecord(r); } }}
                    onClick={() => setHoveredRecord(r)}
                    className={`cursor-pointer ${
                      activeRecord?.id === r.id ? accentText + ' font-bold' : 'hover:text-white'
                    }`}
                  >
                    {r.date.slice(5)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* View Mode 2: Sleep Stages */}
        {viewMode === 'stages' && (
          <div className="space-y-2 animate-tab-fade-in">
            <div className={`h-40 ${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} flex flex-col justify-between`}>
              <div className="flex items-end justify-between gap-2 h-28 px-1">
                {last7Records.map((r) => {
                  const total = Math.max(1, r.durationMinutes);
                  const deepPct = (r.deepSleepMinutes / total) * 100;
                  const remPct = (r.remSleepMinutes / total) * 100;
                  const lightPct = (r.lightSleepMinutes / total) * 100;
                  const awakePct = (r.awakeMinutes / total) * 100;
                  const isHovered = activeRecord?.id === r.id;

                  return (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看 ${r.date} 的睡眠详情`}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHoveredRecord(r); } }}
                      onClick={() => setHoveredRecord(r)}
                      className="flex-1 flex flex-col items-center h-full justify-end cursor-pointer group"
                    >
                      <div
                        className={`w-full max-w-[24px] h-20 rounded-md overflow-hidden flex flex-col-reverse ${
                          isHovered ? `ring-2 ${theme.accentRing} shadow` : ''
                        }`}
                      >
                        <div style={{ height: `${deepPct}%` }} className="bg-emerald-400" />
                        <div style={{ height: `${lightPct}%` }} className="bg-sky-400" />
                        <div style={{ height: `${remPct}%` }} className="bg-violet-400" />
                        <div style={{ height: `${awakePct}%` }} className="bg-rose-400" />
                      </div>

                      <span
                        className={`text-[9px] font-mono mt-1 ${
                          isHovered ? accentText + ' font-bold' : textMuted
                        }`}
                      >
                        {r.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className={`flex flex-col items-center gap-1 pt-1 border-t ${innerBorder} text-[10px] ${textSecondary}`}>
                <div className="flex justify-center gap-3">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" />深睡
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-sky-400" />浅睡
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-violet-400" />REM
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-rose-400" />清醒
                  </span>
                </div>
                <span className={`text-[9px] ${textMuted} font-sans`}>
                  * 分期为模型估算值，非临床检测
                </span>
              </div>
            </div>
          </div>
        )}

        {/* View Mode 3: Circadian Gantt */}
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

              {last7Records.map((r) => {
                const [bh, bm] = r.bedtime.split(':').map(Number);
                const [wh, wm] = r.wakeTime.split(':').map(Number);
                const startM = (bh < 12 ? bh + 24 : bh) * 60 + bm;
                const endM = (wh < 12 ? wh + 24 : wh) * 60 + wm;

                const rangeStart = 21 * 60;
                const totalRange = 13 * 60;
                const leftPercent = Math.max(0, Math.min(100, ((startM - rangeStart) / totalRange) * 100));
                const widthPercent = Math.max(6, Math.min(100 - leftPercent, ((endM - startM) / totalRange) * 100));

                const isHovered = activeRecord?.id === r.id;

                return (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${r.date} 的睡眠详情`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHoveredRecord(r); } }}
                    onClick={() => setHoveredRecord(r)}
                    className="flex items-center gap-2 cursor-pointer group"
                  >
                    <span
                      className={`w-9 text-[10px] font-mono shrink-0 ${
                        isHovered ? accentText + ' font-bold' : textMuted
                      }`}
                    >
                      {r.date.slice(5)}
                    </span>

                    <div className={`flex-1 h-5 bg-slate-950 rounded-lg relative overflow-hidden border ${innerBorder}`}>
                      <div
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                          backgroundColor: isHovered ? theme.accentHex : `${theme.accentHex}99`,
                        }}
                        className="absolute top-0.5 bottom-0.5 rounded flex items-center justify-between px-1.5"
                      >
                        <span className="text-[9px] font-mono text-white">{r.bedtime}</span>
                        <span className="text-[9px] font-mono text-white">{r.wakeTime}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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

      {/* 本周睡眠小结：填充留白 + 周维度可读洞察 */}
      {records.length > 0 && (() => {
        // 周小结只聚合夜睡（第 21 轮 #3：混入午睡会少报时长）；聚合唯一实现
        // summarizeWeek（第 22 轮：页面上曾有一份平行聚合，全小睡输入时
        // best=undefined 白屏）。第 24 轮：不再平行推导 nightsOnly，
        // 也不用 ! 断言（全小睡时三个均值确实是 null——用空值收窄消费）
        const sum = summarizeWeek(records);
        return (
          <div
            role="button"
            tabIndex={0}
            aria-label="展开本周睡眠小结详情"
            onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsHistoryExpanded(true); } }}
            onClick={() => setIsHistoryExpanded(true)}
            className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4 cursor-pointer hover:border-white/20 active:scale-[0.99] transition-all`}
          >
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
              <h3 className="text-sm font-bold text-white">本周睡眠小结</h3>
              <span className={`text-[10px] ${textMuted} font-mono`}>近 {sum.nights} 晚</span>
              {/* 分享卡入口：插画家+宠物语录+聚合数字，生成前可预览可勾选 */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowShare(true); }}
                aria-label="生成每周睡眠分享卡"
                className={`ml-auto mr-1 flex items-center gap-1 px-2.5 py-2.5 -my-2 rounded-full ${theme.accentBg} ${theme.accentFg} text-[10px] font-bold cursor-pointer active:scale-95 transition-transform`}
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>分享</span>
              </button>
            </div>
            {sum.avgScore === null || sum.avgDurationMin === null || sum.avgDeepMin === null ? (
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
                <span className={`text-[10px] ${textMuted} block mb-0.5`}>场均深睡</span>
                <span className="text-xl font-black font-mono text-emerald-400 tabular-nums">
                  {sum.avgDeepMin}<span className="text-sm">M</span>
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
                <p className={`text-[10px] ${textMuted} leading-relaxed`}>
                  按你的作息起止点计算，不是测量值
                </p>
              </div>
            ) : (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                📊 记录满 3 晚后，这里会显示作息规律度（就寝与起床的稳定程度）
              </p>
            )}
            {sum.best && (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                最佳 <span className="text-white font-bold">{sum.best.date}</span> · {sum.best.sleepScore} 分
              </p>
            )}
            {sum.napCount > 0 && (
              <p className={`text-[11px] ${textMuted} leading-relaxed`}>
                😴 本周小睡 {sum.napCount} 次，共 {Math.floor(sum.napMinutes / 60)} 小时 {sum.napMinutes % 60} 分（不计入规律度）
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
                onClick={() => { clearUsageData(); setUsageDays([]); }}
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
                <p className={`text-[10px] ${textMuted} leading-relaxed`}>
                  基于手机使用记录（屏幕亮灭），不是睡眠监测；"放下手机"不等于入睡。
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {createPortal(
        <ShareCardModal open={showShare} onClose={() => setShowShare(false)} records={records} theme={theme} />,
        document.body,
      )}
    </div>
  );
};
