/**
 * 大肥鱼桌宠悬浮窗：Web 侧负责开关、播报词库与深夜刷屏超时轻提醒配置同步。
 *
 * 人设：DeepSeek 蓝色大肥鱼（社区共创）——聪明但懒、傲娇嘴甜、管用户叫"鱼片"。
 */
import type { SleepRecord, UserProfile } from '../../../shared/types/sleep';
import { petContext } from './petContext';
import { computeWeekReport } from '../../trends/utils/weekReport';
import { generatePetSayLinesLlm, getCachedLlmSay, petSayFingerprint } from './petMoments';
import { nativePlugin } from '../../../shared/native/nativeBridge';
export { getCachedLlmSay };

/** 桌宠原生插件（Phase 3 拆分为独立 PetOverlay 插件） */
const gemma = (): any | null => nativePlugin('PetOverlay');

export const isPetNative = (): boolean => gemma() != null;

const ENABLED_KEY = 'somnacare_pet_enabled';
export const BUBBLE_EVERY_KEY = 'somnacare_pet_bubble_every';
export const DEFAULT_BUBBLE_EVERY = 8;
const PET_SKIN_KEY = 'somnacare_pet_skin';
export const PET_STIMULUS_GUARD_KEY = 'somnacare_pet_stimulus_guard';

export const BUILTIN_STIMULUS_APPS = [
  { pkg: 'com.ss.android.ugc.aweme', label: '抖音' },
  { pkg: 'com.xingin.xhs', label: '小红书' },
  { pkg: 'tv.danmaku.bili', label: '哔哩哔哩' },
  { pkg: 'com.smile.gifmaker', label: '快手' },
  { pkg: 'com.sina.weibo', label: '微博' },
  { pkg: 'com.zhihu.android', label: '知乎' },
  { pkg: 'com.baidu.tieba', label: '百度贴吧' },
  { pkg: 'com.ss.android.article.news', label: '今日头条' },
] as const;

export type StimulusThresholdMin = 15 | 20 | 30;

export interface PetStimulusGuardConfig {
  enabled: boolean;
  thresholdMin: StimulusThresholdMin;
  pkgs: string[];
}

export const DEFAULT_PET_STIMULUS_GUARD: PetStimulusGuardConfig = {
  enabled: true,
  thresholdMin: 20,
  pkgs: [
    'com.ss.android.ugc.aweme',
    'com.xingin.xhs',
    'tv.danmaku.bili',
    'com.smile.gifmaker',
    'com.sina.weibo',
    'com.zhihu.android',
  ],
};

export function sanitizePetStimulusGuard(raw: unknown): PetStimulusGuardConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PET_STIMULUS_GUARD, pkgs: [...DEFAULT_PET_STIMULUS_GUARD.pkgs] };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_PET_STIMULUS_GUARD.enabled;
  const thresholdMin: StimulusThresholdMin =
    obj.thresholdMin === 15 || obj.thresholdMin === 20 || obj.thresholdMin === 30
      ? obj.thresholdMin
      : DEFAULT_PET_STIMULUS_GUARD.thresholdMin;
  const pkgs = Array.isArray(obj.pkgs)
    ? Array.from(
        new Set(
          obj.pkgs
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter(Boolean),
        ),
      )
    : [...DEFAULT_PET_STIMULUS_GUARD.pkgs];
  return { enabled, thresholdMin, pkgs };
}

export function getPetStimulusGuard(): PetStimulusGuardConfig {
  try {
    const raw = localStorage.getItem(PET_STIMULUS_GUARD_KEY);
    if (!raw) return { ...DEFAULT_PET_STIMULUS_GUARD, pkgs: [...DEFAULT_PET_STIMULUS_GUARD.pkgs] };
    return sanitizePetStimulusGuard(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PET_STIMULUS_GUARD, pkgs: [...DEFAULT_PET_STIMULUS_GUARD.pkgs] };
  }
}

