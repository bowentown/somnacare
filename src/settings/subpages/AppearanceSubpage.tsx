import React from 'react';
import { Palette } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { APP_THEMES } from '../../shared/theme/themeStyles';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { nativePlugin } from '../../shared/native/nativeBridge';

/** 主题切换时同步切换桌面图标（原生 activity-alias 启停；Web 环境跳过） */
function switchLauncherIcon(themeId: string) {
  try {
    const g = nativePlugin('SleepCore');
    if (g) g.setLauncherIcon({ theme: themeId });
  } catch {
    // 图标切换失败不影响主题应用
  }
}

export const AppearanceSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);

  return (
    <SubpageShell title="外观与主题" subtitle="配色风格、动态图标与环境光" theme={theme}>
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="flex items-center gap-2.5 pb-2.5 border-b border-slate-700/60">
          <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
            <Palette className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-wide">界面主题</h3>
            <p className="text-[10px] text-slate-400">切换主题将同步调整应用配色与桌面图标</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {Object.values(APP_THEMES).map((t) => {
            const isSelected = (userProfile.themeColor || 'midnight') === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  updateProfile({ themeColor: t.id });
                  switchLauncherIcon(t.id);
                }}
                className={`p-3.5 rounded-2xl border text-left transition-all relative cursor-pointer ${
                  isSelected
                    ? `${theme.accentBorder} ${theme.cardInnerBg} shadow-lg`
                    : `${theme.cardInnerBg} border-slate-700/70 hover:border-slate-500`
                }`}
                style={isSelected ? { boxShadow: `0 0 0 1px ${theme.accentHex}80` } : undefined}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-4 h-4 rounded-full ${t.pageBg} border-2 border-slate-400 shadow-sm flex items-center justify-center`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
                    </span>
                    <span className="text-xs font-black text-white">{t.name}</span>
                  </div>
                  {isSelected ? (
                    <span className={`text-[11px] font-bold ${theme.accentText}`}>
                      ✓ 使用中
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400 font-medium">{t.tag}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* 环境光：时段色温 + 极光缓动，不改变主题本身 */}
        <div className={`flex items-center justify-between gap-3 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5`}>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-200">环境光</p>
            <p className="text-[10px] text-slate-400">随早中晚时段叠加极淡色温氛围</p>
          </div>
          <button
            type="button"
            onClick={() => updateProfile({ ambientLightEnabled: userProfile.ambientLightEnabled === false })}
            aria-pressed={userProfile.ambientLightEnabled !== false}
            aria-label="环境光"
            className="relative inline-flex items-center cursor-pointer shrink-0"
          >
            <span
              className="block w-10 h-5 rounded-full transition-colors relative"
              style={{ background: userProfile.ambientLightEnabled !== false ? theme.accentHex : '#475569' }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all"
                style={{ left: userProfile.ambientLightEnabled !== false ? '22px' : '2px' }}
              />
            </span>
          </button>
        </div>
      </div>
    </SubpageShell>
  );
};
