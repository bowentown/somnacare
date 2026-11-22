import React, { useRef, useState } from 'react';
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
import type { SleepRecord } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { toLocalDateString } from '../../shared/utils/dateUtils';
import { nightsOnly } from '../sleep/utils/recordFilter';
import { formatDurationChinese } from '../sleep/utils/sleepScore';
import { hapticStep } from '../../shared/utils/haptics';
import { EmptyState } from '../../shared/ui';

type MetricViewMode = 'quality' | 'stages' | 'circadian';

const STAGE_COLORS = {
  deep: '#3f9e8f',
  light: '#4f86d9',
  rem: '#8b7fd6',
  awake: '#d9955f',
} as const;

const RANGE_START = 21 * 60;
const RANGE_MINUTES = 13 * 60;
const DEV_THRESHOLD = 45;

const clockToMinutes = (time: string): number => {
  const [hour, minute] = time.split(':').map(Number);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
};

const toRangeMinutes = (time: string): number => {
  const minutes = clockToMinutes(time);
  return minutes < RANGE_START ? minutes + 24 * 60 : minutes;
};

const fmtClock = (minutes: number): string => {
  const norm = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
};

const rangePct = (minutes: number): number =>
  Math.max(0, Math.min(100, ((minutes - RANGE_START) / RANGE_MINUTES) * 100));

interface TrendsChartsSectionProps {
  records: SleepRecord[];
  theme: ThemeConfig;
  focusDate: string | null;
  onFocusDate: (date: string) => void;
  targetBedtime?: string;
  targetWakeTime?: string;
}

