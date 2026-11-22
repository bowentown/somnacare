import React, { useMemo } from 'react';
import { Activity, Eye, Fish, LayoutGrid, Moon, PlusCircle, Wind } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../../features/sleep/store/sleepStore';
import { handleDeepLink, showToast } from '../../shared/store/uiStore';
import { DEFAULT_EYE_CARE } from '../../shared/types/sleep';
import { loadTravelState } from '../../features/pet/services/travelService';
import { buildWidgetSnapshot, type WeekDotStatus, type WidgetKind } from '../../features/widgets/widgetSnapshot';
import { requestPinNativeWidget } from '../../features/widgets/syncWidgets';
import { isNativePlatform } from '../../shared/native/nativeBridge';

function dotBgClass(status: WeekDotStatus): string {
  switch (status) {
    case 'G':
      return 'bg-emerald-500/85 text-slate-950';
    case 'Y':
      return 'bg-amber-400/85 text-slate-950';
    case 'R':
      return 'bg-rose-500/85 text-white';
    default:
      return 'bg-slate-800/90 text-slate-400';
  }
}

function fmtDuration(min: number | null): string {
  if (min === null || min <= 0) return '暂无记录';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * 桌面小组件中心（Phase 4 完整版）：
 * 4 款 Android 桌面小组件实时快照预览 + 一键添加到桌面（Android 8+）+ DeepLink 快捷直达。
 */
export const WidgetsSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);
  const native = isNativePlatform();

  const snapshot = useMemo(
    () => buildWidgetSnapshot(records, userProfile, loadTravelState()),
    [records, userProfile],
  );

  const handlePin = async (kind: WidgetKind, name: string) => {
    const res = await requestPinNativeWidget(kind);
    if (!res.native) {
      showToast(`请在手机桌面长按空白处 → 小组件 → 选择「极光睡眠 · ${name}」`);
      return;
    }
    if (res.requested) {
      showToast(`已发送添加请求，请在系统弹窗确认固定「${name}」`);
    } else if (!res.supported) {
      showToast('当前桌面启动器不支持应用内固定，请长按手机桌面手动添加');
    } else {
      showToast('未能拉起系统固定弹窗，请长按手机桌面手动添加');
    }
  };

  const handleToggleEyeCarePreview = () => {
    const current = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
    const nextEnabled = !current.enabled;
    updateProfile((prev) => ({
      ...prev,
      eyeCare: { ...(prev.eyeCare ?? DEFAULT_EYE_CARE), enabled: nextEnabled },
    }));
    showToast(nextEnabled ? '已开启护眼滤镜' : '已关闭护眼滤镜');
  };

  const latestDur = fmtDuration(snapshot.lastDurationMin);
  const debtLabel =
    snapshot.sleepDebtMin > 0
      ? `近 7 晚缺觉 ${fmtDuration(snapshot.sleepDebtMin)}`
      : '近 7 晚睡眠债平衡';

  return (
    <SubpageShell title="桌面小组件" subtitle="4 款主题联动小组件 · 数据实时同步" theme={theme}>
      {/* 1. 2×1 睡眠速览卡 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <LayoutGrid className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">2×1 睡眠速览卡</h3>
              <p className="text-[10px] text-slate-400">昨晚评分、时长、连胜与今晚目标</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handlePin('score', '睡眠评分 (2×1)')}
            className="px-2.5 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-400/35 text-indigo-200 text-[11px] font-bold flex items-center gap-1 active:scale-95 transition-transform shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            添加到桌面
          </button>
        </div>

        <button
          type="button"
          onClick={() => handleDeepLink('today')}
          className="w-full text-left rounded-2xl p-4 border border-slate-700/70 flex items-center justify-between gap-3 active:scale-95 transition-transform"
          style={{
            background: `linear-gradient(135deg, rgba(15,23,42,0.94), ${theme.accentHex}24)`,
          }}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] text-slate-300 font-bold">
              <Moon className="w-3.5 h-3.5" style={{ color: theme.accentHex }} />
              <span>极光睡眠</span>
            </div>
            <p className="text-lg font-black font-display text-white tabular-nums">{latestDur}</p>
            <p className="text-[10px] text-slate-400">
              {snapshot.streakNights > 0
                ? `连续达标 ${snapshot.streakNights} 晚 · 目标 ${snapshot.targetBedtime}`
                : `目标就寝 ${snapshot.targetBedtime} · 醒来 ${userProfile.targetWakeTime}`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <span className="text-[10px] text-slate-400 block">最近评分</span>
            <span className={`text-2xl font-black font-display tabular-nums ${theme.accentText}`}>
              {snapshot.lastScore !== null ? snapshot.lastScore : '--'}
            </span>
          </div>
        </button>
      </div>

      {/* 2. 2×2 睡前快捷操作卡 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Wind className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">2×2 睡前快捷操作</h3>
              <p className="text-[10px] text-slate-400">一键入睡 · 呼吸引导 · 桌面直接切护眼</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handlePin('bedtime', '睡前快捷操作 (2×2)')}
            className="px-2.5 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-400/35 text-indigo-200 text-[11px] font-bold flex items-center gap-1 active:scale-95 transition-transform shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            添加到桌面
          </button>
        </div>

        <div
          className="rounded-2xl p-4 border border-slate-700/70 space-y-3"
          style={{
            background: `linear-gradient(135deg, rgba(15,23,42,0.94), ${theme.accentHex}20)`,
          }}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-slate-400 font-medium">今晚目标就寝</span>
            <span className={`text-2xl font-black font-display tabular-nums ${theme.accentText}`}>
              {snapshot.targetBedtime}
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleDeepLink('sleep/start')}
            className="w-full py-2 rounded-xl bg-slate-800/90 border border-slate-700/80 text-xs font-bold text-slate-100 active:scale-95 transition-transform"
          >
            🌙 一键入睡
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleDeepLink('intervention/wind-down')}
              className="py-2 rounded-xl bg-slate-800/90 border border-slate-700/80 text-[11px] font-bold text-slate-200 active:scale-95 transition-transform"
            >
              🫧 睡前呼吸
            </button>
            <button
              type="button"
              onClick={handleToggleEyeCarePreview}
              className={`py-2 rounded-xl border text-[11px] font-bold flex items-center justify-center gap-1 active:scale-95 transition-transform ${
                snapshot.eyeCareEnabled
                  ? 'bg-amber-500/25 border-amber-400/50 text-amber-200'
                  : 'bg-slate-800/90 border-slate-700/80 text-slate-300'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              {snapshot.eyeCareEnabled ? '护眼 开' : '护眼 关'}
            </button>
          </div>
        </div>
      </div>

      {/* 3. 4×2 近 7 晚节律卡 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Activity className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">4×2 7 晚睡眠节律</h3>
              <p className="text-[10px] text-slate-400">近 7 晚分档、SRI 规律度与睡眠债</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handlePin('rhythm', '7 晚睡眠节律 (4×2)')}
            className="px-2.5 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-400/35 text-indigo-200 text-[11px] font-bold flex items-center gap-1 active:scale-95 transition-transform shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            添加到桌面
          </button>
        </div>

        <button
          type="button"
          onClick={() => handleDeepLink('trends')}
          className="w-full text-left rounded-2xl p-4 border border-slate-700/70 space-y-3 active:scale-95 transition-transform"
          style={{
            background: `linear-gradient(135deg, rgba(15,23,42,0.94), ${theme.accentHex}1c)`,
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-100">近 7 晚睡眠节律</span>
            <span className={`text-xs font-black font-display tabular-nums ${theme.accentText}`}>
              {snapshot.sriScore !== null ? `SRI ${snapshot.sriScore}` : 'SRI --'}
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {snapshot.weekDots.map((dot) => (
              <div
                key={dot.dateKey}
                className={`h-8 rounded-lg flex flex-col items-center justify-center text-[10px] font-bold ${dotBgClass(dot.status)}`}
                title={`${dot.dateKey}${dot.score !== null ? ` · ${dot.score}分` : ' · 未记录'}`}
              >
                <span>{dot.label}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            {debtLabel}
            {snapshot.streakNights > 0 ? ` · 连续达标 ${snapshot.streakNights} 晚` : ' · 点击直达趋势页'}
          </p>
        </button>
      </div>

      {/* 4. 2×2 大肥鱼能量卡 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Fish className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">2×2 大肥鱼能量卡</h3>
              <p className="text-[10px] text-slate-400">旅行梦境能量与大肥鱼当下状态</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handlePin('pet', '大肥鱼能量卡 (2×2)')}
            className="px-2.5 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-400/35 text-indigo-200 text-[11px] font-bold flex items-center gap-1 active:scale-95 transition-transform shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            添加到桌面
          </button>
        </div>

        <button
          type="button"
          onClick={() => handleDeepLink('pet/codex')}
          className="w-full text-left rounded-2xl p-4 border border-slate-700/70 space-y-2.5 active:scale-95 transition-transform"
          style={{
            background: `linear-gradient(135deg, rgba(15,23,42,0.94), ${theme.accentHex}24)`,
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-100">🐋 大肥鱼</span>
            <span className={`text-xs font-black font-display tabular-nums ${theme.accentText}`}>
              {snapshot.petEnergyPct}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${snapshot.petEnergyPct}%`,
                backgroundColor: theme.accentHex,
              }}
            />
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed">{snapshot.petMood}</p>
          <p className="text-[10px] text-slate-500">点击直达旅行明信片图鉴 →</p>
        </button>
      </div>

      <p className="text-[10px] text-slate-500 leading-relaxed px-1">
        {native
          ? '说明：Android 8.0+ 支持点击各卡片「添加到桌面」直接呼出系统固定弹窗；若厂商桌面屏蔽应用内请求，可长按桌面空白处手动添加。'
          : '提示：网页预览可点击任意卡片体验 DeepLink 快捷跳转；安装 Android APK 后即可添加到手机桌面并与护眼/主题实时同步。'}
      </p>
    </SubpageShell>
  );
};
