import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Fish, MoonStar, Search } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { Switch } from '../../shared/ui';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../../features/sleep/store/sleepStore';
import { petSayFingerprint } from '../../features/pet/utils/petMoments';
import { subscribeAppResume } from '../../shared/utils/appResume';
import { tapTick } from '../../shared/utils/haptics';
import {
  getInstalledAppsForAdSkip,
  type AdSkipInstalledApp,
} from '../../features/extensions/ad-skip/adSkip';
import {
  BUILTIN_STIMULUS_APPS,
  buildPetSayLines,
  getBubbleEvery,
  getCachedLlmSay,
  getPetSkin,
  getPetStimulusGuard,
  isPetEnabled,
  isPetNative,
  petOpenPermissionSettings,
  petPermissionGranted,
  savePetStimulusGuard,
  setBubbleEvery,
  setPetSkin,
  startPet,
  stopPet,
  syncPet,
  syncPetEnabledFromNative,
  type PetStimulusGuardConfig,
  type StimulusThresholdMin,
} from '../../features/pet/utils/petOverlay';

const INITIAL_APP_LIMIT = 40;
const BUILTIN_PKG_SET = new Set<string>(BUILTIN_STIMULUS_APPS.map((a) => a.pkg));

export const PetSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);

  const petNative = isPetNative();
  const [petOn, setPetOn] = useState(() => isPetEnabled());
  const [petGranted, setPetGranted] = useState(true);
  const [petBusy, setPetBusy] = useState(false);
  const [petHint, setPetHint] = useState<string | null>(null);
  const [petEvery, setPetEvery] = useState(() => getBubbleEvery());
  const [petSkin, setPetSkinState] = useState(() => getPetSkin());
  const [stimGuard, setStimGuard] = useState<PetStimulusGuardConfig>(() => getPetStimulusGuard());

  // 本机任意应用搜索选择器（深夜刷屏提醒不再写死 8 款）
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [installedApps, setInstalledApps] = useState<AdSkipInstalledApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appQuery, setAppQuery] = useState('');
  const [showAllApps, setShowAllApps] = useState(false);

  // 挂载及从后台/系统权限页/磁贴切回时，双向对齐权限与原生真实开关状态
  useEffect(() => {
    if (!petNative) return;
    const syncNative = () => {
      void petPermissionGranted().then(setPetGranted);
      void syncPetEnabledFromNative().then(setPetOn);
    };
    syncNative();
    return subscribeAppResume(syncNative);
  }, [petNative]);

  // 若用户已添加自定义包名，静默拉一次本机应用以展示可读应用名
  useEffect(() => {
    if (!petNative || installedApps.length > 0) return;
    const hasCustom = stimGuard.pkgs.some((p) => !BUILTIN_PKG_SET.has(p));
    if (!hasCustom) return;
    void getInstalledAppsForAdSkip().then(setInstalledApps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petNative]);

  const petSay =
    getCachedLlmSay(userProfile.aiConfig, petSayFingerprint(records, userProfile)) ??
    buildPetSayLines(records, userProfile);

  const handlePetSkinChange = (skin: string) => {
    setPetSkinState(skin);
    setPetSkin(skin);
    if (petOn) void syncPet(records, userProfile);
  };

  const handlePetEveryChange = (next: number) => {
    const v = Math.max(1, Math.min(20, next));
    setPetEvery(v);
    setBubbleEvery(v);
    if (petOn) void syncPet(records, userProfile);
  };

  const updateStimulusGuard = (patch: Partial<PetStimulusGuardConfig>) => {
    const next = { ...stimGuard, ...patch };
    setStimGuard(next);
    void savePetStimulusGuard(next, userProfile);
  };

  const toggleStimulusPkg = (pkg: string) => {
    tapTick();
    const has = stimGuard.pkgs.includes(pkg);
    const nextPkgs = has
      ? stimGuard.pkgs.filter((p) => p !== pkg)
      : [...stimGuard.pkgs, pkg];
    updateStimulusGuard({ pkgs: nextPkgs });
  };

  const handleToggleAppPicker = async () => {
    tapTick();
    const next = !appPickerOpen;
    setAppPickerOpen(next);
    if (next && installedApps.length === 0 && petNative) {
      setAppsLoading(true);
      try {
        const list = await getInstalledAppsForAdSkip();
        setInstalledApps(list);
      } finally {
        setAppsLoading(false);
      }
    }
  };

  const labelByPkg = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of BUILTIN_STIMULUS_APPS) map.set(a.pkg, a.label);
    for (const a of installedApps) map.set(a.pkg, a.label);
    return map;
  }, [installedApps]);

  const customSelectedPkgs = useMemo(
    () => stimGuard.pkgs.filter((p) => !BUILTIN_PKG_SET.has(p)),
    [stimGuard.pkgs],
  );

  const matchedApps = useMemo(() => {
    const q = appQuery.trim().toLowerCase();
    if (!q) return installedApps;
    return installedApps.filter(
      (a) => a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q),
    );
  }, [installedApps, appQuery]);

  const visibleApps = useMemo(() => {
    if (appQuery.trim() || showAllApps) return matchedApps;
    return matchedApps.slice(0, INITIAL_APP_LIMIT);
  }, [matchedApps, appQuery, showAllApps]);

  const handlePetToggle = async (next: boolean) => {
    if (!petNative) return;
    setPetBusy(true);
    try {
      if (next) {
        const res = await startPet(records, userProfile);
        if (res.needPermission) {
          setPetGranted(false);
          setPetOn(false);
          return;
        }
        setPetOn(res.ok);
        if (res.ok) {
          setPetGranted(true);
          setPetHint(null);
        } else if (!res.needPermission) {
          setPetHint('桌宠启动失败，请重试或检查系统设置');
        }
      } else {
        await stopPet();
        setPetOn(false);
        setPetHint(null);
      }
    } finally {
      setPetBusy(false);
    }
  };

  return (
    <SubpageShell title="大肥鱼桌宠" subtitle="桌面悬浮陪伴、4键快捷扇面与深夜刷屏提醒" theme={theme}>
      {/* 1. 大肥鱼桌宠主卡 */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div
              className={`w-9 h-9 rounded-2xl ${theme.accentText} flex items-center justify-center border ${theme.accentBorder} shrink-0`}
              style={{ background: `${theme.accentHex}1f` }}
            >
              <Fish className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">大肥鱼桌宠</h3>
              <p className="text-[10px] text-slate-400 truncate" aria-live="polite">
                {petNative
                  ? petOn
                    ? '常驻桌面 · 点她弹消息 / 护眼 / 跳广告 / 缩放菜单'
                    : '已关闭（也可在控制中心磁贴一键唤出）'
                  : '网页预览不可用，安装 APK 后生效'}
              </p>
            </div>
          </div>
          {petNative && (
            <Switch
              checked={petOn}
              disabled={petBusy}
              onChange={(next) => void handlePetToggle(next)}
              ariaLabel="开启或关闭大肥鱼桌宠"
              onClass={theme.accentBg}
            />
          )}
        </div>

        {petHint && (
          <p role="status" className="px-5 pb-3 text-[10px] text-amber-300/90 leading-relaxed">
            {petHint}
          </p>
        )}

        <div className="px-5 pb-5 pt-3 border-t border-slate-700/60 space-y-4">
          {/* 播报词预览 */}
          <details className="rounded-2xl bg-slate-900/60 border border-slate-700/60 p-3.5">
            <summary className={`text-[10px] font-bold ${theme.accentText} cursor-pointer select-none`}>
              傲娇播报预览（{petSay.length} 条）
            </summary>
            <div className="space-y-1.5 pt-2">
              {petSay.slice(0, 4).map((line: string, i: number) => (
                <p key={i} className="text-[11px] text-slate-300 leading-relaxed">
                  {line}
                </p>
              ))}
            </div>
          </details>

          {/* 换装 */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold text-white">大肥鱼服装</p>
            <div className="flex gap-1.5 shrink-0">
              {['default', 'sakura'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handlePetSkinChange(s)}
                  className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all cursor-pointer active:scale-95 ${
                    petSkin === s
                      ? `${theme.accentText} border ${theme.accentBorder}`
                      : 'bg-slate-800 border-slate-600 text-slate-400'
                  }`}
                  style={petSkin === s ? { background: `${theme.accentHex}14` } : undefined}
                >
                  {s === 'default' ? '常服' : '樱花'}
                </button>
              ))}
            </div>
          </div>

          {/* 播报频率 */}
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-white">傲娇播报频率</p>
              <p className="text-[10px] text-slate-400">每 {petEvery} 次点击播报一次</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                aria-label="减少播报频率"
                onClick={() => handlePetEveryChange(petEvery - 1)}
                disabled={petEvery <= 1}
                className="w-10 h-10 rounded-lg bg-slate-700/70 text-slate-200 text-sm font-black disabled:opacity-30 cursor-pointer active:scale-90 transition-transform"
              >
                −
              </button>
              <span className={`w-6 text-center text-xs font-black ${theme.accentText}`}>{petEvery}</span>
              <button
                type="button"
                aria-label="增加播报频率"
                onClick={() => handlePetEveryChange(petEvery + 1)}
                disabled={petEvery >= 20}
                className="w-10 h-10 rounded-lg bg-slate-700/70 text-slate-200 text-sm font-black disabled:opacity-30 cursor-pointer active:scale-90 transition-transform"
              >
                ＋
              </button>
            </div>
          </div>

          {petNative && !petGranted && (
            <button
              type="button"
              onClick={() => void petOpenPermissionSettings()}
              className={`w-full py-2.5 rounded-xl ${theme.accentText} border ${theme.accentBorder} text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform`}
              style={{ background: `${theme.accentHex}1a` }}
            >
              需要悬浮窗权限 · 前往系统设置授权
            </button>
          )}
        </div>
      </div>

      {/* 2. 深夜刷屏超时大肥鱼轻提醒 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <MoonStar className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">深夜刷屏超时提醒</h3>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                夜间（{userProfile.targetBedtime}–{userProfile.targetWakeTime}）连刷超时后大肥鱼轻吐气泡劝睡，每晚最多 2 次
              </p>
            </div>
          </div>
          <Switch
            checked={stimGuard.enabled}
            onChange={(next) => updateStimulusGuard({ enabled: next })}
            ariaLabel="开启或关闭深夜刷屏超时提醒"
            onClass={theme.accentBg}
          />
        </div>

        {stimGuard.enabled && (
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-200">连续刷屏提醒阈值</p>
              <div className="grid grid-cols-3 gap-2">
                {([15, 20, 30] as StimulusThresholdMin[]).map((min) => {
                  const active = stimGuard.thresholdMin === min;
                  return (
                    <button
                      key={min}
                      type="button"
                      aria-pressed={active}
                      onClick={() => updateStimulusGuard({ thresholdMin: min })}
                      className={`py-2 rounded-xl text-xs font-bold border cursor-pointer active:scale-95 transition-all ${
                        active
                          ? `${theme.accentText} border ${theme.accentBorder}`
                          : 'bg-slate-800 border-slate-600 text-slate-400'
                      }`}
                      style={active ? { background: `${theme.accentHex}18` } : undefined}
                    >
                      {min} 分钟
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold text-slate-200">监控高刺激应用</p>
                <span className="text-[10px] text-slate-400 font-mono">
                  已选 {stimGuard.pkgs.length} 款
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BUILTIN_STIMULUS_APPS.map((app) => {
                  const selected = stimGuard.pkgs.includes(app.pkg);
                  return (
                    <button
                      key={app.pkg}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleStimulusPkg(app.pkg)}
                      className={`px-3 py-1.5 rounded-full text-[11px] font-bold border cursor-pointer active:scale-95 transition-all ${
                        selected
                          ? `${theme.accentText} border ${theme.accentBorder}`
                          : 'bg-slate-800/80 border-slate-600 text-slate-400'
                      }`}
                      style={selected ? { background: `${theme.accentHex}16` } : undefined}
                    >
                      {app.label}
                    </button>
                  );
                })}
                {customSelectedPkgs.map((pkg) => {
                  const displayName = labelByPkg.get(pkg) ?? pkg;
                  return (
                    <button
                      key={pkg}
                      type="button"
                      aria-pressed={true}
                      aria-label={`移除深夜提醒应用 ${displayName}`}
                      onClick={() => toggleStimulusPkg(pkg)}
                      className={`px-3 py-1.5 rounded-full text-[11px] font-bold border cursor-pointer active:scale-95 transition-all flex items-center gap-1 ${theme.accentText} ${theme.accentBorder}`}
                      style={{ background: `${theme.accentHex}16` }}
                    >
                      <span>{displayName}</span>
                      <span className="opacity-70">×</span>
                    </button>
                  );
                })}
              </div>

              {petNative && (
                <div className="pt-1 space-y-2.5">
                  <button
                    type="button"
                    onClick={() => void handleToggleAppPicker()}
                    aria-expanded={appPickerOpen}
                    className={`w-full py-2.5 px-3.5 rounded-2xl border ${theme.cardInnerBorder} ${theme.cardInnerBg} text-xs font-bold text-slate-200 flex items-center justify-between cursor-pointer active:scale-[0.99] transition-transform`}
                  >
                    <span className="flex items-center gap-2">
                      <Search className={`w-3.5 h-3.5 ${theme.accentText}`} />
                      搜索添加任意本机应用
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${appPickerOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {appPickerOpen && (
                    <div className="space-y-2">
                      <input
                        type="search"
                        value={appQuery}
                        onChange={(e) => setAppQuery(e.target.value)}
                        placeholder="输入应用名或包名搜索本机应用…"
                        aria-label="搜索深夜刷屏监控应用"
                        className={`w-full px-3.5 py-2 rounded-xl bg-slate-900/80 border ${theme.cardInnerBorder} text-xs text-white placeholder:text-slate-500 focus:outline-none ${theme.focusRing}`}
                      />
                      {appsLoading ? (
                        <p className="text-[11px] text-slate-400 py-2 text-center">正在读取本机应用…</p>
                      ) : visibleApps.length === 0 ? (
                        <p className="text-[11px] text-slate-400 py-2 text-center">没有找到匹配的应用</p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-[10px] text-slate-400 px-1">
                            <span>
                              {appQuery.trim()
                                ? `匹配 ${matchedApps.length} 款应用`
                                : `已显示 ${visibleApps.length} / ${matchedApps.length} 款本机应用`}
                            </span>
                            {!appQuery.trim() && matchedApps.length > INITIAL_APP_LIMIT && (
                              <button
                                type="button"
                                onClick={() => setShowAllApps((v) => !v)}
                                className={`${theme.accentText} font-bold cursor-pointer`}
                              >
                                {showAllApps ? '收起列表' : `展开全部 (${matchedApps.length})`}
                              </button>
                            )}
                          </div>
                          <div className="max-h-60 overflow-y-auto rounded-2xl border border-slate-700/60 divide-y divide-slate-700/40 bg-slate-900/50">
                            {visibleApps.map((app) => {
                              const selected = stimGuard.pkgs.includes(app.pkg);
                              return (
                                <div key={app.pkg} className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-xs font-bold text-white truncate">{app.label}</p>
                                    <p className="text-[9px] font-mono text-slate-400 truncate">{app.pkg}</p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => toggleStimulusPkg(app.pkg)}
                                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border shrink-0 cursor-pointer active:scale-95 transition-all ${
                                      selected
                                        ? `${theme.accentText} ${theme.accentBorder}`
                                        : 'bg-slate-800 border-slate-600 text-slate-300'
                                    }`}
                                    style={selected ? { background: `${theme.accentHex}16` } : undefined}
                                  >
                                    {selected ? '已监控' : '加入提醒'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SubpageShell>
  );
};
