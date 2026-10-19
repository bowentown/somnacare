import React, { useEffect, useId, useState } from 'react';
import { SleepRecord } from '../types/sleep';

/**
 * 昨夜睡眠环（第 58 轮重做）。
 *
 * 旧版是"24 小时表盘 + 刻度 + 清醒点 + 此刻指针"，在 96px 下所有细节
 * 都退化成划痕，弧线断开处也像坏图。改成睡眠类 App 通用的干净读数：
 *  - 一条完整轨道 + 按「睡眠时长 / 目标时长」填充的渐变弧；
 *  - 圆头端点 + 弧末端一个高光点（Oura / Apple 活动环的读数语言）；
 *  - 中心只留评分与档位，具体时刻交给右侧文字。
 * 这是"目标完成度"而不是 24 小时钟面——不假装精确到分钟。
 */
interface Props {
  record: SleepRecord;
  targetMinutes?: number;
  scoreHex: string;
  scoreLabel: string;
  size?: number;
}

const R = 40;
const CIRC = 2 * Math.PI * R;

export const SleepDial: React.FC<Props> = ({
  record,
  targetMinutes,
  scoreHex,
  scoreLabel,
  size = 96,
}) => {
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

  const rawGoal = targetMinutes ?? 8 * 60;
  const goal = Math.max(60, Number.isFinite(rawGoal) ? rawGoal : 8 * 60);
  const progress = Math.max(0.02, Math.min(1, record.durationMinutes / goal));
  const angle = progress * 360 - 90;
  const dotX = 50 + R * Math.cos((angle * Math.PI) / 180);
  const dotY = 50 + R * Math.sin((angle * Math.PI) / 180);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`昨晚睡眠 ${record.durationMinutes} 分钟，评分 ${record.sleepScore}`}
    >
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <defs>
          <linearGradient id={`${gid}-ring`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={scoreHex} stopOpacity="0.5" />
            <stop offset="100%" stopColor={scoreHex} />
          </linearGradient>
        </defs>

        {/* 轨道 */}
        <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(148,163,184,0.16)" strokeWidth="7" />

        {/* 进度弧：底层柔光 + 主弧 */}
        <g transform="rotate(-90 50 50)">
          <circle
            cx="50" cy="50" r={R}
            fill="none"
            stroke={`url(#${gid}-ring)`}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - progress)}
            opacity="0.18"
          />
          <circle
            cx="50" cy="50" r={R}
            fill="none"
            stroke={`url(#${gid}-ring)`}
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - progress)}
          />
        </g>

        {/* 弧末端高光点 */}
        <circle cx={dotX} cy={dotY} r="4.6" fill={scoreHex} opacity="0.22" />
        <circle cx={dotX} cy={dotY} r="2.4" fill="#ffffff" />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="font-black font-mono text-white tabular-nums leading-none" style={{ fontSize: size * 0.25 }}>
          {displayScore}
        </span>
        <span className="font-black mt-1 tracking-wider" style={{ color: scoreHex, fontSize: size * 0.1 }}>
          {scoreLabel}
        </span>
      </div>
    </div>
  );
};