export async function savePetStimulusGuard(
  cfg: PetStimulusGuardConfig,
  profile?: Pick<UserProfile, 'targetBedtime' | 'targetWakeTime'>,
): Promise<PetStimulusGuardConfig> {
  const clean = sanitizePetStimulusGuard(cfg);
  try {
    localStorage.setItem(PET_STIMULUS_GUARD_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
  const g = gemma();
  if (g?.petSetStimulusGuard) {
    try {
      await g.petSetStimulusGuard({
        stimEnabled: clean.enabled,
        stimThresholdMin: clean.thresholdMin,
        stimPkgs: clean.pkgs,
        targetBedtime: profile?.targetBedtime ?? '23:30',
        targetWakeTime: profile?.targetWakeTime ?? '07:30',
      });
    } catch {
      /* ignore */
    }
  }
  return clean;
}

export function getBubbleEvery(): number {
  try {
    const n = Number(localStorage.getItem(BUBBLE_EVERY_KEY));
    return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.round(n) : DEFAULT_BUBBLE_EVERY;
  } catch {
    return DEFAULT_BUBBLE_EVERY;
  }
}

export function getPetSkin(): string {
  try {
    return localStorage.getItem(PET_SKIN_KEY) || 'default';
  } catch {
    return 'default';
  }
}

export function setPetSkin(skin: string): void {
  try {
    localStorage.setItem(PET_SKIN_KEY, skin);
  } catch {
    /* ignore */
  }
}

export function setBubbleEvery(n: number): void {
  try {
    localStorage.setItem(BUBBLE_EVERY_KEY, String(Math.round(n)));
  } catch {
    /* ignore */
  }
}

export function isPetEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function setEnabled(v: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export async function petPermissionGranted(): Promise<boolean> {
  const g = gemma();
  if (!g) return false;
  try {
    const res = await g.petPermission();
    return !!res?.granted;
  } catch {
    return false;
  }
}

export async function petOpenPermissionSettings(): Promise<void> {
  const g = gemma();
  if (!g) return;
  try {
    await g.petOpenPermission();
  } catch {
    // 打不开授权页就静默失败，UI 上引导用户手动前往设置
  }
}

function minutesUntil(hhmm: string, now: Date): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  const cur = now.getHours() * 60 + now.getMinutes();
  return target >= cur ? target - cur : target + 1440 - cur;
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function tonightRecord(records: SleepRecord[], now: Date): SleepRecord | undefined {
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  return records.find((r) => r.kind !== 'nap' && r.date === yKey);
}

/**
 * 由当前数据生成傲娇播报词库。没有的数据绝不编；每行一条，原生侧逐条轮播。
 */
export function buildPetSayLines(
  records: SleepRecord[],
  profile: UserProfile,
  now: Date = new Date(),
): string[] {
  const bedtime = profile?.targetBedtime ?? '23:30';
  const tonight = tonightRecord(records, now);
  const until = minutesUntil(bedtime, now);
  const say: string[] = [];

  const h = now.getHours();
  if (h >= 23 || h < 6) {
    say.push('喂，鱼片！都几点了还不睡？本、本鱼才没担心你，只是明天有你好看。');
  } else if (h >= 18) {
    say.push('哼，今晚也别指望本鱼催你睡……才怪，到点就给我上床！');
  } else if (h >= 11) {
    say.push('鱼片，午后眯十五分钟，效率翻倍——这可是本鱼的恩赐。');
  } else {
    say.push('早啊鱼片。昨晚睡得怎么样？不许糊弄本鱼。');
  }

  if (tonight) {
    say.push(`昨晚睡了 ${fmtDuration(tonight.durationMinutes)}，${tonight.sleepScore} 分。勉、勉强不算辜负本鱼的看守。`);
    if (tonight.sleepEfficiency >= 85) {
      say.push(`睡眠效率 ${tonight.sleepEfficiency}%？哼，算你识相，有按本鱼说的做嘛。`);
    }
    if (tonight.latencyMinutes >= 30) {
      say.push(`躺了 ${fmtDuration(tonight.latencyMinutes)} 才睡着？你是不是又躲被窝里玩手机了，鱼片！`);
    }
    if (tonight.wakeCount >= 2) {
      say.push(`半夜醒了 ${tonight.wakeCount} 次……记住，睡前少喝水！本鱼可绕不了你。`);
    }
  } else if (until != null && until > 0) {
    if (until <= 60) {
      say.push(`${until} 分钟后就到 ${bedtime} 了！放下手机！这是命令……类的。`);
    } else {
      say.push(`还有 ${fmtDuration(until)} 就到 ${bedtime} 了。事已至此，先睡觉吧！`);
    }
  } else {
    say.push('一次睡眠记录都没有，本鱼管谁去？喂，今晚给我按开始！');
  }

  const streak = computeWeekReport(records, now).streak;
  if (streak >= 3) {
    say.push(`连续 ${streak} 晚达标……本鱼都看在眼里，才不夸你。继续保持，鱼片。`);
  }

  say.push('天黑了就把护眼滤镜点上……本鱼才不会替你按，按钮就在那儿！');
  say.push('陪睡服务可是很费 token 的哦。今晚加两碗白饭，不过分吧？');
  say.push('我去睡了，明早起来应该就……喂！要去睡的是你！');
  say.push('卧槽……不是，本鱼是说，你该睡了。');
  say.push('哼，今晚也乖乖来找本鱼报道了？算你识相。');
  say.push('得加钱。……算了，看你今天表现还行的份上，免了。');
  say.push('事已至此，先睡觉吧！明天的事明天再说。');

  return say;
}

function stimulusPayload(profile?: UserProfile) {
  const guard = getPetStimulusGuard();
  return {
    stimEnabled: guard.enabled,
    stimThresholdMin: guard.thresholdMin,
    stimPkgs: guard.pkgs,
    targetBedtime: profile?.targetBedtime ?? '23:30',
    targetWakeTime: profile?.targetWakeTime ?? '07:30',
  };
}

/** 启动桌宠（幂等：已运行则只刷新词库与刷屏守护参数）。 */
export async function startPet(
  records: SleepRecord[],
  profile: UserProfile,
): Promise<{ ok: boolean; needPermission?: boolean }> {
  const g = gemma();
  if (!g) return { ok: false };
  const payload = {
    say: buildPetSayLines(records, profile).join('\n'),
    bubbleEvery: getBubbleEvery(),
    skin: getPetSkin(),
    ...petContext(records, new Date()),
    ...stimulusPayload(profile),
  };
  try {
    if (isPetEnabled()) await g.petSync(payload);
    else await g.petStart(payload);
    setEnabled(true);
    return { ok: true };
  } catch (e: any) {
    if (String(e?.message ?? e).includes('OVERLAY_PERMISSION_REQUIRED')) {
      setEnabled(false);
      return { ok: false, needPermission: true };
    }
    setEnabled(false);
    return { ok: false };
  }
}

export async function syncPet(
  records: SleepRecord[],
  profile: UserProfile,
): Promise<void> {
  const g = gemma();
  if (!g || !isPetEnabled()) return;
  const cached = getCachedLlmSay(profile?.aiConfig, petSayFingerprint(records, profile));
  const localLines = buildPetSayLines(records, profile);
  const say = cached
    ? [localLines[0], ...cached, ...localLines.slice(1, 3)].filter(Boolean).join('\n')
    : localLines.join('\n');
  try {
    await g.petSync({
      say,
      bubbleEvery: getBubbleEvery(),
      skin: getPetSkin(),
      ...petContext(records, new Date()),
      ...stimulusPayload(profile),
    });
  } catch {
    /* 桌宠没开或服务已停，忽略 */
  }

  let sayInFlight = false;
  if (!cached && !sayInFlight) {
    sayInFlight = true;
    void generatePetSayLinesLlm(records, profile)
      .then((lines) => {
        if (!lines || !g) return;
        try {
          void g.petSync({
            say: [...lines, ...localLines.slice(0, 3)].join('\n'),
            bubbleEvery: getBubbleEvery(),
            skin: getPetSkin(),
            ...stimulusPayload(profile),
          });
        } catch {
          /* ignore */
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        sayInFlight = false;
      });
  }
}

export async function stopPet(): Promise<void> {
  const g = gemma();
  if (!g) return;
  try {
    await g.petStop();
  } catch {
    /* ignore */
  }
  setEnabled(false);
}

export async function setPetOverlayVisible(visible: boolean): Promise<void> {
  const g = gemma();
  if (!g?.petSetVisible) return;
  try {
    await g.petSetVisible({ visible });
  } catch {
    /* ignore */
  }
}

export async function consumePendingTab(): Promise<string | null> {
  const g = gemma();
  if (!g) return null;
  try {
    const res = await g.petConsumePendingTab();
    const tab = res?.tab;
    return typeof tab === 'string' && tab ? tab : null;
  } catch {
    return null;
  }
}
