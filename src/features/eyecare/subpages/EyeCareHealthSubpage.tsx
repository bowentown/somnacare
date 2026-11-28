import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Clock, Eye } from 'lucide-react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { DurationValue, EmptyState, StatCard, Switch } from '../../../shared/ui';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { showToast } from '../../../shared/store/uiStore';
import { useMinuteTick } from '../../../shared/hooks/useMinuteTick';
import {
  getEyeRestStatus,
  isEyeCareNative,
  parseTodayMaxContinuousMin,
  setEyeRestEnabled,
  type EyeRestStatus,
} from '../utils/eyeCare';
import { queryDailyHealth, type DailyHealthDay } from '../../sleep/utils/usageSignal';

const EyeHealthChart = lazy(() =>
  import('../EyeHealthChart').then((m) => ({ default: m.EyeHealthChart })),
);

export const EyeCareHealthSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const native = isEyeCareNative();
  const now = useMinuteTick();

  const [rest, setRest] = useState<EyeRestStatus>({ enabled: false, serviceAlive: false, maxTodayRaw: '' });
  const [dailyHealth, setDailyHealth] = useState<DailyHealthDay[]>([]);

  useEffect(() => {
    if (!native) return;
    void getEyeRestStatus().then(setRest).catch(() => { /* ignore */ });
    void queryDailyHealth(7).then(setDailyHealth).catch(() => setDailyHealth([]));
  }, [native]);

  const toggleRest = async () => {
    const next = !rest.enabled;
    const ok = await setEyeRestEnabled(next);
    if (ok) {
      setRest((prev) => ({ ...prev, enabled: next }));
      showToast(next ? '20-20-20 已开启：连续用屏 20 分钟会提醒你远眺' : '20-20-20 已关闭');
    } else {
      showToast('当前环境不支持（需安装 APK）');
    }
  };

  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayHealth = dailyHealth.find((d) => d.date === todayKey) ?? null;
  const maxToday = parseTodayMaxContinuousMin(rest.maxTodayRaw, todayKey);

  const healthChart = dailyHealth.map((d) => ({
    label: d.date.slice(5),
    亮屏: Math.round((d.screenMinutes / 60) * 10) / 10,
    解锁: d.unlocks,
  }));

  return (
    <SubpageShell title="用眼日报与 20-20-20" subtitle="连续亮屏远眺提醒与近 7 天真实屏幕统计" theme={theme}>
      {/* 1. 20-20-20 远眺提醒 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Eye className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">20-20-20 远眺提醒</h3>
              <p className="text-[10px] text-slate-400">连续亮屏满 20 分钟轻提醒远眺 20 秒，滤镜关闭也可独立运行</p>
            </div>
          </div>
          <Switch
            checked={rest.enabled}
            onChange={() => void toggleRest()}
            ariaLabel="开关 20-20-20 远眺提醒"
            onClass="bg-sky-500"
          />
        </div>
        {rest.enabled && maxToday !== null && (
          <p className="text-[11px] text-slate-300">
            今日最长连续用屏 <span className="text-amber-300 font-bold">{maxToday} 分钟</span>
            {maxToday >= 20 ? '——多起来看看远处 👀' : ''}
          </p>
        )}
        {!native && (
          <p className="text-[10px] text-slate-400">安装 Android APK 后可基于系统亮熄屏事件真实计时。</p>
        )}
      </div>

      {/* 2. 近 7 天用眼日报 */}
      {native && dailyHealth.length > 0 ? (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-300" />
            <h3 className="text-sm font-bold text-white">用眼日报</h3>
            <span className="text-[10px] text-slate-400 font-mono">近 7 天</span>
          </div>
          {todayHealth && (
            <div className="grid grid-cols-2 gap-2.5">
              <StatCard
                theme={theme}
                label="今日屏幕时间"
                value={<DurationValue minutes={todayHealth.screenMinutes} />}
                valueClassName="text-white"
              />
              <StatCard
                theme={theme}
                label={todayHealth.unlockSource === 'screen' ? '今日亮屏次数' : '今日解锁'}
                value={todayHealth.unlocks}
                valueClassName={theme.accentText}
              />
            </div>
          )}
          <Suspense fallback={<div className="w-full rounded-xl bg-white/5 animate-pulse" style={{ height: 120 }} />}>
            <EyeHealthChart data={healthChart} accentHex={theme.accentHex} />
          </Suspense>
        </div>
      ) : (
        <EmptyState
          theme={theme}
          illustration="screen-time"
          title={native ? '用眼日报还在积累' : '安装 APK 查看用眼日报'}
          hint={native ? '开启使用情况访问后，这里会呈现每日真实亮屏时长与解锁次数' : '网页端不采集本机屏幕使用统计'}
          compact
        />
      )}
    </SubpageShell>
  );
};
