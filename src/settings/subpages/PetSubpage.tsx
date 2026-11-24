import React, { useEffect, useState } from 'react';
import { Fish, MoonStar } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { Switch } from '../../shared/ui';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../../features/sleep/store/sleepStore';
import { petSayFingerprint } from '../../features/pet/utils/petMoments';
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
  type PetStimulusGuardConfig,
  type StimulusThresholdMin,
} from '../../features/pet/utils/petOverlay';

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

  useEffect(() => {
    if (!petNative) return;
    void petPermissionGranted().then(setPetGranted);
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
    const has = stimGuard.pkgs.includes(pkg);
    const nextPkgs = has
      ? stimGuard.pkgs.filter((p) => p !== pkg)
      : [...stimGuard.pkgs, pkg];
    updateStimulusGuard({ pkgs: nextPkgs });
  };

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

            <div className="space-y-1.5">
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
              </div>
            </div>
          </div>
        )}
      </div>
    </SubpageShell>
  );
};
