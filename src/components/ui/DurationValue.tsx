import React from 'react';

/**
 * 时长数值（第 111 轮，Refactoring UI 层级处方）：
 * 大数字 + 小号浅色单位的分层排版，取代 "8H0M" 式同字号挤压
 * ——那个写法数字与单位同色同重，读起来像十六进制。
 * 数字走 font-display（数据大数字角色），单位是轻声的中文小字，
 * 主色/尺寸由调用方给定（跟随所在卡片的层级）。
 */
export const DurationValue: React.FC<{
  minutes: number;
  className?: string;
  unitClassName?: string;
}> = ({ minutes, className = '', unitClassName = 'text-[10px] font-medium tracking-wide text-slate-400' }) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <span className={`font-display font-bold tabular-nums ${className}`}>
      {h}
      <span className={unitClassName}> 小时 </span>
      {m}
      <span className={unitClassName}> 分</span>
    </span>
  );
};
