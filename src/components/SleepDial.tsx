import React, { useEffect, useId, useState } from 'react';
import { SleepRecord } from '../types/sleep';
import { clockMinutes } from '../utils/clockMath';

/**
 * 昨夜睡眠时钟（第 59 轮）。
 *
 * 用户要的是"一眼看到昨晚几点睡、几点起"，不是一个抽象完成度环。
 * 所以回到 24 小时钟面：00 在正上方，顺时针 24 小时；实色弧 = 实际
 * 卧床窗，起止各一个端点；中心保留评分。只保留 00/06/12/18 四个锚点，
 * 不再画 24 根刻度、此刻指针和清醒点——那些在 96px 下只会变成划痕。
 */
interface Props {
  record: SleepRecord;
  scoreHex: string;
  scoreLabel: string;
  size?: number;
}

const CX = 50;
const CY = 50;
const R = 34;

function polar(angle: number, radius = R): { x: number; y: number } {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function arcPath(startMin: number, endMin: number): string {
  let delta = endMin - startMin;
  if (delta <= 0) delta += 1440;
  const a = polar((startMin / 1440) * 360);
  const b = polar(((startMin + delta) / 1440) * 360);
  const large = delta > 720 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function timeToMin(t?: string): number | null {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
  return clockMinutes(t);
}

export const SleepDial: React.FC<Props> = ({ record, scoreHex, scoreLabel, size = 96 }) => {
  const [displayScore, setDisplayScore] = useState(0);
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  useEffect(() => {
    const target = Math.min(99, Math.max(25, record.sleepScore));
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 800);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [record.sleepScore, record.id]);

  const bed = timeToMin(record.bedtime);
  const wake = timeToMin(record.wakeTime);
  const bedPoint = bed !== null ? polar((bed / 1440) * 360) : null;
  let wakePoint: { x: number; y: number } | null = null;
  if (bed !== null && wake !== null) {
    const delta = wake > bed ? wake - bed : wake + 1440 - bed;
    wakePoint = polar(((bed + delta) / 1440) * 360);
  }
  const labels: Array<{ text: string; angle: number }> = [
    { text: '00', angle: 0 },
    { text: '06', angle: 90 },
    { text: '12', angle: 180 },
    { text: '18', angle: 270 },
  ];

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`昨晚睡眠 ${record.bedtime} 到 ${record.wakeTime}，评分 ${record.sleepScore}`}
    >
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <defs>
          <linearGradient id={`${gid}-arc`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={scoreHex} stopOpacity="0.55" />
            <stop offset="100%" stopColor={scoreHex} />
          </linearGradient>
        </defs>

        {/* 24h 轨道 */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="4.5" />

        {/* 睡眠窗弧：底层柔光 + 主弧 */}
        {bed !== null && wake !== null && (
          <>
            <path
              d={arcPath(bed, wake)}
              fill="none"
              stroke={scoreHex}
              strokeWidth="8"
              strokeLinecap="round"
              opacity="0.14"
            />
            <path
              d={arcPath(bed, wake)}
              fill="none"
              stroke={`url(#${gid}-arc)`}
              strokeWidth="5.5"
              strokeLinecap="round"
            />
            {bedPoint && <circle cx={bedPoint.x} cy={bedPoint.y} r="2.2" fill={scoreHex} />}
            {wakePoint && <circle cx={wakePoint.x} cy={wakePoint.y} r="2.8" fill="#ffffff" />}
          </>
        )}

        {/* 四个时钟锚点 */}
        {labels.map((l) => {
          const p = polar(l.angle, 46);
          return (
            <text
              key={l.text}
              x={p.x}
              y={p.y + 2.4}
              textAnchor="middle"
              fontSize="8.5"
              fontFamily="ui-monospace, monospace"
              fill="rgba(148,163,184,0.8)"
            >
              {l.text}
            </text>
          );
        })}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="font-black font-mono text-white tabular-nums leading-none" style={{ fontSize: size * 0.23 }}>
          {displayScore}
        </span>
        <span className="font-black mt-0.5 tracking-wider" style={{ color: scoreHex, fontSize: size * 0.095 }}>
          {scoreLabel}
        </span>
      </div>
    </div>
  );
};
