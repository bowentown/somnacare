import React from 'react';
import { ThemeConfig } from '../../utils/themeStyles';
import { Illustration, type IllustrationName } from './Illustration';

/**
 * 空态（unDraw 插画 + 标题 + 提示）：
 * 全应用唯一的空态实现——禁止再手搓色块空态（见 verify-design-system 护栏）。
 */
export const EmptyState: React.FC<{
  theme: ThemeConfig;
  illustration: IllustrationName;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  /** 紧凑模式（嵌在小卡内） */
  compact?: boolean;
  className?: string;
}> = ({ theme, illustration, title, hint, action, compact = false, className = '' }) => (
  <div
    className={`rounded-2xl border border-dashed border-slate-600 bg-black/20 flex flex-col items-center justify-center gap-1.5 ${
      compact ? 'py-4 px-4' : 'py-6 px-6'
    } ${className}`}
  >
    <Illustration name={illustration} theme={theme} maxHeight={compact ? 90 : 130} className="w-full" />
    <span className={`font-black text-slate-200 ${compact ? 'text-xs' : 'text-sm'}`}>{title}</span>
    {hint != null && (
      <span className="text-[10px] text-slate-500 leading-relaxed text-center">{hint}</span>
    )}
    {action}
  </div>
);
