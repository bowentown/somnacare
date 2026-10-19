import React, { useId } from 'react';

/**
 * 梦境能量徽章（第 58 轮重做）。
 *
 * 上一版直接画"月相"：在 52px 的尺寸下，明暗交界线像一条生硬的刀口，
 * 84% 的凸月看起来只是一颗黄圆点，确实不好看。改成睡眠 App 更成熟的
 * 读数语言（Oura/Apple 的活动环 + 中心符号）：
 *  - 外圈是一条金色进度弧（睡眠目标完成度）；
 *  - 中心是一个深色月球 + 柔和的月牙 + 一颗小星，不是几何色块；
 *  - 满环时月牙自带一圈微光，仍然保留"满月出发"的语义。
 */
interface Props {
  value: number;
  target: number;
  size?: number;
  className?: string;
  /** 兼容旧调用：亮面颜色 */
  litColor?: string;
  darkColor?: string;
}

export const MoonEnergy: React.FC<Props> = ({
  value,
  target,
  size = 48,
  className = '',
  litColor = '#fcd34d',
  darkColor = '#0b1222',
}) => {
  const progress = target > 0 ? Math.max(0, Math.min(1, value / target)) : 0;
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const r = 43;
  const circ = 2 * Math.PI * r;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`梦境能量 ${Math.round(progress * 100)}%`}
    >
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <defs>
          <linearGradient id={`${gid}-arc`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={litColor} stopOpacity="0.55" />
            <stop offset="100%" stopColor={litColor} />
          </linearGradient>
          <radialGradient id={`${gid}-orb`} cx="38%" cy="32%" r="75%">
            <stop offset="0%" stopColor="#243653" />
            <stop offset="100%" stopColor={darkColor} />
          </radialGradient>
          <mask id={`${gid}-moon`}>
            <circle cx="50" cy="51" r="17.5" fill="#ffffff" />
            <circle cx="60" cy="42" r="15" fill="#000000" />
          </mask>
        </defs>

        {/* 外圈：轨道 + 进度弧 */}
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="4" />
        {progress > 0 && (
          <circle
            cx="50" cy="50" r={r}
            fill="none"
            stroke={`url(#${gid}-arc)`}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - progress)}
            transform="rotate(-90 50 50)"
          />
        )}

        {/* 月球本体 */}
        <circle cx="50" cy="50" r="32" fill={`url(#${gid}-orb)`} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        {progress >= 1 && <circle cx="50" cy="50" r="32" fill={litColor} opacity="0.08" />}

        {/* 月牙 + 小星 */}
        <circle cx="50" cy="51" r="17.5" fill={litColor} opacity="0.95" mask={`url(#${gid}-moon)`} />
        <circle cx="67" cy="34" r="1.4" fill="#ffffff" opacity="0.75" />
      </svg>
    </div>
  );
};
