import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, MousePointerClick } from 'lucide-react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { isNativePlatform } from '../../sleep/utils/nativeAlarmScheduler';
import { tapTick } from '../../../shared/utils/haptics';
import {
  copyAdSkipDiag,
  getAdSkipStats,
  getAdSkipStatus,
  getShizukuStatus,
  isBatteryOptimizationIgnored,
  openAdSkipAccessibilitySettings,
  openShizukuApp,
  repairAdSkipWithShizuku,
  requestBatteryOptimizationExemption,
  requestShizukuPermission,
  setAdSkipEnabled,
  type AdSkipAppStat,
  type AdSkipStatus,
  type ShizukuStatus,
} from './adSkip';

/**
 * 可选工具扩展：摇一摇 / 开屏广告跳过 + Shizuku 守护。
 * 与核心「睡眠 / 护眼 / 桌宠」解耦，独立承接高权限无障碍配置、命中统计与诊断日志。
 */
export const AdSkipSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);

  const adSkipNative = isNativePlatform();
  const [adSkip, setAdSkip] = useState<AdSkipStatus>({
    enabled: false,
    serviceEnabled: false,
    hits: 0,
    diag: [],
  });
  const [adSkipBusy, setAdSkipBusy] = useState(false);
  const [adSkipOpen, setAdSkipOpen] = useState(true);
  const adSkipPollRef = useRef<number | null>(null);

  const [shizuku, setShizuku] = useState<ShizukuStatus>({
    installed: false,
    running: false,
    granted: false,
    version: 0,
  });
  const [shizukuBusy, setShizukuBusy] = useState(false);
  const [shizukuMsg, setShizukuMsg] = useState<string | null>(null);
  const [adSkipMsg, setAdSkipMsg] = useState<string | null>(null);
  const [batteryIgnored, setBatteryIgnored] = useState<boolean | null>(null);
  const [adSkipStats, setAdSkipStats] = useState<AdSkipAppStat[]>([]);

  const refreshAdSkip = async () => {
    const [st, stats] = await Promise.all([getAdSkipStatus(), getAdSkipStats()]);
    setAdSkip(st);
    setAdSkipStats(stats);
    return st;
  };

  const handleCopyDiag = async () => {
    const ok = await copyAdSkipDiag();
    setAdSkipMsg(ok ? '诊断信息已复制，粘贴发给开发者即可' : '复制失败，请截图运行日志代替');
  };

  const refreshSystemGuard = async () => {
    const [sh, battery] = await Promise.all([
      getShizukuStatus(),
      isBatteryOptimizationIgnored(),
    ]);
    setShizuku(sh);
    setBatteryIgnored(battery);
  };

  useEffect(() => {
    if (!adSkipNative) return;
    void refreshAdSkip();
    void refreshSystemGuard();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void refreshAdSkip();
        void refreshSystemGuard();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (adSkipPollRef.current !== null) window.clearInterval(adSkipPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adSkipNative]);

  const handleAdSkipToggle = async () => {
    if (!adSkipNative || adSkipBusy) return;
    tapTick();
    const next = !adSkip.enabled;
    setAdSkipBusy(true);
    try {
      const st = await setAdSkipEnabled(next);
      setAdSkip(st);
      if (next && !st.serviceEnabled) {
        setAdSkipOpen(true);
        await openAdSkipAccessibilitySettings();
        if (adSkipPollRef.current !== null) window.clearInterval(adSkipPollRef.current);
        let tries = 0;
        adSkipPollRef.current = window.setInterval(async () => {
          tries += 1;
          const cur = await getAdSkipStatus();
          setAdSkip(cur);
          if (cur.serviceEnabled || tries >= 20) {
            if (adSkipPollRef.current !== null) window.clearInterval(adSkipPollRef.current);
            adSkipPollRef.current = null;
          }
        }, 2000);
      }
    } finally {
      setAdSkipBusy(false);
    }
  };

  const handleShizukuAuthorize = async () => {
    if (shizukuBusy) return;
    tapTick();
    setShizukuBusy(true);
    setShizukuMsg(null);
    try {
      const requested = await requestShizukuPermission();
      if (!requested) {
        setShizuku(await getShizukuStatus());
        setShizukuMsg('Shizuku 服务未运行：请先打开 Shizuku 并启动服务');
        return;
      }
      let current = await getShizukuStatus();
      for (let i = 0; i < 20 && !current.granted; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        current = await getShizukuStatus();
      }
      setShizuku(current);
      setShizukuMsg(
        current.granted ? '已获得 Shizuku 授权' : '尚未授权：请在弹出的系统对话框里选择允许',
      );
    } finally {
      setShizukuBusy(false);
    }
  };

  const handleShizukuRepair = async () => {
    if (shizukuBusy) return;
    tapTick();
    setShizukuBusy(true);
    setShizukuMsg(null);
    try {
      const result = await repairAdSkipWithShizuku();
      setShizukuMsg(result.ok ? '已通过 Shizuku 重新开启无障碍服务' : (result.reason ?? '修复失败'));
      setShizuku(await getShizukuStatus());
      let status = await getAdSkipStatus();
      for (let i = 0; i < 6 && result.ok && !status.serviceEnabled; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        status = await getAdSkipStatus();
      }
      setAdSkip(status);
    } finally {
      setShizukuBusy(false);
    }
  };

  const handleBatteryRequest = async () => {
    tapTick();
    const ignoring = await requestBatteryOptimizationExemption();
    setBatteryIgnored(ignoring);
    window.setTimeout(async () => {
      setBatteryIgnored(await isBatteryOptimizationIgnored());
    }, 1200);
  };

  const shizukuStatusText = !shizuku.installed
    ? '未安装（可选）'
    : !shizuku.running
      ? '未运行'
      : shizuku.granted
        ? '已授权'
        : '待授权';

  return (
    <SubpageShell
      title="摇一摇广告跳过"
      subtitle="可选工具扩展 · 独立于核心睡眠功能"
      theme={theme}
    >
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <MousePointerClick className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">摇一摇广告跳过</h3>
              <p className="text-[10px] text-slate-400 truncate">
                {adSkipNative ? '开屏与应用内广告的「跳过 / 关闭」自动点一下' : '安装 APK 后可用'}
              </p>
            </div>
          </div>
          {adSkipNative && (
            <button
              type="button"
              onClick={() => void handleAdSkipToggle()}
              disabled={adSkipBusy}
              aria-pressed={adSkip.enabled}
              aria-label="摇一摇广告跳过"
              className="relative inline-flex items-center cursor-pointer shrink-0 disabled:opacity-50"
            >
              <span
                className="block w-10 h-5 rounded-full transition-colors relative"
                style={{ background: adSkip.enabled ? theme.accentHex : '#475569' }}
              >
                <span
                  className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all"
                  style={{ left: adSkip.enabled ? '22px' : '2px' }}
                />
              </span>
            </button>
          )}
        </div>

        {adSkipNative && (
          <div className="px-5 pb-4 -mt-1 flex items-center justify-between gap-2 text-[10px]">
            <span className={adSkip.enabled && adSkip.serviceEnabled ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
              {adSkip.enabled ? (adSkip.serviceEnabled ? '已生效' : '待授权') : '已关闭'}
              <span className="text-slate-500 font-mono font-normal"> · 已跳过 {adSkip.hits} 次</span>
            </span>
            <button
              type="button"
              onClick={() => setAdSkipOpen((v) => !v)}
              aria-expanded={adSkipOpen}
              className="flex items-center gap-1 text-slate-400 font-bold cursor-pointer shrink-0"
            >
              设置
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${adSkipOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
        )}

        {adSkipNative && adSkip.enabled && !adSkip.serviceEnabled && (
          <button
            type="button"
            onClick={() => void openAdSkipAccessibilitySettings()}
            className="mx-5 mb-4 w-[calc(100%-2.5rem)] py-2.5 rounded-xl border border-amber-400/50 bg-amber-500/10 text-amber-200 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform"
          >
            无障碍服务未开启 · 点此开启
          </button>
        )}

        {adSkipNative && adSkipOpen && (
          <div className="px-5 pb-5 pt-3 border-t border-slate-700/60 space-y-2.5">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              只识别「跳过」控件，不读取输入内容。
            </p>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              重启/更新/省电清理后可能被关；点上方开关或下方按钮恢复。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleBatteryRequest()}
                className="flex-1 py-2 rounded-lg bg-slate-800/80 border border-slate-600 text-slate-200 text-[10px] font-bold cursor-pointer active:scale-95 transition-transform"
              >
                电池优化白名单
              </button>
              <button
                type="button"
                onClick={() => void openAdSkipAccessibilitySettings()}
                className="flex-1 py-2 rounded-lg bg-slate-800/80 border border-slate-600 text-slate-200 text-[10px] font-bold cursor-pointer active:scale-95 transition-transform"
              >
                无障碍设置
              </button>
            </div>
            {batteryIgnored !== null && (
              <p className={`text-[10px] ${batteryIgnored ? 'text-emerald-400' : 'text-slate-400'}`}>
                电池优化：{batteryIgnored ? '已豁免' : '未豁免'}
              </p>
            )}

            {adSkip.enabled && (
              <div className="pt-2 border-t border-slate-700/50 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-bold text-slate-300">运行日志</p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void handleCopyDiag()}
                      className="text-[10px] text-slate-400 underline cursor-pointer"
                    >
                      复制诊断
                    </button>
                    <button
                      type="button"
                      onClick={() => void refreshAdSkip()}
                      className="text-[10px] text-slate-400 underline cursor-pointer"
                    >
                      刷新
                    </button>
                  </div>
                </div>
                {adSkipStats.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-slate-400 font-mono pb-1">
                    {adSkipStats.slice(0, 5).map((s) => (
                      <span key={s.pkg} className="tabular-nums">
                        {s.label} ×{s.hits}
                      </span>
                    ))}
                  </div>
                )}
                {adSkip.diag.length === 0 ? (
                  <p className="text-[10px] text-slate-400 font-mono">
                    暂无记录——打开一个带广告的应用后再回来看
                  </p>
                ) : (
                  <pre className="text-[9px] leading-[1.5] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto bg-black/30 rounded-lg p-2 border border-slate-700/50">
{adSkip.diag.join('\n')}
                  </pre>
                )}
                {adSkipMsg && <p className="text-[10px] text-emerald-300 leading-relaxed">{adSkipMsg}</p>}
              </div>
            )}

            <div className="pt-2 border-t border-slate-700/50 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-slate-300">
                    Shizuku 守护
                    <span className="ml-1 font-normal text-slate-500">可选</span>
                  </p>
                  <p className={`text-[10px] ${shizuku.granted ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {shizukuStatusText}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={shizukuBusy}
                  onClick={() => {
                    tapTick();
                    if (!shizuku.installed || !shizuku.running) {
                      void openShizukuApp();
                    } else if (!shizuku.granted) {
                      void handleShizukuAuthorize();
                    } else {
                      void handleShizukuRepair();
                    }
                  }}
                  className={`shrink-0 px-3 py-2 rounded-lg text-[10px] font-bold cursor-pointer active:scale-95 transition-transform disabled:opacity-50 ${
                    shizuku.granted
                      ? 'bg-emerald-600/20 border border-emerald-400/40 text-emerald-200'
                      : 'bg-slate-800/80 border border-slate-600 text-slate-200'
                  }`}
                >
                  {shizukuBusy
                    ? '处理中…'
                    : !shizuku.installed
                      ? '了解'
                      : !shizuku.running
                        ? '打开'
                        : !shizuku.granted
                          ? '授权'
                          : '修复'}
                </button>
              </div>
              {shizukuMsg && <p className="text-[10px] text-amber-300 leading-relaxed">{shizukuMsg}</p>}
              <p className="text-[9px] text-slate-400 leading-relaxed">
                需保持 Shizuku 运行；重启后未启动则不可用。
              </p>
            </div>
            <p className="text-[9px] text-slate-400 leading-relaxed">
              更稳：允许自启动 + 锁定最近任务；开关变灰需在应用信息里允许受限设置。
            </p>
          </div>
        )}

        {!adSkipNative && (
          <div className="px-5 pb-5 pt-3 border-t border-slate-700/60 space-y-2">
            <p className="text-[11px] text-slate-300 leading-relaxed">
              只识别「跳过」控件，不读取输入内容，不联网上报任何记录。
            </p>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              当前为网页预览环境；在 Android 设备安装 APK 后可启用无障碍跳过与 Shizuku 守护。
            </p>
          </div>
        )}
      </div>
    </SubpageShell>
  );
};
