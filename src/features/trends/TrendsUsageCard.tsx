import React, { useEffect, useState } from 'react';
import { ChevronDown, Smartphone } from 'lucide-react';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import {
  clearUsageData,
  computeUsageRegularity,
  type UsageDay,
  usageHasPermission,
  usageOpenSettings,
  usagePrompted,
} from '../sleep/utils/usageSignal';
import { forceRefreshUsage, getCachedUsageDays } from '../sleep/utils/usageStore';
import { isNativePlatform } from '../sleep/utils/nativeAlarmScheduler';
import { confirmDialog } from '../../shared/ui/ConfirmDialogHost';

interface TrendsUsageCardProps {
  theme: ThemeConfig;
  chronotype: 'night' | 'day' | 'irregular';
}

export const TrendsUsageCard: React.FC<TrendsUsageCardProps> = React.memo(function TrendsUsageCard({
  theme,
  chronotype,
}) {
  const [usagePerm, setUsagePerm] = useState<'checking' | 'granted' | 'denied'>('checking');
  const [usageDays, setUsageDays] = useState<UsageDay[]>(() => getCachedUsageDays());
  const [usagePromptedOnce, setUsagePromptedOnce] = useState(() => usagePrompted());
  const [usageOpen, setUsageOpen] = useState(() => {
    try {
      return localStorage.getItem('somnacare_usage_card_open') !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!isNativePlatform()) return;
    void (async () => {
      const granted = await Promise.race([
        usageHasPermission(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      setUsagePerm(granted ? 'granted' : 'denied');
      if (granted) setUsageDays(await forceRefreshUsage(7, chronotype));
    })();
  }, [chronotype]);

  if (!isNativePlatform()) return null;

  const innerBg = theme.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme.cardInnerBorder || 'border-slate-700/80';
  const textMuted = theme.textMuted || 'text-slate-400';

  const toggleUsageOpen = () => {
    setUsageOpen((v) => {
      try {
        localStorage.setItem('somnacare_usage_card_open', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  return (
    <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleUsageOpen}
          aria-expanded={usageOpen}
          className="flex items-center gap-2 cursor-pointer"
        >
          <Smartphone className={`w-4 h-4 ${theme.accentText}`} />
          <h3 className="text-sm font-bold text-white">手机使用对照</h3>
          <ChevronDown className={`w-4 h-4 ${textMuted} transition-transform ${usageOpen ? 'rotate-180' : ''}`} />
        </button>
        {usagePerm === 'granted' && usageOpen && (
          <button
            type="button"
            onClick={async () => {
              const ok = await confirmDialog({
                title: '清除手机使用缓存',
                message: '清除本机缓存的手机使用对照数据？系统使用记录不受影响，可重新查询。',
                confirmText: '确认清除',
                danger: true,
              });
              if (!ok) return;
              clearUsageData();
              setUsageDays([]);
            }}
            className={`text-[10px] ${textMuted} hover:text-slate-300 underline cursor-pointer py-1.5 -my-1.5`}
          >
            清除手机使用数据
          </button>
        )}
      </div>

      {usageOpen && usagePerm === 'checking' && (
        <p className={`text-[11px] ${textMuted}`}>检查使用情况访问权限…</p>
      )}

      {usageOpen && usagePerm === 'denied' && (
        usagePromptedOnce ? (
          <p className={`text-[11px] ${textMuted} leading-relaxed`}>
            使用情况访问未开启。
            <button
              type="button"
              onClick={() => void usageOpenSettings()}
              className="underline cursor-pointer hover:text-white py-1.5 -my-1.5"
            >
              点此前往系统设置
            </button>
            ，开启后她会知道你几点真正放下手机——数据只留在手机上。
          </p>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11px] text-slate-200 leading-relaxed">
              开启"使用情况访问"，她会知道你昨晚几点真正放下手机、早上几点拿起——
              和你的记录并排对照，数据只留在手机上。
            </p>
            <button
              type="button"
              onClick={() => {
                setUsagePromptedOnce(true);
                void usageOpenSettings().then(async () => {
                  const granted = await usageHasPermission();
                  setUsagePerm(granted ? 'granted' : 'denied');
                  if (granted) setUsageDays(await forceRefreshUsage(7, chronotype));
                });
              }}
              className={`w-full py-2.5 rounded-xl ${theme.accentText} border ${theme.accentBorder} text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform`}
              style={{ background: `${theme.accentHex}1a` }}
            >
              前往系统设置开启
            </button>
          </div>
        )
      )}

      {usageOpen && usagePerm === 'granted' && (() => {
        const uReg = computeUsageRegularity(usageDays);
        const shown = usageDays.filter((d) => d.lastActive).slice(0, 7);
        return (
          <div className="space-y-2">
            {uReg && (
              <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3 flex items-center justify-between`}>
                <span className="text-[11px] font-bold text-slate-200">手机使用规律度</span>
                <span className={`font-mono font-black ${
                  uReg.score >= 80 ? 'text-emerald-400' : uReg.score >= 50 ? 'text-amber-400' : 'text-rose-400'
                }`}>{uReg.score}</span>
              </div>
            )}
            {shown.length === 0 ? (
              <p className={`text-[11px] ${textMuted}`}>还没有可用的使用数据，明天再来看看。</p>
            ) : shown.map((d) => (
              <div key={d.date} className={`${innerBg} border ${innerBorder} rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-[11px]`}>
                <span className={`${textMuted} font-mono shrink-0 tabular-nums`}>{d.date.slice(5)}</span>
                <span className="text-slate-300 font-mono">
                  {d.lastActive || '--:--'} 放下 → {d.firstActive || '--:--'} 拿起
                </span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
});
