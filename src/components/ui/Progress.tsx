import React from 'react';
import { ThemeConfig } from '../../utils/themeStyles';

/** 细进度条（shadcn/ui Progress 模式收编，MIT） */
export const Progress: React.FC<{
  theme: ThemeConfig;
  /** 0-100，超界自动截断 */
  value: number;
  className?: string;
}> = ({ theme, value, className = '' }) => (
  <div className={`h-1.5 rounded-full bg-slate-700 overflow-hidden ${className}`}>
    <div
      className="h-full rounded-full transition-[width] duration-500"
      style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: theme.accentHex }}
    />
  </div>
);

/** 骨架屏（shadcn/ui Skeleton 模式收编，MIT） */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded-xl bg-slate-700/50 ${className}`} />
);
