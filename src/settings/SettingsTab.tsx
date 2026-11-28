import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  Fish,
  LayoutGrid,
  Moon,
  MousePointerClick,
  Palette,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import type { CustomAIConfig } from '../shared/types/sleep';
import { APP_THEMES } from '../shared/theme/themeStyles';
import { getCurrentTheme, updateProfile, useProfileStore } from '../shared/store/profileStore';
import { useSleepStore } from '../features/sleep/store/sleepStore';
import { pushSubpage, type SubpageId } from '../shared/store/uiStore';
import { CustomAISettingsModal } from '../features/coach/CustomAISettingsModal';
import { isPetEnabled, isPetNative } from '../features/pet/utils/petOverlay';
import { isNativePlatform } from '../features/sleep/utils/nativeAlarmScheduler';
import { getAdSkipStatus, type AdSkipStatus } from '../features/extensions/ad-skip/adSkip';
import { tapTick } from '../shared/utils/haptics';

const CHRONOTYPE_LABEL: Record<string, string> = {
  night: '夜间为主',
  day: '白天为主',
  irregular: '不规律',
};

const SettingsTabInner: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const recordCount = useSleepStore((s) => s.records.length);
  const theme = getCurrentTheme(userProfile);

  const [isAIConfigOpen, setIsAIConfigOpen] = useState(false);
  const [adSkip, setAdSkip] = useState<AdSkipStatus | null>(null);
  const native = isNativePlatform();

  useEffect(() => {
    if (!native) return;
    void getAdSkipStatus().then(setAdSkip);
  }, [native]);

  const activeThemeName =
    APP_THEMES[(userProfile.themeColor || 'midnight') as keyof typeof APP_THEMES]?.name ?? '深空午夜';
  const enabledAlarms = (userProfile.alarms || []).filter((a) => a.enabled).length;
  const chronotypeText = CHRONOTYPE_LABEL[userProfile.chronotype ?? 'night'] ?? '夜间为主';

  const petNative = isPetNative();
  const petStatus = !petNative ? '安装 APK 后可用' : isPetEnabled() ? '已开启' : '已关闭';

  const lastBackupAt = (() => {
    try {
      return Number(localStorage.getItem('somnacare_last_backup_at')) || 0;
    } catch {
      return 0;
    }
  })();
  const backupDays = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;
  const backupWarn = backupDays === null ? recordCount >= 7 : backupDays > 30;
  const backupSummary = `${recordCount} 条 · ${
    backupDays === null ? '未备份' : backupDays === 0 ? '今天已备份' : `${backupDays} 天前备份`
  }`;

  const adSkipSummary = !native
    ? '安装 APK 后可用'
    : !adSkip
      ? '读取中…'
      : adSkip.enabled
        ? adSkip.serviceEnabled
          ? `已生效 · 跳过 ${adSkip.hits} 次`
          : '待授权'
        : '已关闭';

  const aiModelLabel =
    userProfile.aiConfig?.provider === 'deepseek'
      ? userProfile.aiConfig.deepseekApiKey
        ? `DeepSeek (${userProfile.aiConfig.deepseekModel || 'deepseek-flash'})`
        : '本地医学规则引擎（未填 DeepSeek 密钥）'
      : userProfile.aiConfig?.provider === 'custom_openai'
        ? userProfile.aiConfig.customApiKey
          ? '自建 API'
          : '本地医学规则引擎（未填自建密钥）'
        : '本地医学规则引擎';

  const openPage = (id: SubpageId) => {
    tapTick();
    pushSubpage(id);
  };

  const coreEntries: Array<{
    id: SubpageId;
    title: string;
    subtitle: string;
    badge: string;
    badgeWarn?: boolean;
    icon: React.ElementType;
  }> = [
    {
      id: 'settings/appearance',
      title: '界面主题',
      subtitle: '主题配色、动态桌面图标与环境光',
      badge: activeThemeName,
      icon: Palette,
    },
    {
      id: 'settings/schedule',
      title: '我的作息与闹钟',
      subtitle: '作息目标、夜间守护与定制闹钟',
      badge: `${chronotypeText} · ${enabledAlarms} 个闹钟`,
      icon: Moon,
    },
    {
      id: 'settings/pet',
      title: '大肥鱼桌宠',
      subtitle: '桌面悬浮陪伴、深夜刷屏提醒与傲娇播报',
      badge: petStatus,
      icon: Fish,
    },
    {
      id: 'settings/extensions',
      title: '摇一摇广告跳过',
      subtitle: '开屏自动跳过、排除应用名单与 Shizuku 守护',
      badge: adSkipSummary,
      icon: MousePointerClick,
    },
    {
      id: 'settings/widgets',
      title: '桌面小组件',
      subtitle: '实时预览与桌面添加指南',
      badge: '4 款组件',
      icon: LayoutGrid,
    },
    {
      id: 'settings/data',
      title: '数据备份与诊断',
      subtitle: '全量导入导出、自动记录自检与版本更新',
      badge: backupWarn ? `${backupSummary} · 建议备份` : backupSummary,
      badgeWarn: backupWarn,
      icon: ShieldCheck,
    },
  ];

  return (
    <div className={`space-y-4 pb-28 ${theme.textPrimary}`}>
      {/* 核心偏好导航菜单（单卡整洁收纳） */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl divide-y divide-slate-700/50 overflow-hidden`}>
        {coreEntries.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => openPage(item.id)}
              className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-black text-white tracking-wide">{item.title}</h3>
                  <p className="text-[10px] text-slate-400 truncate mt-0.5">{item.subtitle}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 max-w-[44%]">
                <span
                  className={`text-[10px] font-bold truncate ${
                    item.badgeWarn ? 'text-amber-400' : 'text-slate-400'
                  }`}
                >
                  {item.badge}
                </span>
                <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
              </div>
            </button>
          );
        })}
      </div>

      {/* AI 顾问模型快捷入口（一步直达配置弹窗） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-2xl bg-violet-600/30 text-violet-300 flex items-center justify-center border border-violet-400/50 shrink-0">
              <Sliders className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white">AI 顾问</h3>
              <p className="text-xs text-slate-300 truncate">
                当前运行：
                <span className={`${theme.accentText} font-bold ml-1`}>{aiModelLabel}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAIConfigOpen(true)}
            className={`px-4 py-2.5 rounded-xl ${theme.accentBg} ${theme.accentFg} font-black text-xs shadow-md active:scale-95 transition-all cursor-pointer whitespace-nowrap shrink-0`}
          >
            配置与探查
          </button>
        </div>
      </div>

      {createPortal(
        <CustomAISettingsModal
          isOpen={isAIConfigOpen}
          onClose={() => setIsAIConfigOpen(false)}
          config={userProfile.aiConfig || { provider: 'deepseek' }}
          onSaveConfig={(cfg: CustomAIConfig) => updateProfile({ aiConfig: cfg })}
          theme={theme}
        />,
        document.body,
      )}
    </div>
  );
};

export const SettingsTab = React.memo(SettingsTabInner);
