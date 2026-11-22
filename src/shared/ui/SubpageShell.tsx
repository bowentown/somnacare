import React, { useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { ThemeConfig } from '../theme/themeStyles';
import { popSubpage } from '../store/uiStore';
import { hasOpenModal } from '../utils/modalA11y';
import { tapTick } from '../utils/haptics';

interface SubpageShellProps {
  title: string;
  subtitle?: string;
  theme: ThemeConfig;
  rightSlot?: React.ReactNode;
  onBack?: () => void;
  children: React.ReactNode;
}

/**
 * 轻量二级子页统一壳层（Phase 2B）：
 * - 覆盖在主 Tab 与底栏之上（z-[60]），位于 Web 护眼滤镜（z-[70]）和全局弹窗（z-[90]+）之下
 * - 固定顶栏（返回键 + 标题 + 右侧操作槽）+ 自然纵向滚动区
 * - 桌面键盘 Escape 返回（当上方无弹窗时）；Android 返回键由 useAndroidBackButton 统一接管
 */
export const SubpageShell: React.FC<SubpageShellProps> = ({
  title,
  subtitle,
  theme,
  rightSlot,
  onBack,
  children,
}) => {
  const handleBack = () => {
    tapTick();
    if (onBack) onBack();
    else popSubpage();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hasOpenModal()) return;
      e.preventDefault();
      if (onBack) onBack();
      else popSubpage();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  return (
    <div
      data-no-swipe
      role="region"
      aria-label={title}
      className={`fixed inset-0 z-[60] ${theme.pageBg} ${theme.textPrimary} flex flex-col overflow-hidden animate-fadeIn`}
    >
      <div className="w-full flex-1 max-w-lg mx-auto flex flex-col min-h-0">
        <header className={`px-4 pt-5 pb-3.5 flex items-center justify-between gap-2 border-b ${theme.cardBorder} shrink-0`}>
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={handleBack}
              aria-label="返回"
              className={`w-9 h-9 rounded-xl ${theme.cardBg} border ${theme.cardBorder} flex items-center justify-center text-slate-200 hover:text-white active:scale-95 transition-transform cursor-pointer shrink-0`}
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h2 className="text-base font-black text-white tracking-tight truncate">{title}</h2>
              {subtitle && <p className="text-[10px] text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>
          {rightSlot && <div className="shrink-0">{rightSlot}</div>}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
          <div className="p-4 space-y-4 pb-24">{children}</div>
        </div>
      </div>
    </div>
  );
};
