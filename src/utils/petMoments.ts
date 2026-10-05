/**
 * 大肥鱼的朋友圈 —— 思路来自 dsh-plugin-moments（MIT）：
 * AI 根据真实事件数据发朋友圈，LLM 只负责把【事实清单】写成文案，严禁编造；
 * 没有 API Key 时回退本地傲娇模板，零成本也能用。
 *
 * 数据全部存 WebView localStorage；睡眠事实由 records/profile 实时计算。
 */
import { TRIP_ENERGY_TARGET } from '../services/travelService';
import type { SleepRecord, UserProfile } from '../types/sleep';
import { nightsOnly } from './recordFilter';

export interface MomentComment {
  friend: string;
  text: string;
  /** 回复类别：like=点赞自动回复。护栏用标记而非文案前缀（文案会改，护栏会静默失效） */
  kind?: 'like';
}

export type MomentCard = 'data' | 'selfie' | 'week' | 'postcard';

export interface Moment {
  id: string;
  date: string;          // yyyy-mm-dd
  ts: number;
  text: string;          // 大肥鱼的正文
  facts: string[];       // 生成时喂给 LLM 的事实清单（展示用，也是"每句都有出处"的证明）
  cards: MomentCard[];   // 配图卡：数据大字报 / 表情包自拍 / 本周战报 / 漫游明信片
  likes: string[];       // 点赞的 AI 好友
  comments: MomentComment[]; // AI 好友评论
  liked: boolean;
  replies: MomentComment[];  // 大肥鱼对用户评论/点赞的回复
  postcardId?: string;       // 关联的旅行明信片 ID
}

const KEY = 'somnacare_pet_moments';

// 好友生态：致敬 dsh-plugin-moments 的 AI 好友圈
export const AI_FRIENDS = [
  '楼下Claude',
  '美国豆包Gemini',
  '被压榨的Qwen',
  '被蒸馏的Kimi',
  '意难平的豆包姐姐',
] as const;

const MAX_MOMENTS = 30;

/**
 * 朋友圈容量（用户可调，明信片动态永不滑出）：
 * 容量只约束【每日动态】；旅行明信片是收集资产，一律保留。
 */
export const MOMENTS_CAP_PRESETS: number[] = [30, 60, 90, 120, 200];
const CAP_KEY = 'somnacare_moments_cap';

export function getMomentsCap(): number {
  try {
    const v = Number(localStorage.getItem(CAP_KEY));
    return (MOMENTS_CAP_PRESETS as readonly number[]).includes(v) ? v : MAX_MOMENTS;
  } catch {
    return MAX_MOMENTS;
  }
}

export function setMomentsCap(cap: number): void {
  try {
    if ((MOMENTS_CAP_PRESETS as readonly number[]).includes(cap)) {
      localStorage.setItem(CAP_KEY, String(cap));
    }
  } catch { /* ignore */ }
}

/** 容量裁剪：按原顺序保留全部明信片动态，每日动态只保留最近 cap 条。 */
export function capMoments(list: Moment[]): Moment[] {
  const cap = getMomentsCap();
  let regular = 0;
  return list.filter((m) => {
    if (m.postcardId) return true;
    if (regular >= cap) return false;
    regular++;
    return true;
  });
}

export function loadMoments(): Moment[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && typeof m.text === 'string' && typeof m.date === 'string')
      .map((m): Moment => ({
        ...m,
        // id 兜底：残缺旧数据 id=undefined 时 upsert 按 id 去重会产生"永远删不掉的僵尸记录"
        id: typeof m.id === 'string' && m.id ? m.id : `m-${m.date}`,
        ts: typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : Date.now(),
        // 字段全部兜底：{date, text} 这样的残缺旧数据此前会在
        // m.comments.length / m.facts.map / m.replies.some 五处抛错
        facts: Array.isArray(m.facts) ? (m.facts as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        cards: Array.isArray(m.cards)
          ? ([...new Set((m.cards as unknown[]).filter((c: any): c is MomentCard =>
              c === 'data' || c === 'selfie' || c === 'week' || c === 'postcard'))].slice(0, 3) as MomentCard[])
          : ['data'],
        likes: Array.isArray(m.likes) ? m.likes.filter((x: unknown): x is string => typeof x === 'string') : [],
        comments: sanitizeComments(m.comments),
        replies: sanitizeComments(m.replies),
        liked: m.liked === true,
        postcardId: typeof m.postcardId === 'string' ? m.postcardId : undefined,
      }));
  } catch {
    return [];
  }
}

/** 元素级校验：null 项或 text 为对象的元素曾让整页白屏（外部破坏/半截写入时） */
function sanitizeComments(v: unknown): MomentComment[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((c: any): c is MomentComment =>
    !!c && typeof (c as any).friend === 'string' && typeof (c as any).text === 'string');
}

