import React from 'react';
import { SleepRecord, SleepStage } from '../types/sleep';

/**
 * 睡眠分期时间轴（第 57 轮）：把逐段分期画成横向 hypnogram。
 *
 * 旧实现只有一条四色百分比堆叠条——能看出比例，看不出"深睡集中在
 * 前半夜"这类结构。时间轴按分段时长累计定位，旧记录没有 stages 时
 * 自动回退为百分比条（不编造时刻）。
 */
interface Props {
  record: SleepRecord;
  /** 紧凑模式：只画条，不画四段百分比（详情弹窗以外的地方用） */
  compact?: boolean;
}

const STAGE_COLOR: Record<SleepStage, string> = {
  awake: '#fb7185',
  rem: '#a78bfa',
  light: '#38bdf8',
  deep: '#34d399',
};
const STAGE_LABEL: Record<SleepStage, string> = {
  awake: '醒',
  rem: 'REM',
  light: '浅',
  deep: '深',
};
/** hypnogram 惯例：醒在最上、深睡在最下 */
const STAGE_LANE: Record<SleepStage, number> = {
  awake: 5,
  rem: 11,
  light: 17,
  deep: 23,
};

const VIEW_W = 100;
const VIEW_H = 28;

export const SleepStageTimeline: React.FC<Props> = ({ record, compact = false }) => {
  const stages = (record.stages ?? []).filter((s) => s.durationMinutes > 0);
  const total = stages.reduce((a, s) => a + s.durationMinutes, 0);
  const windowMin = Math.max(1, record.durationMinutes + record.awakeMinutes);

  const pct = (() => {
    const base = Math.max(1, windowMin);
    return {
      deep: Math.round((record.deepSleepMinutes / base) * 100),
      light: Math.round((record.lightSleepMinutes / base) * 100),
      rem: Math.round((record.remSleepMinutes / base) * 100),
    };
  })();
  const awakePct = Math.max(0, 100 - pct.deep - pct.light - pct.rem);

  const hasTimeline = stages.length > 1 && total > 0;

  return (
    <div className="space-y-1.5">
      <div className="rounded-xl overflow-hidden border border-slate-700/50 bg-black/20 px-1.5 py-1">
        {hasTimeline ? (
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="w-full h-7"
            role="img"
            aria-label={`睡眠分期时间轴：${record.bedtime} 到 ${record.wakeTime}`}
          >
            {Object.entries(STAGE_LANE).map(([stage, y]) => (
              <line
                key={stage}
                x1={0} y1={y} x2={VIEW_W} y2={y}
                stroke="rgba(148,163,184,0.08)"
                strokeWidth={0.6}
              />
            ))}
            {(() => {
              let acc = 0;
              return stages.map((s, i) => {
                const x = (acc / total) * VIEW_W;
                const w = Math.max(0.6, (s.durationMinutes / total) * VIEW_W);
                acc += s.durationMinutes;
                const y = STAGE_LANE[s.stage] ?? STAGE_LANE.light;
                return (
                  <rect
                    key={`${i}-${s.startTime}-${s.stage}`}
                    x={x}
                    y={y - 2.4}
                    width={w}
                    height={4.8}
                    rx={1.6}
                    fill={STAGE_COLOR[s.stage] ?? STAGE_COLOR.light}
                  />
                );
              });
            })()}
          </svg>
        ) : (
          <div className="flex h-7 rounded-lg overflow-hidden gap-px">
            {(['deep', 'light', 'rem', 'awake'] as const).map((stage) => (
              <div
                key={stage}
                style={{
                  width: `${stage === 'awake' ? awakePct : pct[stage]}%`,
                  backgroundColor: STAGE_COLOR[stage],
                  opacity: stage === 'awake' ? 0.7 : 1,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {!compact && (
        <div className="flex justify-between text-[9px] text-slate-400 font-mono">
          <span className="text-emerald-400">深 {pct.deep}%</span>
          <span className="text-sky-400">浅 {pct.light}%</span>
          <span className="text-violet-400">REM {pct.rem}%</span>
          <span className="text-rose-400/80">醒 {awakePct}%</span>
        </div>
      )}
    </div>
  );
};

export { STAGE_COLOR, STAGE_LABEL };
