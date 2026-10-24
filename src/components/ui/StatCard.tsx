import React from 'react';
import { ThemeConfig } from '../../utils/themeStyles';

/**
 * 数据卡（Tremor stat-card 模式收编，MIT）：
 * 标签 + 大数字 + 对比/副文案 的三段式，全应用的数据视图共用此语法。
 */
export interface StatCardProps {
  theme: ThemeConfig;
  label: string;
  value: React.ReactNode;
  /** 副文案/对比（如 "较前晚 -12 分钟"） */
  hint?: React.ReactNode;
  /** 数值颜色类（默认主题强调色） */
  valueClassName?: string;
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  theme,
  label,
  value,
  hint,
  valueClassName,
  className = '',
}) => (
  <div
    className={`${theme.cardInnerBg} border ${theme.cardBorder} rounded-2xl p-3 min-w-0 ${className}`}
  >
    <span className={`text-[10px] ${theme.textMuted} block mb-0.5 truncate`}>{label}</span>
    <span className={`text-xl font-black font-mono tabular-nums ${valueClassName ?? theme.accentText}`}>
      {value}
    </span>
    {hint != null && (
      <span className={`block text-[9px] ${theme.textMuted} leading-snug mt-0.5`}>{hint}</span>
    )}
  </div>
);
