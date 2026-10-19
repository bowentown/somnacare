import React from 'react';
import { Moon, BarChart2, Sparkles, Sliders, Eye } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { hapticPage } from '../utils/haptics';

export type NavTab = 'today' | 'trends' | 'coach' | 'eyecare' | 'settings';

interface BottomNavBarProps {
  activeTab: NavTab;
  onChangeTab: (tab: NavTab) => void;
  theme: ThemeConfig;
}

export const BottomNavBar: React.FC<BottomNavBarProps> = ({ activeTab, onChangeTab, theme }) => {
  const tabs: { key: NavTab; label: string; icon: React.ElementType }[] = [
    { key: 'today', label: '睡眠', icon: Moon },
    { key: 'trends', label: '趋势', icon: BarChart2 },
    { key: 'coach', label: 'AI顾问', icon: Sparkles },
    { key: 'eyecare', label: '护眼', icon: Eye },
    { key: 'settings', label: '偏好', icon: Sliders },
  ];
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.key === activeTab));

  return (
    <nav
      role="navigation"
      aria-label="主标签栏"
      className={`fixed bottom-0 left-0 right-0 z-50 w-full select-none ${theme.navBg} border-t ${theme.navBorder} px-3 py-2 pb-safe shadow-[0_-10px_30px_rgba(0,0,0,0.7)] transition-colors`}
    >
      <div className="relative grid grid-cols-5 items-center max-w-lg mx-auto">
        {/* 滑动胶囊：一枚共享的激活底片，比每格自己换背景更有连续感 */}
        <div
          aria-hidden="true"
          data-testid="nav-pill"
          data-active-index={activeIndex}
          className={`absolute inset-y-1 left-0 w-1/5 rounded-2xl ${theme.navActiveBg} pointer-events-none transition-transform duration-300 ease-out will-change-transform`}
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => {
                if (!isActive) hapticPage();
                onChangeTab(t.key);
              }}
              className={`relative z-10 flex flex-col items-center justify-center min-h-[50px] py-1 px-2 rounded-xl transition-all group focus:outline-none ${theme?.focusRing} cursor-pointer`}
            >
              <div
                className={`p-1.5 rounded-xl transition-all flex items-center justify-center ${
                  isActive
                    ? theme.navActiveText
                    : `${theme.navInactiveText} group-hover:text-white`
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.8]' : 'stroke-[2]'}`} />
              </div>
              <span
                className={`text-xs mt-0.5 tracking-tight transition-colors ${
                  isActive ? 'font-black text-white' : `${theme.navInactiveText} font-semibold`
                }`}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
