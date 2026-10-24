import React from 'react';
import { ThemeConfig } from '../../utils/themeStyles';

/**
 * 卡片基座（shadcn/ui Card 模式收编，MIT）：
 * 统一圆角/边框/内边距的视觉语言，业务差异只通过 className 追加。
 */
export const Card: React.FC<
  React.HTMLAttributes<HTMLDivElement> & { theme: ThemeConfig; padded?: boolean }
> = ({ theme, padded = true, className = '', children, ...rest }) => (
  <div
    className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl ${padded ? 'p-4' : ''} ${className}`}
    {...rest}
  >
    {children}
  </div>
);

/** 卡片标题行：图标 + 标题 + 右侧附加内容 */
export const CardHeader: React.FC<{ icon?: React.ReactNode; title: string; right?: React.ReactNode }> = ({
  icon,
  title,
  right,
}) => (
  <div className="flex items-center justify-between gap-2 pb-2">
    <div className="flex items-center gap-2 min-w-0">
      {icon}
      <h3 className="text-xs font-bold text-white">{title}</h3>
    </div>
    {right}
  </div>
);
