import React from 'react';
import { Hypnogram, type HypnogramSegment, type Stage } from 'react-hypnogram';
import { SleepRecord } from '../types/sleep';

/**
 * 睡眠分期时间轴（第 58 轮重做）。
 *
 * 视觉方案不再手写：使用 MIT 开源的 react-hypnogram
 * （https://github.com/CrazyBucket/react-hypnogram，Copyright (c) 2026
 * react-hypnogram contributors），它实现的正是 iOS 健康 App 同类的
 * 连续阶梯带 + 纵向渐变；我们只做主题色/密度/中文标签适配。
 *
 * 旧版把四段画成四条孤立小横杠：既不像 hypnogram，也很难读。
 * 新版是连续带状图（醒→REM→浅→深），行间有连接线，深睡集中在
 * 前半夜这类结构一眼可见；旧记录没有 stages 时仍回退百分比条。
 */
interface Props {
  record: SleepRecord;
  compact?: boolean;
}

const STAGE_COLOR = {
  awake: '#fb7185',
  rem: '#a78bfa',
  light: '#38bdf8',
  deep: '#34d399',
} as const;

const STAGES: Stage[] = [
  { id: 'awake', label: '醒', color: STAGE_COLOR.awake },
  { id: 'rem', label: 'REM', color: STAGE_COLOR.rem },
  { id: 'light', label: '浅', color: STAGE_COLOR.light },
  { id: 'deep', label: '深', color: STAGE_COLOR.deep },
];

export const SleepStageTimeline: React.FC<Props> = ({ record, compact = false }) => {
  const stages = (record.stages ?? []).filter((s) => s.durationMinutes > 0);
  const total = stages.reduce((a, s) => a + s.durationMinutes, 0);
  const hasTimeline = stages.length > 1 && total > 0;

  const pct = (() => {
    const base = Math.max(1, record.durationMinutes + record.awakeMinutes);
    return {
      deep: Math.round((record.deepSleepMinutes / base) * 100),
      light: Math.round((record.lightSleepMinutes / base) * 100),
      rem: Math.round((record.remSleepMinutes / base) * 100),
    };
  })();
  const awakePct = Math.max(0, 100 - pct.deep - pct.light - pct.rem);

  // 以 0 为锚累计毫秒：库只需要相对时间用于画图；x 轴标签关闭，
  // 不涉及时区/日期格式化。
  const segments: HypnogramSegment[] = (() => {
    let cursor = 0;
    return stages.map((s, i) => {
      const start = cursor;
      cursor += s.durationMinutes * 60_000;
      return {
        id: `s-${i}-${s.startTime}`,
        stage: s.stage,
        start,
        end: cursor,
      };
    });
  })();

  return (
    <div className="space-y-1.5">
      <div className="rounded-xl overflow-hidden border border-slate-700/50 bg-black/20 px-1.5 py-1">
        {hasTimeline ? (
          <div role="img" aria-label={`睡眠分期时间轴：${record.bedtime} 到 ${record.wakeTime}`}>
            <Hypnogram
              data={segments}
              stages={STAGES}
              dark
              width="100%"
              stageHeight={15}
              barThickness={9}
              radius={4}
              gap={0}
              connectors={{ enabled: true, width: 1.4, maxGap: 0 }}
              grid={false}
              axes={false}
              xLabels={false}
              yLabels
              yAxis={{ labelStyle: { fontSize: 9, fill: '#94a3b8' } }}
              plotPadding={{ top: 1, right: 2, bottom: 1 }}
              tooltip={false}
              interaction={{ hover: false, selection: false }}
              ariaLabel={`睡眠分期时间轴：${record.bedtime} 到 ${record.wakeTime}`}
            />
          </div>
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
