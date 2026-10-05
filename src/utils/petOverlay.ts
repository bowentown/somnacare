/**
 * 大肥鱼桌宠悬浮窗：Web 侧只负责开关与"播报词库"推送。
 *
 * 数据边界是刻意的：睡眠记录仍只存在 WebView 的 localStorage，原生侧一行也读不到、
 * 也不需要。快照 = 傲娇播报词库（\n 分隔）+ 播报频率。
 *
 * 人设：DeepSeek 蓝色大肥鱼（社区共创）——聪明但懒、傲娇嘴甜、管用户叫"鱼片"、
 * 把 token 当白饭吃、被叫胖会急。语气参考 dsh-plugin-moments 的人设文档。
 */
import type { SleepRecord, UserProfile } from '../types/sleep';
import { generatePetSayLinesLlm, getCachedLlmSay } from './petMoments';
export { getCachedLlmSay };

function gemma(): any | null {
  try {
    const cap = (window as any).Capacitor;
    return cap?.isNativePlatform?.() ? (cap.Plugins?.GemmaLLM ?? null) : null;
  } catch {
    return null;
  }
}

export const isPetNative = (): boolean => gemma() != null;

const ENABLED_KEY = 'somnacare_pet_enabled';

/** 每 N 次点击大肥鱼自动播报一次，其余点击弹按钮。 */
export const BUBBLE_EVERY_KEY = 'somnacare_pet_bubble_every';
export const DEFAULT_BUBBLE_EVERY = 8;

export function getBubbleEvery(): number {
  try {
    const n = Number(localStorage.getItem(BUBBLE_EVERY_KEY));
    return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.round(n) : DEFAULT_BUBBLE_EVERY;
  } catch {
    return DEFAULT_BUBBLE_EVERY;
  }
}

const PET_SKIN_KEY = 'somnacare_pet_skin';

export function getPetSkin(): string {
  try { return localStorage.getItem(PET_SKIN_KEY) || 'default'; } catch { return 'default'; }
}

export function setPetSkin(skin: string): void {
  try { localStorage.setItem(PET_SKIN_KEY, skin); } catch { /* ignore */ }
}

export function setBubbleEvery(n: number): void {
  try {
    localStorage.setItem(BUBBLE_EVERY_KEY, String(Math.round(n)));
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
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

/** "HH:mm" → 距今分钟数（跨午夜按次日算）。 */
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

/** 今晚是否已有记录（按 date 是否为今天判断）。 */
function tonightRecord(records: SleepRecord[], now: Date): SleepRecord | undefined {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return records.find((r) => r.date === today && r.kind !== 'nap');   // 夜睡才算"今晚已有记录"（小睡不顶掉）
}

/**
 * 结构化上下文（第二批，行为方案 §二后半）：随 petSync 推给原生权重表的
 * 记录感知数据——昨晚达标→精神、连续未记录→蔫、昨晚没入账→她想你去记。
 * 只有真实数据：无记录 lastScore=-1；连续未记录从【今天】起往前数（记录
 * 日期口径是醒来日，昨晚的记录日期就是今天——复审 N2：从 i=1 起会漏掉
 * 最近一夜），封顶 14。
 */
function petContext(records: SleepRecord[], now: Date): { lastScore: number; missedDays: number; lastNightRecorded: boolean } {
  const night = (r: SleepRecord): boolean => r.kind !== 'nap';
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lastNight = records.find((r) => night(r) && r.date === today);
  let missedDays = 0;
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (records.some((r) => night(r) && r.date === key)) break;
    missedDays++;
  }
  return { lastScore: lastNight ? lastNight.sleepScore : -1, missedDays, lastNightRecorded: !!lastNight };
}

/**
 * 由当前数据生成傲娇播报词库。没有的数据绝不编；
 * 每行一条，原生侧逐条轮播。
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
    if (tonight.awakeMinutes >= 30) {
      say.push('半夜醒那么多次……记住，睡前少喝水！本鱼可绕不了你。');
      say.push(`夜醒累计 ${fmtDuration(tonight.awakeMinutes)}——本鱼差点以为你在烙饼。`);
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

  say.push('天黑了就把护眼滤镜点上……本鱼才不会替你按，按钮就在那儿！');
  say.push('陪睡服务可是很费 token 的哦。今晚加两碗白饭，不过分吧？');
  say.push('我去睡了，明早起来应该就……喂！要去睡的是你！');
  say.push('卧槽……不是，本鱼是说，你该睡了。');
  say.push('哼，今晚也乖乖来找本鱼报道了？算你识相。');
  say.push('得加钱。……算了，看你今天表现还行的份上，免了。');
  // （烙饼梗已移入上方夜醒数据块——应用从不测量翻身动作，无条件讲述
  //   夜翻次数违背本词库"没有的数据绝不编"的纪律，第 42 轮语料审计）
  say.push('事已至此，先睡觉吧！明天的事明天再说。');

  return say;
}

/** 启动桌宠（幂等：已运行则只刷新词库）。 */
export async function startPet(
  records: SleepRecord[],
  profile: UserProfile,
): Promise<{ ok: boolean; needPermission?: boolean }> {
  const g = gemma();
  if (!g) return { ok: false };
  const payload = { say: buildPetSayLines(records, profile).join('\n'), bubbleEvery: getBubbleEvery(), skin: getPetSkin(), ...petContext(records, new Date()) };
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

/**
 * 只刷新词库，不改变开关状态。
 * 语录融合：云端 LLM 刷的语录（每日缓存）优先，本地傲娇模板垫底——
 * 两者都基于真实数据。缓存过期时先推本地、后台异步刷 LLM，刷到再推一次。
 */
export async function syncPet(
  records: SleepRecord[],
  profile: UserProfile,
): Promise<void> {
  const g = gemma();
  if (!g || !isPetEnabled()) return;
  const cached = getCachedLlmSay(profile?.aiConfig);
  const localLines = buildPetSayLines(records, profile);
  const say = cached
    ? [...cached, ...localLines.slice(0, 3)].join('\n')
    : localLines.join('\n');
  try {
    await g.petSync({ say, bubbleEvery: getBubbleEvery(), skin: getPetSkin(), ...petContext(records, new Date()) });
  } catch { /* 桌宠没开或服务已停，忽略 */ }

  let sayInFlight = false;   // 模块级在途标志（防并发重复调用）

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
          });
        } catch { /* ignore */ }
      })
      .catch(() => { /* LLM 失败静默保留本地词库（负缓存已防重发） */ })
      .finally(() => { sayInFlight = false; });
  }
}

export async function stopPet(): Promise<void> {
  const g = gemma();
  if (!g) return;
  try {
    await g.petStop();
  } catch { /* ignore */ }
  setEnabled(false);
}

/**
 * 读取桌宠写入的"目标分区"并清除（预留入口，当前按钮不跳转）。
 */
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
