import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MousePointerClick, Search, ShieldOff } from 'lucide-react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../../shared/store/profileStore';
import { isNativePlatform } from '../../sleep/utils/nativeAlarmScheduler';
import { tapTick } from '../../../shared/utils/haptics';
import {
  copyAdSkipDiag,
  getAdSkipStats,
  getAdSkipStatus,
  getInstalledAppsForAdSkip,
  getShizukuStatus,
  isBatteryOptimizationIgnored,
  openAdSkipAccessibilitySettings,
  openShizukuApp,
  repairAdSkipWithShizuku,
  requestBatteryOptimizationExemption,
  requestShizukuPermission,
  setAdSkipEnabled,
  setAdSkipPackageExcluded,
  type AdSkipAppStat,
  type AdSkipInstalledApp,
  type AdSkipStatus,
  type ShizukuStatus,
} from './adSkip';

/**
 * 摇一摇 / 开屏广告跳过 + 按应用排除名单 + Shizuku 守护。
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
    excludedPkgs: [],
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

  // 应用搜索加白面板状态
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [installedApps, setInstalledApps] = useState<AdSkipInstalledApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appQuery, setAppQuery] = useState('');

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

  const handleTogglePkgExcluded = async (pkg: string, nextExcluded: boolean) => {
    tapTick();
    const updated = await setAdSkipPackageExcluded(pkg, nextExcluded);
    setAdSkip((prev) => ({ ...prev, excludedPkgs: updated }));
    setAdSkipStats((prev) =>
      prev.map((s) => (s.pkg === pkg ? { ...s, excluded: nextExcluded } : s)),
    );
    setInstalledApps((prev) =>
      prev.map((a) => (a.pkg === pkg ? { ...a, excluded: nextExcluded } : a)),
    );
  };

  const handleToggleAppPicker = async () => {
    tapTick();
    const next = !appPickerOpen;
    setAppPickerOpen(next);
    if (next && installedApps.length === 0 && adSkipNative) {
      setAppsLoading(true);
      try {
        const list = await getInstalledAppsForAdSkip();
        setInstalledApps(list);
      } finally {
        setAppsLoading(false);
      }
    }
  };

  const excludedSet = useMemo(() => new Set(adSkip.excludedPkgs), [adSkip.excludedPkgs]);

  const labelByPkg = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of adSkipStats) map.set(s.pkg, s.label);
    for (const a of installedApps) map.set(a.pkg, a.label);
    return map;
  }, [adSkipStats, installedApps]);

  const filteredApps = useMemo(() => {
    const q = appQuery.trim().toLowerCase();
    if (!q) return installedApps.slice(0, 40);
    return installedApps
      .filter((a) => a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q))
      .slice(0, 40);
  }, [installedApps, appQuery]);

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
      subtitle="开屏与应用内跳过、按应用排除名单与 Shizuku 守护"
      theme={theme}
    >
      {/* 1. 主开关与系统保活 */}
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
              只识别「跳过」控件，不读取输入内容。下拉控制中心可添加「广告跳过」磁贴，或点大肥鱼悬浮窗扇形菜单秒停/恢复。
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
              当前为网页预览环境；在 Android 设备安装 APK 后可启用无障碍跳过、按应用排除名单与 Shizuku 守护。
            </p>
          </div>
        )}
      </div>

      {/* 2. 按应用精细管控（双入口：命中榜直停 + 搜索本机应用加入不跳名单） */}
      {adSkipNative && (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
                <ShieldOff className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-black text-white">排除不跳名单</h3>
                <p className="text-[10px] text-slate-400 truncate">遇到误触应用一键停用，也可提前把银行/政务类加入不跳</p>
              </div>
            </div>
            <span className="text-[10px] font-mono text-slate-400 shrink-0">
              已排除 {adSkip.excludedPkgs.length}
            </span>
          </div>

          {/* 当前已排除应用胶囊 */}
          {adSkip.excludedPkgs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {adSkip.excludedPkgs.map((pkg) => (
                <button
                  key={pkg}
                  type="button"
                  onClick={() => void handleTogglePkgExcluded(pkg, false)}
                  aria-label={`恢复 ${labelByPkg.get(pkg) ?? pkg} 的广告跳过`}
                  className="px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-400/50 text-amber-200 text-[10px] font-bold flex items-center gap-1 cursor-pointer active:scale-95 transition-transform"
                >
                  <span>{labelByPkg.get(pkg) ?? pkg}</span>
                  <span className="text-amber-300/80">× 恢复</span>
                </button>
              ))}
            </div>
          )}

          {/* 入口 ①：按应用命中榜直接停用 */}
          {adSkipStats.length > 0 && (
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl divide-y divide-slate-700/50 overflow-hidden`}>
              <div className="px-3.5 py-2 text-[10px] font-bold text-slate-400">
                按应用命中榜
              </div>
              {adSkipStats.slice(0, 8).map((s) => {
                const isEx = excludedSet.has(s.pkg) || s.excluded === true;
                return (
                  <div key={s.pkg} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-white truncate">{s.label}</p>
                      <p className="text-[10px] font-mono text-slate-400 truncate">
                        累计跳过 {s.hits} 次
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleTogglePkgExcluded(s.pkg, !isEx)}
                      className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold border shrink-0 cursor-pointer active:scale-95 transition-all ${
                        isEx
                          ? 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                          : 'bg-slate-800 border-slate-600 text-slate-200'
                      }`}
                    >
                      {isEx ? '已停用 · 恢复' : '在此应用停用'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 入口 ②：搜索本机应用加入不跳名单 */}
          <button
            type="button"
            onClick={() => void handleToggleAppPicker()}
            aria-expanded={appPickerOpen}
            className={`w-full py-2.5 px-3.5 rounded-2xl border ${theme.cardInnerBorder} ${theme.cardInnerBg} text-xs font-bold text-slate-200 flex items-center justify-between cursor-pointer active:scale-[0.99] transition-transform`}
          >
            <span className="flex items-center gap-2">
              <Search className={`w-3.5 h-3.5 ${theme.accentText}`} />
              搜索本机应用加入不跳名单
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${appPickerOpen ? 'rotate-180' : ''}`} />
          </button>

          {appPickerOpen && (
            <div className="space-y-2.5">
              <input
                type="search"
                value={appQuery}
                onChange={(e) => setAppQuery(e.target.value)}
                placeholder="输入应用名或包名筛选…"
                aria-label="搜索本机应用"
                className={`w-full px-3.5 py-2 rounded-xl bg-slate-900/80 border ${theme.cardInnerBorder} text-xs text-white placeholder:text-slate-500 focus:outline-none ${theme.focusRing}`}
              />
              {appsLoading ? (
                <p className="text-[11px] text-slate-400 py-2 text-center">正在读取本机应用…</p>
              ) : filteredApps.length === 0 ? (
                <p className="text-[11px] text-slate-400 py-2 text-center">没有找到匹配的应用</p>
              ) : (
                <div className="max-h-56 overflow-y-auto rounded-2xl border border-slate-700/60 divide-y divide-slate-700/40 bg-slate-900/50">
                  {filteredApps.map((app) => {
                    const isEx = excludedSet.has(app.pkg);
                    return (
                      <div key={app.pkg} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-white truncate">{app.label}</p>
                          <p className="text-[9px] font-mono text-slate-500 truncate">{app.pkg}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleTogglePkgExcluded(app.pkg, !isEx)}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border shrink-0 cursor-pointer active:scale-95 transition-all ${
                            isEx
                              ? 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                              : 'bg-slate-800 border-slate-600 text-slate-300'
                          }`}
                        >
                          {isEx ? '已排除' : '加入不跳'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </SubpageShell>
  );
};
