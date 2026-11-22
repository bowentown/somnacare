import React, { useId } from 'react';
import { getMoonInfo } from '../utils/moonPhase';

interface MoonDiscProps {
  /** 直径（px） */
  size: number;
  /** 计算月相的日期（默认当前） */
  date?: Date;
  /** 受光面颜色 */
  litColor: string;
  /** 背面颜色（建议用比卡片更深一档的底色） */
  darkColor: string;
  /** 描边色（可省） */
  strokeColor?: string;
  className?: string;
}

/**
 * 真实月相圆盘：暗底圆 + 受光半圆（clip）+ 界线椭圆透镜（clip）。
 * 几何合成，无圆弧 sweep 判定，盈亏方向不可能出错。
 */
export const MoonDisc: React.FC<MoonDiscProps> = ({
  size,
  date,
  litColor,
  darkColor,
  strokeColor,
  className,
}) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const info = getMoonInfo(date);
  const r = 34;
  const rx = r * Math.abs(Math.cos(2 * Math.PI * (info.age / 29.530588853)));
  const waxing = info.waxing;
  const litSideX = waxing ? 40 : 0;
  const darkSideX = waxing ? 0 : 40;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      className={className}
      role="img"
      aria-label={`${info.phaseName} · 月龄 ${info.age.toFixed(1)} 天`}
    >
      <defs>
        <clipPath id={`${uid}lit`}>
          <rect x={litSideX - 0.5} y="0" width="41" height="80" />
        </clipPath>
        <clipPath id={`${uid}dark`}>
          <rect x={darkSideX - 0.5} y="0" width="41" height="80" />
        </clipPath>
      </defs>
      {/* 暗底 */}
      <circle cx="40" cy="40" r={r} fill={darkColor} stroke={strokeColor} strokeWidth="1" />
      {/* 受光半圆 */}
      <circle cx="40" cy="40" r={r} fill={litColor} clipPath={`url(#${uid}lit)`} />
      {/* 界线透镜：盈凸时点亮暗侧凸起；娥眉/残月时压暗受光侧回缩 */}
      {info.illumination > 0.5 ? (
        <ellipse cx="40" cy="40" rx={rx} ry={r} fill={litColor} clipPath={`url(#${uid}dark)`} />
      ) : (
        <ellipse cx="40" cy="40" rx={rx} ry={r} fill={darkColor} clipPath={`url(#${uid}lit)`} />
      )}
    </svg>
  );
};

export default MoonDisc;