export const TrendsChartsSection: React.FC<TrendsChartsSectionProps> = React.memo(function TrendsChartsSection({
  records,
  theme,
  focusDate,
  onFocusDate,
  targetBedtime,
  targetWakeTime,
}) {
  const innerBg = theme.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme.cardInnerBorder || 'border-slate-700/80';
  const accentText = theme.accentText || 'text-indigo-400';
  const textMuted = theme.textMuted || 'text-slate-400';
  const accentBg = theme.accentBg;
  const accentFg = theme.accentFg || 'text-white';

  const [viewMode, setViewMode] = useState<MetricViewMode>('circadian');

  const nights = nightsOnly(records);
  const last7Records = nights.slice(0, 7).reverse();
  const focusRecord = focusDate
    ? (records.find((r) => r.date === focusDate && r.kind !== 'nap') ?? records.find((r) => r.date === focusDate)) ??
      null
    : null;
  const activeRecord = focusRecord || last7Records[last7Records.length - 1];

  const avgScore = last7Records.length
    ? Math.round(last7Records.reduce((sum, r) => sum + r.sleepScore, 0) / last7Records.length)
    : null;

  const scoreData = (() => {
    if (last7Records.length === 0) return [];
    const byDate = new Map(last7Records.map((r) => [r.date, r]));
    const end = new Date(`${last7Records[last7Records.length - 1].date}T00:00:00`);
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
    onFocusDate(record.date);
  };
  const onScoreHover = (state: { activeTooltipIndex?: number | string | null } | null | undefined): void => {
    const rawIndex = state?.activeTooltipIndex;
    const index = typeof rawIndex === 'string' ? Number(rawIndex) : rawIndex;
    selectScoreAt(typeof index === 'number' && Number.isInteger(index) ? scoreData[index]?.record : null);
  };
  const pickScoreAt = (clientX: number, el: HTMLElement): void => {
    if (scoreData.length === 0) return;
    const rect = el.getBoundingClientRect();
    const usable = Math.max(1, rect.width - 30 - 6);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 30) / usable));
    const index = Math.round(ratio * (scoreData.length - 1));
    selectScoreAt(scoreData[index]?.record);
  };

  const ScoreTooltip = (props: { active?: boolean; payload?: Array<{ payload?: { record?: SleepRecord } }> }) => {
    const record = props?.payload?.[0]?.payload?.record;
    if (!props?.active || !record) return null;
    return (
      <div className="animate-tab-fade-in rounded-xl border border-slate-600/80 bg-slate-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
        <p className="text-[10px] text-slate-300 font-mono tabular-nums">
          {record.date.slice(5)} <span className="text-white font-bold">{record.sleepScore} 分</span>
        </p>
        <p className="text-[9px] text-slate-400 font-mono">{formatDurationChinese(record.durationMinutes)}</p>
      </div>
    );
  };

  // 分期横带
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
  const activeStage = stageRows.find((row) => row.record.id === activeRecord?.id) ?? stageRows[stageRows.length - 1] ?? null;

  const stageData = stageRows.map((row) => ({
    record: row.record,
    label: row.record.date.slice(5),
    deep: row.deep,
    light: row.light,
    rem: row.rem,
    awake: row.awake,
  }));

  const StageTooltip = (props: { active?: boolean; payload?: Array<{ payload?: { label: string; record?: SleepRecord } }> }) => {
    const row = props?.payload?.[0]?.payload;
    if (!props?.active || !row?.record) return null;
    const r = row.record;
    const total = Math.max(1, r.durationMinutes + r.awakeMinutes);
    const items = [
      { key: 'deep', label: '深睡', minutes: r.deepSleepMinutes },
      { key: 'light', label: '浅睡', minutes: r.lightSleepMinutes },
      { key: 'rem', label: 'REM', minutes: r.remSleepMinutes },
      { key: 'awake', label: '清醒', minutes: r.awakeMinutes },
    ] as const;
    return (
      <div className="animate-tab-fade-in rounded-xl border border-slate-600/80 bg-slate-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
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
  const pickStageAt = (clientY: number, el: HTMLElement): void => {
    if (stageData.length === 0) return;
    const rect = el.getBoundingClientRect();
    const band = Math.max(1, (rect.height - 6 - 20) / stageData.length);
    const index = Math.max(0, Math.min(stageData.length - 1, Math.floor((clientY - rect.top - 6) / band)));
    const record = stageData[index]?.record;
    if (!record) return;
    if (stageHapticRef.current !== record.id) {
      stageHapticRef.current = record.id;
      hapticStep();
    }
    onFocusDate(record.date);
  };

  // 起卧哑铃图
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
  const targetLabel = targetBedtime && targetWakeTime ? `目标 ${targetBedtime}–${targetWakeTime}` : '近 7 晚均值窗口';
  const activeSleep = sleepRows.find((row) => row.record.id === activeRecord?.id) ?? sleepRows[sleepRows.length - 1] ?? null;
  const isOffTarget = (start: number): boolean => targetStart !== null && Math.abs(start - targetStart) >= DEV_THRESHOLD;
  const offTargetCount = sleepRows.filter((row) => isOffTarget(row.start)).length;
  const avgBedDev =
    targetStart !== null && sleepRows.length
      ? Math.round(sleepRows.reduce((sum, row) => sum + Math.abs(row.start - targetStart), 0) / sleepRows.length)
      : null;

  return (
    <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} space-y-3`}>
      <div className={`flex items-center justify-between gap-2 pb-2 border-b ${innerBorder}`}>
        <span className="text-xs font-bold text-white shrink-0">趋势与结构</span>

        <div className={`flex ${innerBg} p-0.5 rounded-xl border ${innerBorder} text-[10px]`}>
          <button
            type="button"
            onClick={() => setViewMode('quality')}
            className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
              viewMode === 'quality' ? `${accentBg} ${accentFg} shadow` : `${textMuted} hover:text-white`
            }`}
          >
            得分曲线
          </button>
          <button
            type="button"
            onClick={() => setViewMode('circadian')}
            className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
              viewMode === 'circadian' ? `${accentBg} ${accentFg} shadow` : `${textMuted} hover:text-white`
            }`}
          >
            起卧时段
          </button>
          <button
            type="button"
            onClick={() => setViewMode('stages')}
            aria-label="睡眠分期比例（模型估算，非测量）"
            className={`px-2 py-1.5 rounded-lg font-bold whitespace-nowrap transition-all cursor-pointer ${
              viewMode === 'stages' ? `${accentBg} ${accentFg} shadow` : `${textMuted} hover:text-white`
            }`}
          >
            分期估算
          </button>
        </div>
      </div>

      {nights.length === 0 ? (
        <EmptyState
          theme={theme}
          illustration="no-data"
          title="暂无睡眠数据"
          hint="记录第一晚后这里就会出现曲线"
          className="animate-tab-fade-in"
        />
      ) : (
        <>
          {viewMode === 'quality' && (
            <div className="space-y-2 animate-tab-fade-in">
              <div data-no-swipe className={`relative ${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2`}>
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

                <div
                  data-testid="score-chart"
                  role="group"
                  aria-label="近 7 晚睡眠评分趋势图，可点按或拖动查看每一晚"
                  className="w-full"
                  style={{ height: 150, touchAction: 'pan-y' }}
                  onPointerDown={(e) => {
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
                        activeDot={{ r: 4, fill: '#ffffff', stroke: theme.accentHex, strokeWidth: 2, style: { transition: 'cx 130ms ease-out, cy 130ms ease-out' } }}
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
                </div>
              </div>
            </div>
          )}

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

          {viewMode === 'circadian' && (
            <div className="space-y-2 animate-tab-fade-in">
              <div className={`${theme.cardInnerBg} rounded-2xl p-3 border ${theme.cardInnerBorder} space-y-2`}>
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
                      const bedColor = offTarget ? '#fbbf24' : theme.accentHex;
                      return (
                        <button
                          key={record.id}
                          type="button"
                          onClick={() => { hapticStep(); onFocusDate(record.date); }}
                          aria-label={`${record.date} 就寝 ${record.bedtime}，醒来 ${record.wakeTime}${offTarget ? '，偏离目标' : ''}`}
                          title={`就寝 ${record.bedtime}${bedDev !== null ? `（比目标${bedDev >= 0 ? '晚' : '早'} ${Math.abs(Math.round(bedDev / 5) * 5)} 分）` : ''}，醒来 ${record.wakeTime}${wakeDev !== null ? `（比目标${wakeDev >= 0 ? '晚' : '早'} ${Math.abs(Math.round(wakeDev / 5) * 5)} 分）` : ''}`}
                          className="w-full flex items-center gap-2 text-left cursor-pointer group min-h-8"
                        >
                          <span className={`w-9 text-[10px] font-mono shrink-0 tabular-nums ${isHovered ? `${accentText} font-bold` : textMuted}`}>
                            {record.date.slice(5)}
                          </span>

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

                          <span className={`w-[74px] text-right text-[9px] font-mono shrink-0 tabular-nums ${isHovered ? `${accentText} font-bold` : textMuted}`}>
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
          )}
        </>
      )}
    </div>
  );
});
