import React, { useEffect, useState } from 'react';
import { SleepRecord } from '../types/sleep';
import { clockMinutes } from '../utils/clockMath';

/**
 * 24 小时睡眠表盘（第 57 轮）：替换通用的"评分进度环"。
 *
 * 读法：00:00 在正上方，顺时针 24 小时。
 *  - 实色弧：昨晚实际卧床窗（就寝 → 起床）
 *  - 虚线弧：目标作息窗（弱化，不抢主弧）
 *  - 玫瑰小点：分期里的清醒段位置
 *  - 外圈小白点：此刻
 * 中心仍是评分——但一眼能看出"睡在一天的哪一段、和目标差多远"。
 */
interface Props {
  record: SleepRecord;
  targetBedtime?: string;
  targetWakeTime?: string;
  accentHex: string;
  scoreHex: string;
  scoreLabel: string;
  /** 直径 px */
  size?: number;
}

const CX = 50;
const CY = 50;
const R = 39;

function polar(angle: number, radius = R): { x: number; y: number } {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

/** 分钟 → 以 00:00 为 0°、顺时针的弧路径（跨午夜自动加分） */
function arcPath(startMin: number, endMin: number, radius = R): string {
  let delta = endMin - startMin;
  if (delta <= 0) delta += 1440;
  const a = polar((startMin / 1440) * 360, radius);
  const b = polar(((startMin + delta) / 1440) * 360, radius);
  const large = delta > 720 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function timeToMin(t?: string): number | null {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
  return clockMinutes(t);
}

export const SleepDial: React.FC<Props> = ({
  record,
  targetBedtime,
  targetWakeTime,
  accentHex,
  scoreHex,
  scoreLabel,
  size = 96,
}) => {
  const [displayScore, setDisplayScore] = useState(0);
  // 此刻指针每分钟走一次；不跟随父组件刷新频率
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

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
  const targetBed = timeToMin(targetBedtime);
  const targetWake = timeToMin(targetWakeTime);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const awakeMarks = (record.stages ?? [])
    .filter((s) => s.stage === 'awake')
    .slice(0, 8)
    .map((s) => timeToMin(s.startTime))
    .filter((m): m is number => m !== null);
  const nowPoint = polar((nowMin / 1440) * 360, 45);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${record.bedtime} 到 ${record.wakeTime} 的睡眠表盘，评分 ${record.sleepScore}`}
    >
      <svg viewBox="0 0 100 100" className="w-full h-full">
        {/* 24 小时刻度：每格一小时，6 小时处加粗 */}
        {Array.from({ length: 24 }, (_, h) => {
          const major = h % 6 === 0;
          const a = polar((h / 24) * 360, major ? 42.5 : 43.5);
          const b = polar((h / 24) * 360, 46.5);
          return (
            <line
              key={h}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="rgba(148,163,184,0.28)"
              strokeWidth={major ? 1.1 : 0.6}
              strokeLinecap="round"
            />
          );
        })}

        {/* 目标作息：虚线弱弧 */}
        {targetBed !== null && targetWake !== null && (
          <path
            d={arcPath(targetBed, targetWake)}
            fill="none"
            stroke={accentHex}
            strokeOpacity={0.32}
            strokeWidth={4}
            strokeDasharray="1.5 3.5"
            strokeLinecap="round"
          />
        )}

        {/* 实际睡眠弧 */}
        {bed !== null && wake !== null && (
          <path
            d={arcPath(bed, wake)}
            fill="none"
            stroke={scoreHex}
            strokeWidth={6.5}
            strokeLinecap="round"
          />
        )}

        {/* 清醒段位置 */}
        {awakeMarks.map((m, i) => {
          const p = polar((m / 1440) * 360);
          return <circle key={`${m}-${i}`} cx={p.x} cy={p.y} r={1.7} fill="#fb7185" />;
        })}

        {/* 此刻 */}
        <circle cx={nowPoint.x} cy={nowPoint.y} r={1.5} fill="rgba(255,255,255,0.8)" />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-xl font-black font-mono text-white tabular-nums leading-none">
          {displayScore}
        </span>
        <span className="text-[9px] font-black mt-1" style={{ color: scoreHex }}>
          {scoreLabel}
        </span>
      </div>
    </div>
  );
};