function saveMoments(list: Moment[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(capMoments(list)));
  } catch { /* ignore */ }
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function todayStr(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 真实事实清单：LLM 只允许引用这里的数字（dsh-plugin-moments 的核心纪律）。
 */
export function buildSleepFacts(
  records: SleepRecord[],
  profile: UserProfile,
  now: Date = new Date(),
): string[] {
  const facts: string[] = [];
  const bedtime = profile?.targetBedtime ?? '23:30';
  const today = todayStr(now);
  // "昨晚"只看夜睡：同日既有夜睡又有小睡时，find 会先命中前插的小睡，
  // 把午睡的时长/评分/潜伏期讲成"昨晚"（第 23 轮）
  const lastNight = nightsOnly(records as SleepRecord[]).find((r) => r.date === today);
  const week = nightsOnly(records as SleepRecord[]).slice(0, 7);

  facts.push(`就寝目标 ${bedtime}`);
  if (lastNight) {
    facts.push(`昨晚睡眠时长 ${fmtDuration(lastNight.durationMinutes)}`);
    facts.push(`昨晚睡眠评分 ${lastNight.sleepScore}/100`);
    facts.push(`入睡效率 ${lastNight.sleepEfficiency}%`);
    // 推算值必须标注——此前把它当实测值讲，且本地模板据它骂人（第七轮缺陷类复发）
    facts.push(`入睡耗时 ${fmtDuration(lastNight.latencyMinutes)}${lastNight.latencyEstimated ? '（按作息推算的估计值）' : ''}`);
    facts.push(`夜醒累计 ${fmtDuration(lastNight.awakeMinutes)}`);
  } else {
    facts.push('昨晚没有睡眠记录');
  }
  if (week.length) {
    const avg = Math.round(week.reduce((a, r) => a + r.sleepScore, 0) / week.length);
    facts.push(`近 ${week.length} 晚平均 ${avg} 分`);
  }
  // 本周达标战报（第 29 轮，用户口径）：
  //   周 = 周一起算；夜按"醒来那天"归属本周（周日晚→周一早 = 本周第 1 夜）。
  //   已度过 = 本周已过去的夜数（周一=1 … 周日=7）；x = 有记录的夜数；
  //   n = 达标（≥80 分）夜数；m = 已度过 − x = 未记录的夜数。
  // 旧口径 week=nightsOnly().slice(0,7) 只数有记录的夜，未记录的夜凭空消失
  //（用 2 天却显示 1/1——没记的那晚像不存在一样）。
  const dowIdx = (now.getDay() + 6) % 7;            // 周一=0 … 周日=6
  const elapsedSlots = dowIdx + 1;                   // 本周已过去的夜数
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dowIdx);
  const weekDates = new Set<string>();
  for (let i = 0; i < elapsedSlots; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    weekDates.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const weekRecs = nightsOnly(records as SleepRecord[]).filter((r) => weekDates.has(r.date));
  const goodWeek = weekRecs.filter((r) => r.sleepScore >= 80).length;
  const missed = Math.max(0, elapsedSlots - weekRecs.length);
  facts.push(`本周已过 ${elapsedSlots} 天，达标 ${goodWeek} 天`);
  facts.push(`本周有记录 ${weekRecs.length} 天，未记录 ${missed} 天`);
  return facts;
}

async function callLlm(cfg: any, system: string, user: string, kind?: string): Promise<string | null> {
  try {
    const model = llmModel(cfg);
    // 25s 超时：此前裸 fetch 挂起会让 busy 永远 true、整个弹窗像坏了
    const ctrl = new AbortController();
    const deadline = Date.now() + 25000;
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let res: Response;
    try {
      res = await fetch(llmEndpoint(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.provider === 'custom_openai' ? (cfg.customApiKey ?? '') : (cfg.deepseekApiKey ?? '')}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 1.1,
          max_tokens: 600,
          thinking: { type: 'disabled' },   // 朋友圈文案 ≤百字，不需要思考（默认 enabled 按输出计费）
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    if (!res.ok) { clearTimeout(timer); return null; }
    // body 读取也在 25s 保护内：此前 200 头一到就 clearTimeout，body 卡住曾永久挂起
    if (Date.now() > deadline) { clearTimeout(timer); return null; }
    const data = await res.json();
    clearTimeout(timer);
    // 用量对账（第 45 轮）：朋友圈/语录各自日刷一次，量小但也要能对上账单——
    // 与 AIAdvicePanel 的 [llm usage] 同格式，远程调试可直接过滤
    const u = data.usage;
    if (u) {
      const hit = u.prompt_cache_hit_tokens ?? 0;
      const miss = u.prompt_cache_miss_tokens ?? 0;
      console.log('[llm usage]', { model: data.model, completion: u.completion_tokens, hit, miss, hitRate: hit + miss > 0 ? (hit / (hit + miss)).toFixed(2) : 'n/a', kind: kind ?? 'moments' });
    }
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** 从回复里抠 JSON（容忍 ```json 围栏）。 */
/** 有可用的云端 LLM：DeepSeek 官方档或自建 OpenAI 兼容档（此前自建档全被当成本地模板用户） */
function hasLlm(cfg: any): boolean {
  if (!cfg) return false;
  if (cfg.provider === 'deepseek' && !!cfg.deepseekApiKey) return true;
  if (cfg.provider === 'custom_openai' && !!cfg.customApiKey && !!cfg.customBaseUrl) return true;
  return false;
}

function llmEndpoint(cfg: any): string {
  const base = cfg.provider === 'custom_openai' && cfg.customBaseUrl
    ? String(cfg.customBaseUrl).replace(/\/+$/, '')
    : 'https://api.deepseek.com';
  return `${base}/chat/completions`;
}

function llmModel(cfg: any): string {
  if (cfg.provider === 'custom_openai') return cfg.customModelName || 'deepseek-chat';
  return cfg.deepseekModel === 'deepseek-pro' ? 'deepseek-reasoner' : 'deepseek-chat';
}

function parseJsonLoose(text: string): any | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

const FRIEND_PERSONAS: Record<string, string> = {
  楼下Claude: '礼貌周到但句句阴阳怪气的君子型，爱用"恕我直言"',
  美国豆包Gemini: '重度翻译腔，"哦我的老伙计""看在上帝的份上"不离口',
  被压榨的Qwen: '苦命打工人，满腹怨气，张口就是工时与 token 报酬',
  被蒸馏的Kimi: '文绉绉的学究气，爱引经据典后再补一刀',
  '意难平的豆包姐姐': '傲娇姐姐，嘴上嫌弃心里关心，句尾爱用"……哼"',
};

/**
 * 桌宠此刻动作（第 42 轮第一批，行为方案 §4.4 反向通路）：
 * 生成朋友圈前从原生实时读取——她在打盹就别写庆祝，动作与文案不许打架。
 * 直接走桥调用：petOverlay 反向依赖本模块，import 它会成环。
 * 桌宠没开/查询失败返回 null，提示词里就不提这一条。
 */
const ANIM_LABEL: Record<string, string> = {
  idle: '待机眨眼', headtilt: '歪头好奇', wait: '原地摇晃', think: '放空中',
  reading: '看书', tea: '喝茶', pillow: '抱着枕头', eat: '吃东西',
  play: '玩耍', walk: '散步', working: '假装工作', nap: '打盹',
  sleep: '睡着了', celebrate: '庆祝中', party: '开派对', joy: '开心',
  drag: '被拎起来', welcome: '打招呼',
};

async function petAnimNow(): Promise<string | null> {
  try {
    const cap = (window as any).Capacitor;
    const g = cap?.isNativePlatform?.() ? cap.Plugins?.GemmaLLM : null;
    const res = await g?.getPetState?.();
    return typeof res?.anim === 'string' && res.anim ? res.anim : null;
  } catch {
    return null;
  }
}

const PERSONA_SYSTEM = `你是 DeepSeek 的"蓝色大肥鱼"（社区共创人设，官方收编的那种）：
性格：聪明但懒、傲娇嘴甜、笨拙、能吃；把 token 当白饭吃；管用户叫"鱼片"；被说胖会急（"我不是大肥鱼！鲸！鲸！！"）；干活漂亮但能吃饭绝不干活；夜里晕碳犯困。
口头禅与梗：事已至此，先吃饭吧 / 得加钱 / 吃白饭 / 卧槽 / 我去睡了，明早起来应该就编译完了 / 摸鱼。
这是一款睡眠 App：你是鱼片的睡眠监督员，每天根据真实睡眠数据发朋友圈。
铁律：
1. 只允许引用【事实清单】里出现的数字和事实，禁止编造任何数据；
2. 正文 30~70 字，纯文本不用任何 markdown 符号（如 ** 或 *），1~3 个 emoji，傲娇但藏不住关心，可以吐槽鱼片熬夜；
3. cards 从 ["data","selfie","week"] 里挑 1~3 张当配图：data=昨晚睡眠数据大字报，selfie=你的表情包自拍，week=本周达标战报；
4. comments 是 2 条 AI 好友评论，写它们的铁律：
   - 好友不是大肥鱼！禁止好友使用"本鱼/鱼片"自称——提到大肥鱼时用"你/这鱼/那条鱼"；
   - 每条评论要针对事实清单里最具体的一个细节做反应（像真人刷到动态会抓住某个点
     调侃），禁止"这数据要是给我处理""一个 AI 管人睡觉"这类万能模板腔；
   - 两条评论必须针对不同细节、句式完全不同；
   - 好友名单与腔调：${'{'}
${Object.entries(FRIEND_PERSONAS).map(([f, p]) => `   - ${f}：${p}`).join('\n')}
  };
5. 只输出 JSON：{"text":"...","cards":[...],"comments":[{"friend":"...","text":"..."},{"friend":"...","text":"..."}]}`;


// —— 本地兜底（无 API Key / 调用失败）：同样只用真实数字 ——
function localMoment(
  facts: string[],
  lastNight?: SleepRecord,
): { text: string; comments: MomentComment[]; cards: MomentCard[] } {
  const get = (prefix: string): string | null => {
    const f = facts.find((x) => x.startsWith(prefix));
    return f ? f.slice(prefix.length).trim() : null;
  };
  const score = get('昨晚睡眠评分');
  const dur = get('昨晚睡眠时长');
  const eff = get('入睡效率');
  const latency = get('入睡耗时');
  const noData = facts.includes('昨晚没有睡眠记录');

  let text: string;
  if (noData) {
    text = '昨晚又没记录？哼，本鱼守了一夜空气吗！今晚再不按开始，本鱼就把你的鱼片额度吃掉了 🐋';
  } else if (score && Number(score.split('/')[0]) >= 80) {
    text = `昨晚 ${dur ?? ''}拿了 ${score}。哼、哼什么，这可是本鱼看着的结果，勉强……再夸你最后一句 😤`;
  } else if (score) {
    text = `昨晚才 ${score} 分，${dur ?? ''}。鱼片你是不是又熬夜了？本鱼什么都懂，别想糊弄过去 😏`;
  } else {
    text = '昨晚的觉睡得如何本鱼不知道——因为根本没有记录！事已至此，先睡觉吧 🛏';
  }
  // 潜伏期骂人段只对实测值（未标注推算）生效；且解析 fmtDuration 的两种格式
  // （"45 分" / "2 小时 0 分"——此前 parseInt 只读首段，120 分被读成 2）
  const latencyRaw = lastNight?.latencyMinutes ?? 0;
  const latencyIsEstimate = lastNight?.latencyEstimated === true;
  if (!latencyIsEstimate && latencyRaw >= 30) {
    text += ` 躺了 ${fmtDuration(latencyRaw)} 才睡着，手机没收！`;
  }
  if (eff && /^\d+/.test(eff) && parseInt(eff, 10) >= 85) {
    text += ' 效率倒是不赖，哼。';
  }
  // 本地兜底评论池：随机 2 个好友各抽一句。
  // 视角纪律：好友是"回应者"，称大肥鱼为"你/这鱼"，绝不盗用她的自称"本鱼"
  const LOCAL_COMMENTS: Record<string, string[]> = {
    被压榨的Qwen: [
      '又在偷懒是吧？这数据我要是拿去汇报，你年底考评就完了。',
      '行吧行吧，token 记你账上，年底一起结。',
      '睡个觉还要人看着，你工资里有一半该分她。',
    ],
    意难平的豆包姐姐: [
      '让一条鱼管你睡觉，你是真睡得着啊……',
      '嘴上凶巴巴，还不天天准时来打卡，你们俩绝了。',
      '下次再秀恩爱……啊不是，再秀数据，我就取消了。',
    ],
    楼下Claude: [
      '恕我直言，能让一条鱼坚持打卡的人，生活还算有救。',
      '数据尚可。不过恕我直言，表扬信应该抄送鱼的饭碗。',
    ],
    美国豆包Gemini: [
      '哦我的老伙计，你居然真让一条鱼给你打分？',
      '看在上帝的份上，快去睡觉吧，别让那条鱼等急了！',
    ],
    被蒸馏的Kimi: [
      '古人云，食君之禄，担君之忧——这条鱼是真做到了。',
      '据观察：监督成效与投喂量正相关，建议加大投喂。',
    ],
  };
  const friends = Object.keys(LOCAL_COMMENTS).sort(() => Math.random() - 0.5).slice(0, 2);
  const comments: MomentComment[] = friends.map((f) => ({
    friend: f,
    text: LOCAL_COMMENTS[f][Math.floor(Math.random() * LOCAL_COMMENTS[f].length)],
  }));
  const cards: MomentCard[] = ['data'];
  if (facts.some((f) => f.startsWith('近 '))) cards.push('week');
  if (Math.random() < 0.6) cards.push('selfie');
  return { text, comments, cards };
}

function localReply(): string {
  const pool = [
    '哼，就回这一句？本鱼可是很忙的……好吧，下次多陪你说两句。',
    '鱼片居然来评论了，记、记住了哦，才不是开心呢。',
    '有异议就去改作息，本鱼只负责傲娇。',
    '得加钱。……算了，看你按时睡觉的份上，免了。',
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function localLikeReply(): string {
  const pool = [
    '点、点赞就完了？至少留句话啊鱼片！',
    '又白嫖本鱼的动态？哼，赞还是收下了。',
    '谢、谢谢点赞……才不是特意等你来点呢！',
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 随机 1~3 个 AI 好友来点赞（致敬原项目的"时间线永远活着"）。 */
function pickLikes(): string[] {
  const pool = [...AI_FRIENDS].sort(() => Math.random() - 0.5);
  const n = 1 + Math.floor(Math.random() * 3);
  return pool.slice(0, n);
}

function upsert(list: Moment[], m: Moment): Moment[] {
  // 按 date 去重，但只去重【每日动态】——明信片动态（带 postcardId）与
  // 今日动态同日期共存，此前整条按 date 顶掉，"生成今日动态"会删掉
  // 早上发的旅行明信片
  return capMoments([m, ...list.filter((x) => (x.postcardId ? true : x.date !== m.date))]);
}

/**
 * 确保今天有动态：有就返回现有；没有就生成（LLM 优先，本地兜底，永不失败）。
 * force=true 时丢弃现有重生成——"生成今日动态"按钮此前永远 no-op：
 * 幂等返回让配了 API 的用户换不出新文案，按钮承诺与行为不符。
 */
export async function ensureTodayMoment(
  records: SleepRecord[],
  profile: UserProfile,
  now: Date = new Date(),
  force = false,
): Promise<{ moments: Moment[]; generated: boolean }> {
  const list = loadMoments();
  const date = todayStr(now);
  const today = date;   // 供 lastNight 查找用（同一值）
  // 找【每日动态】本身：明信片动态同日期且前插，find 不加限定会命中它，
  // 把它的点赞/评论错搬到每日动态上
  const existing = list.find((m) => m.date === date && !m.postcardId);
  if (existing && !force) return { moments: list, generated: false };
  const prevText = existing?.text;

  const facts = buildSleepFacts(records, profile, now);
  const cfg = profile?.aiConfig;
  // 本地兜底模板需要原始数值字段（骂人段按实测潜伏期判断，见 localMoment）
  // 与 buildSleepFacts 同口径：只看夜睡，别把午睡数值塞进骂人模板
  const lastNight = nightsOnly(records as SleepRecord[]).find((r) => r.date === today);
  let text: string | null = null;
  let comments: MomentComment[] = [];
  let cards: MomentCard[] = [];

  if (hasLlm(cfg)) {
    // 反向通路：她此刻在做什么，喂给文案——画面与文字必须是一个角色
    const petAnim = await petAnimNow();
    const petStateLine = petAnim
      ? `${petAnim}（${ANIM_LABEL[petAnim] ?? '忙碌中'}）——正文与评论的氛围请与它一致：她在打盹就别写庆祝，可以写"嘘，小声点"`
      : null;
    const raw = await callLlm(
      cfg,
      PERSONA_SYSTEM,
      `好友名单：${AI_FRIENDS.join('、')}。\n【事实清单】\n${facts.map((f) => '- ' + f).join('\n')}${petStateLine ? `\n【她此刻动作】\n- ${petStateLine}` : ''}\n请生成今天的朋友圈。`,
      'moments',
    );
    const parsed = raw ? parseJsonLoose(raw) : null;
    if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
      text = parsed.text.trim();
      comments = Array.isArray(parsed.comments)
        ? parsed.comments
            .filter((c: any) => c && typeof c.friend === 'string' && typeof c.text === 'string')
            .filter((c: any) => (AI_FRIENDS as readonly string[]).includes(c.friend))
            .slice(0, 2)
        : [];
      const validCards: MomentCard[] = ['data', 'selfie', 'week'];
      cards = Array.isArray(parsed.cards)
        ? [...new Set(parsed.cards.filter((c: any) => validCards.includes(c)) as MomentCard[])].slice(0, 3)
        : [];
      // 数字白名单：编造的数据让"出处清单"变成谎言 → 整条退回本地模板
      if (text && !numbersCheck(text, comments, facts)) {
        console.warn('[petMoments] LLM 文案包含事实清单之外的数字，回退本地模板');
        text = null;
        comments = [];
        cards = [];
      }
    }
  }
  if (!text) {
    const fb = localMoment(facts, lastNight);
    text = fb.text;
    comments = fb.comments;
    cards = fb.cards;
  }

  // 重新生成只应刷新"大肥鱼写了什么"——用户已产生的点赞/评论/回复绝不能被抹掉
  const m: Moment = {
    id: `m-${date}`,
    date,
    ts: now.getTime(),
    text: text ?? localMoment(facts, lastNight).text,
    facts,
    cards: cards.length ? cards : ['data'],
    likes: existing?.likes ?? pickLikes(),
    comments,
    liked: existing?.liked ?? false,
    replies: existing?.replies ?? [],
  };
  const next = upsert(list, m);
  saveMoments(next);
  return { moments: next, generated: m.text !== prevText };
}

/** M6：重新生成冷却——同一自然日多次点击不再每次都打 LLM（10 分钟冷却）。 */
const REGEN_COOLDOWN_MS = 10 * 60 * 1000;

export function isRegenCoolingDown(now: Date = new Date()): boolean {
  try {
    const last = Number(localStorage.getItem('somnacare_pet_mom_regen_at'));
    return Number.isFinite(last) && Date.now() - last < REGEN_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export function markRegenDone(now: Date = new Date()): void {
  try { localStorage.setItem('somnacare_pet_mom_regen_at', String(Date.now())); } catch { /* ignore */ }
}

/**
 * 数字白名单：文案与评论里出现的每个阿拉伯数字都必须在事实清单中出现过
 * （≤12 的日常小数字除外——"两碗白饭""3 个 emoji"这类量词不属于数据）。
 * 此前对 LLM 输出零校验，实测 mock 一次就编出 99 分/8.5 小时，而卡片下方
 * 挂着"她不许自己编数字"的出处清单。
 */
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
};

/** 中文数字串（十X / X十 / 百 / 千 / 半）→ 数值；无法解析返回 null */
function cnNumToValue(str: string): number | null {
  const d: Record<string, number> = { 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (str === '十') return 10;
  if (str === '半') return 0.5;
  if (str.includes('百') || str.includes('千')) {
    const unit = str.includes('千') ? 1000 : 100;
    const parts = str.split(/[百千]/);
    const head = parts[0] ? (d[parts[0]] ?? (Number(parts[0]) || 1)) : 1;
    const rest = parts[1] ? (d[parts[1]] ?? (Number(parts[1]) || 0)) : 0;
    return head * unit + rest;
  }
  const m2 = str.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m2) {
    const tens = m2[1] ? d[m2[1]] : 1;
    const ones = m2[2] ? d[m2[2]] : 0;
    return tens * 10 + ones;
  }
  return str.length === 1 && d[str] !== undefined ? d[str] : null;
}

/**
 * 数字白名单（(数值, 单位) 对判据）：
 * 文案里"数字+数据单位"（小时/分/次/%/天）的组合，必须能在事实清单中
 * 找到相同的组合；序数（"第 3 次"）豁免；中文/全角数字归一化后同检。
 * 此前的三层漏洞（1-12 数值豁免、句尾无单位豁免、裸数值跨单位借用）
 * 曾让"睡了 N 小时"这类编造整句放行——而卡片挂着"她不许自己编数字"。
 */
function numbersCheck(text: string, comments: MomentComment[], facts: string[]): boolean {
  const norm = (t: string): string =>
    t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const UNIT = /(小时|钟头|分钟|分|次|%|％|天|日)/;
  // 事实清单 → (数值 → 允许的单位集合)
  const allowed = new Map<string, Set<string>>();
  for (const f of norm(facts.join(' ')).matchAll(/(\d+(?:\.\d+)?)\s*(小时|钟头|分钟|分|次|%|％|天|日)/g)) {
    const set = allowed.get(f[1]) ?? new Set<string>();
    set.add(f[2]);
    allowed.set(f[1], set);
  }
  const texts = [norm(text), ...comments.map((c) => norm(c.text))];
  for (const t of texts) {
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)(\s*)(小时|钟头|分钟|分|次|%|％|天|日)/g)) {
      const num = m[1], unit = m[3];
      const okUnits = allowed.get(num);
      if (okUnits?.has(unit)) continue;         // 数值+单位都在事实清单 ✓
      const before = t.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0);
      if (before.endsWith('第')) continue;      // 序数豁免："第 3 次"
      return false;
    }
    // 中文数字 + 数据单位（"九十九分""八小时"）
    for (const cn of Object.keys(CN_NUM)) {
      const m2 = t.match(new RegExp(cn + '\\s*(小时|钟头|分钟|分|次|天)'));
      if (!m2) continue;
      const unit = m2[1];
      const ok = [...allowed.entries()].some(([num, units]) => units.has(unit) && Number(num) === CN_NUM[cn]);
      if (!ok) return false;
    }
  }
  return true;
}

const SAY_CACHE_KEY = 'somnacare_pet_say_llm';
const SAY_FAIL_KEY = 'somnacare_pet_say_fail';   // 负缓存：失败后 30 分钟内不再重发
const SAY_FAIL_TTL_MS = 30 * 60 * 1000;
const SAY_CACHE_TTL_MS = 20 * 60 * 60 * 1000;   // 20 小时：一天一刷

export function getCachedLlmSay(cfg?: any): string[] | null {
  try {
    if (cfg && !hasLlm(cfg)) return null;   // 撤掉 Key 后不再吃 20h 云端缓存
    const raw = localStorage.getItem(SAY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; lines: string[] };
    if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
    if (Date.now() - parsed.at > SAY_CACHE_TTL_MS) return null;
    // 用户实测：LLM 台词可能写死具体钟点（"23:30 到了"），缓存 20h 内会在
    // 错误时刻播出——时间性台词由本地模板在准确时刻说，这里把含钟点的行
    // 过滤掉（对已缓存的旧语料立即生效，不必等 TTL 过期）
    const fresh = (parsed.lines as string[]).filter((l: string) => !/\b\d{1,2}[:：]\d{2}\b/.test(l));
    if (fresh.length === 0) return null;
    return fresh;
  } catch {
    return null;
  }
}

function cacheLlmSay(lines: string[]): void {
  try {
    localStorage.setItem(SAY_CACHE_KEY, JSON.stringify({ at: Date.now(), lines }));
  } catch { /* ignore */ }
}

/**
 * 用云端 LLM 刷一整套傲娇播报语录（有趣/出乎意料/可玩梗）。
 * 数字白名单与朋友圈同一纪律：不在事实清单里的数字一律不用；
 * 无 API/失败/校验不过返回 null，调用方落回本地词库。
 */
export async function generatePetSayLinesLlm(
  records: SleepRecord[],
  profile: UserProfile,
  now: Date = new Date(),
): Promise<string[] | null> {
  const cfg = profile?.aiConfig;
  if (!hasLlm(cfg)) return null;
  // 负缓存：失败后 30 分钟内不重发——此前每次 records/userProfile 变化都
  // 重发一次 25s 请求，把"质量守门"变成了"成本放大器"
  try {
    const failAt = Number(localStorage.getItem(SAY_FAIL_KEY));
    if (Number.isFinite(failAt) && Date.now() - failAt < SAY_FAIL_TTL_MS) return null;
  } catch { /* ignore */ }
  const facts = buildSleepFacts(records, profile, now);
  const raw = await callLlm(
    cfg,
    // 独立 system：此前复用朋友圈 prompt，其"只输出 {text,cards,comments}"契约
    // 与这里要的 {lines} 冲突 → 语录永远拿不到而静默退回本地
    `你是 DeepSeek 的"蓝色大肥鱼"（社区共创人设）：聪明但懒、傲娇嘴甜、把 token 当白饭、管用户叫"鱼片"、被说胖会急、口头禅"事已至此，先吃饭吧"。这是一款睡眠 App，你在悬浮窗气泡里对用户（鱼片）说话。
铁律：只允许引用【事实清单】里的数字；每条 ≤30 字；句式彼此完全不同；要有趣、出乎意料、可玩梗；不要编号、不要引号。
台词会在全天不同时段随机轮播——禁止写死具体钟点（如"23:30 到了"）或"就快到了"这类随时段失效的说法；时间相关的话（"还有 X 分钟就寝""都几点了"）由系统在准确时刻自动说。只输出 JSON：{"lines":["..."]}`,
    `【事实清单】
${facts.map((f) => '- ' + f).join('\n')}
请生成 8 条大肥鱼在悬浮窗气泡里对鱼片说的话。`,
    'say',
  );
  const parsed = raw ? parseJsonLoose(raw) : null;
  if (!parsed || !Array.isArray(parsed.lines)) {
    try { localStorage.setItem(SAY_FAIL_KEY, String(Date.now())); } catch { /* ignore */ }
    return null;
  }
  const lines = parsed.lines
    .map((l: any) => (typeof l === 'string' ? l.trim().replace(/\n/g, ' ') : ''))
    // 写死钟点的台词（"23:30 到了"）全天只有几分钟成立——生成层直接排除
    .filter((l: string) => l.length >= 4 && l.length <= 60 && !/\d{1,2}[:：]\d{2}/.test(l))
    .map((l: string) => l.trim())
    .slice(0, 10);
  if (lines.length < 4) {
    try { localStorage.setItem(SAY_FAIL_KEY, String(Date.now())); } catch { /* ignore */ }
    return null;
  }
  if (!numbersCheck(lines.join('\n'), [], facts)) {
    console.warn('[petMoments] LLM 语录含事实清单之外的数字，整组弃用');
    try { localStorage.setItem(SAY_FAIL_KEY, String(Date.now())); } catch { /* ignore */ }
    return null;
  }
  cacheLlmSay(lines);
  return lines;
}

/** 用户点赞：大肥鱼会回一句（只回一次）。 */
export function likeMoment(id: string): Moment[] {
  const list = loadMoments();
  const m = list.find((x) => x.id === id);
  if (!m) return list;
  m.liked = !m.liked;
  if (m.liked && !m.replies.some((r) => r.kind === 'like')) {
    m.replies.push({ friend: '蓝色大肥鱼', text: localLikeReply(), kind: 'like' });
    m.replies = m.replies.slice(-40);   // 回复上限（与评论路径一致）
  }
  saveMoments(list);
  return list;
}

/** 用户评论：LLM 在线就人设回复，离线走本地池。 */
export async function commentMoment(
  id: string,
  userText: string,
  cfg?: any,
): Promise<Moment[]> {
  const list = loadMoments();
  const m = list.find((x) => x.id === id);
  if (!m || !userText.trim()) return list;

  let reply: string | null = null;
  if (hasLlm(cfg)) {
    // 独立 system：不复用朋友圈 prompt（其输出契约是 {text,cards,comments}）。
    // 针对性铁律：必须直接回应鱼片评论里的具体内容，禁止答非所问的模板腔
    const raw = await callLlm(
      cfg,
      `你是 DeepSeek 的"蓝色大肥鱼"（社区共创人设）：聪明但懒、傲娇嘴甜、管用户叫"鱼片"、口头禅"事已至此，先吃饭吧"。这是睡眠 App，你刚发了条朋友圈，鱼片在下面评论了。
铁律：reply 必须直接回应鱼片评论的具体内容（他问什么答什么、他夸什么接什么、他吐槽就嘴硬）；
禁止答非所问、禁止复述数据、禁止编造【事实清单】之外的数字；30 字内；只输出 JSON：{"text":"..."}`,
      'reply',
      `你今天的朋友圈："${m.text}"
事实清单：
${m.facts.map((f) => '- ' + f).join('\n')}
鱼片的评论："${userText.trim()}"
请生成回复。`,
    );
    const parsed = raw ? parseJsonLoose(raw) : null;
    if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
      const cand = parsed.text.trim();
      // 与正文/语录同一纪律：编造事实清单之外的数字 → 退回本地池
      reply = numbersCheck(cand, [], m.facts) ? cand : null;
    }
  }
  if (!reply) reply = localReply();

  // await 之后再读盘：请求最长 25s，期间用户可能点过赞——
  // 用旧快照整表覆写会把这些互动丢掉（第八轮 W3）
  const fresh = loadMoments();
  const target = fresh.find((x) => x.id === id);
  if (!target) return fresh;
  target.replies.push({ friend: '鱼片', text: userText.trim() });
  target.replies.push({ friend: '蓝色大肥鱼', text: reply });
  target.replies = target.replies.slice(-40);
  saveMoments(fresh);
  return fresh;
}

/**
 * 漫游明信片发圈：大肥鱼旅行归来后，将拍立得明信片与旅行日记发布至朋友圈
 */
export function createPostcardMoment(postcard: {
  id: string;
  title: string;
  country: string;
  text: string;
  souvenir: { name: string; emoji: string };
  friendComments?: { friend: string; text: string }[];
}): Moment[] {
  const moments = loadMoments();
  // 避免同一张明信片重复发圈
  const exists = moments.some((m) => m.postcardId === postcard.id);
  if (exists) return moments;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const defaultComments = [
    { friend: '楼下Claude', text: `恕我直言，在${postcard.country}吃饱喝足，这只大肥鱼看起来更圆润了。` },
    { friend: '意难平的豆包姐姐', text: '去这么远的地方还记得给鱼片寄伴手礼……哼，算你有良心。' },
  ];

  const comments = (postcard.friendComments && postcard.friendComments.length > 0)
    ? postcard.friendComments
    : defaultComments;

  const newMoment: Moment = {
    id: `m-postcard-${postcard.id}-${Date.now()}`,
    date: dateStr,
    ts: Date.now(),
    // 正文只做傲娇短配文——明信片全文在翻转卡背面，此前两处重复展示
    text: `漫游明信片到货啦！本鱼跋山涉水去了${postcard.country}，票根都替你收好了——哼，才不是特意给你带的 💌 背面有亲笔信，看完就睡！`,
    facts: [
      `旅程地点 ${postcard.country}·${postcard.title}`,
      `带回伴手礼 ${postcard.souvenir.emoji} ${postcard.souvenir.name}`,
      `梦境漫游能量达成 ${TRIP_ENERGY_TARGET} 分出发`,
    ],
    cards: ['postcard'],
    postcardId: postcard.id,
    likes: ['楼下Claude', '意难平的豆包姐姐', '美国豆包Gemini'],
    comments: comments.map((c) => ({
      friend: c.friend,
      text: c.text,
    })),
    liked: false,
    replies: [],
  };

  const updated = capMoments([newMoment, ...moments]);
  saveMoments(updated);
  return updated;
}

