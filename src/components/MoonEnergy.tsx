import React from 'react';

/**
 * 月相能量（第 57 轮）：把旅行能量从进度条换成"由缺到圆"的月亮。
 *
 * 画的不是装饰：亮面面积与 progress 严格对应。
 *  - progress = 0：新月（全暗）
 *  - 0.5：右半月
 *  - 1：满月（出发）
 * 用一条"右半圆 + 椭圆返回弧"的路径实现，跨浏览器无滤镜依赖。
 */
interface Props {
  value: number;
  target: number;
  size?: number;
  className?: string;
  /** 暗面颜色：默认夜空蓝灰 */
  darkColor?: string;
  /** 亮面颜色：默认暖金 */
  litColor?: string;
}

export const MoonEnergy: React.FC<Props> = ({
  value,
  target,
  size = 48,
  className = '',
  darkColor = '#273449',
  litColor = '#fcd34d',
}) => {
  const progress = target > 0 ? Math.max(0, Math.min(1, value / target)) : 0;
  const rx = 46 * Math.abs(1 - 2 * progress);
  // 新月至半月：返回弧从底部经右侧回顶部（sweep=0，向内咬掉亮面）；
  // 半月到满月：返回弧经左侧回顶部（sweep=1，补成凸月/满月）
  const sweep = progress < 0.5 ? 0 : 1;
  const litPath = `M 50 4 A 46 46 0 0 1 50 96 A ${rx.toFixed(2)} 46 0 0 ${sweep} 50 4`;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`梦境能量 ${Math.round(progress * 100)}%`}
    >
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <circle cx={50} cy={50} r={48} fill={litColor} opacity={progress > 0.98 ? 0.18 : 0.07} />
        <circle cx={50} cy={50} r={46} fill={darkColor} />
        {progress > 0 && <path d={litPath} fill={litColor} />}
        {/* 一点冷色高光，让亮面不像扁平色块 */}
        <circle cx={38} cy={34} r={46} fill="#ffffff" opacity={progress > 0 ? 0.05 : 0} />
      </svg>
    </div>
  );
};
