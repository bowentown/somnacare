import React, { useEffect, useRef, useState } from 'react';
import { X, Heart, MessageCircle, Loader2, RefreshCw } from 'lucide-react';
import type { SleepRecord, UserProfile } from '../types/sleep';
import { useModalA11y } from '../utils/modalA11y';
import {
  ensureTodayMoment,
  isRegenCoolingDown,
  markRegenDone,
  likeMoment,
  commentMoment,
  loadMoments,
  type Moment,
  type MomentCard,
  MOMENTS_CAP_PRESETS,
  capMoments,
  getMomentsCap,
  setMomentsCap,
} from '../utils/petMoments';
import { getPetSkin } from '../utils/petOverlay';
import { stripMd } from '../utils/markdown';
import { loadTravelState } from '../services/travelService';
import { getPostcardById, thumbUrlOf } from '../data/travelPostcards';
import type { TravelPostcard } from '../types/travel';
import { toLocalDateString } from '../utils/dateUtils';
import { PostcardCard } from './travel/PostcardCard';
import { TravelCodexModal } from './travel/TravelCodexModal';
import { ShareCardModal } from './ShareCardModal';
import { APP_THEMES } from '../utils/themeStyles';
import { getTravelProgress } from '../services/travelService';

interface Props {
  records: SleepRecord[];
  userProfile: UserProfile;
  onClose: () => void;
}

/** "今天 / 昨天 / MM-dd" */
function dayLabel(date: string): string {
  const now = new Date();
  const yDate = new Date(now);
  yDate.setDate(yDate.getDate() - 1);   // 由 Date 归一化跨月/跨年：此前手算在每月 1 号得出 "00" 日
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yest = `${yDate.getFullYear()}-${pad(yDate.getMonth() + 1)}-${pad(yDate.getDate())}`;
  if (date === today) return '今天';
  if (date === yest) return '昨天';
  return date.slice(5).replace('-', '/');
}

function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function factOf(facts: string[], prefix: string): string {
  const f = facts.find((x) => x.startsWith(prefix));
  return f ? f.slice(prefix.length).trim() : '';
}

const SELFIE_SRC = `${import.meta.env.BASE_URL || '/'}whale-selfie.png`;
const SELFIE_SRC_SAKURA = `${import.meta.env.BASE_URL || '/'}whale-selfie-sport.png`;

/** 配图卡（CSS 渲染零依赖，致敬 dsh-plugin-moments 的九宫格混合图卡）。 */
const CardView: React.FC<{ type: MomentCard; moment: Moment }> = ({ type, moment }) => {
  if (type === 'postcard') {
    return (
      <div className="w-full py-1">
        <PostcardCard postcardId={moment.postcardId} />
      </div>
    );
  }
  if (type === 'selfie') {
    // 皮肤值只有 'default' / 'sakura'——此前判的是改名前的 'sport'，恒为
    // false，自拍卡永远不跟随服装。走 petOverlay 的单一真相源
    const isSakura = getPetSkin() === 'sakura';
    // 自拍轮换：已解锁的旅行明信片按日期轮换当"旅行自拍"（同一天稳定、
    // 隔天换图）；一张都没解锁时回退默认自拍。用缩略图省流量
    const unlocked = loadTravelState()
      .unlockedCardIds.map((id) => getPostcardById(id))
      .filter((c): c is TravelPostcard => !!c);
    const dayKey = toLocalDateString().split('-').reduce((a, p) => a + Number(p), 0);
    const rotated = unlocked.length > 0 ? unlocked[dayKey % unlocked.length] : undefined;
    const src = rotated ? thumbUrlOf(rotated.imageUrl) : (isSakura ? SELFIE_SRC_SAKURA : SELFIE_SRC);
    return (
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-sky-500/30 to-blue-900/40 border border-slate-700/60 aspect-square flex items-center justify-center">
        <img
          src={src}
          alt={rotated ? `大肥鱼在${rotated.country}的旅行自拍` : '大肥鱼自拍'}
          className={rotated ? 'w-full h-full object-cover' : 'w-4/5 h-4/5 object-contain drop-shadow-[0_2px_8px_rgba(56,189,248,0.35)]'}
        />
        <span className="absolute bottom-1 left-0 right-0 mx-auto w-fit px-1.5 py-0.5 rounded-md bg-black/50 text-[9px] font-bold text-sky-200 whitespace-nowrap">
          {rotated ? `旅行营业中 · ${rotated.country}` : '今日营业自拍 · 拒绝加班'}
        </span>
      </div>
    );
  }
  if (type === 'week') {
    // 战报口径（第 29 轮，用户定义）：周一起算、夜按醒来日归属——
    //   n = 达标（≥80 分）夜数 / x = 有记录夜数，大数字 n/x；
    //   m = 本周已过夜数 − x = 未记录的夜数。
    // 双格式解析：旧版动态的事实串是「近 N 日有 G 天」（快照冻结，不可重写），
    // 解析不到新串时回退旧口径——此前兜底 0/0 还宣称"全部有记录"，是当众撒谎
    const weekMatch = moment.facts.map((f) => f.match(/本周已过 (\d+) 天，达标 (\d+) 天/)).find(Boolean) ?? null;
    const recMatch = moment.facts.map((f) => f.match(/本周有记录 (\d+) 天，未记录 (\d+) 天/)).find(Boolean) ?? null;
    const legacyMatch = moment.facts.map((f) => f.match(/近 (\d+) 日有 (\d+) 天/)).find(Boolean) ?? null;
    let goodDays = 0;
    let recDays = 0;
    let missed: number | null = null;   // null = 旧口径快照，无从知晓未记录数
    if (weekMatch && recMatch) {
      goodDays = Number(weekMatch[2]);
      recDays = Number(recMatch[1]);
      missed = Number(recMatch[2]);
    } else if (legacyMatch) {
      recDays = Number(legacyMatch[1]);
      goodDays = Number(legacyMatch[2]);
    }
    const pct = weekMatch ? Math.min(100, Math.round((goodDays / Math.max(1, Number(weekMatch[1]))) * 100)) : 0;
    return (
      <div className="rounded-xl bg-gradient-to-br from-emerald-900/40 to-slate-900 border border-emerald-800/40 aspect-square p-2.5 flex flex-col justify-between">
        <p className="text-[9px] font-bold text-emerald-300">本周达标战报</p>
        <div>
          <p className="text-2xl font-black text-white leading-none">
            {/* 全新用户 0 条记录时 0/0 无意义 → 退化显示 */}
            {recDays === 0 ? <span>—</span> : <>{goodDays}<span className="text-xs text-slate-400 font-bold">/{recDays} 天</span></>}
          </p>
          {/* 用户定的文案：去掉"有/算"，一行放下（nowrap，窄卡不折行） */}
          <p className="text-[9px] text-slate-400 mt-0.5 whitespace-nowrap">
            {missed === null ? '按当时记录晚数计' : missed > 0 ? `${missed} 天未记录 · ≥80 达标` : '全部有记录 · ≥80 达标'}
          </p>
        </div>
        <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  // data：数据大字报
  const dur = factOf(moment.facts, '昨晚睡眠时长');
  const score = factOf(moment.facts, '昨晚睡眠评分');
  // 断行必须是设计出来的：此前 replace 首个空格 + 浏览器自行折行，
  // "8 小时 6 分"会被宽度随机劈成"8 小时 6 / 分"。"0 分"单独成行也很难看，
  // 整点显示"7 小时"即可（7 小时 0 分 == 7 小时，不是编数字）
  const durMatch = dur?.match(/(\d+)\s*小时\s*(\d+)\s*分/);
  const hOnly = dur?.match(/(\d+)\s*小时/);
  let big: string;
  if (durMatch) {
    big = durMatch[2] === '0' ? `${durMatch[1]} 小时` : `${durMatch[1]} 小时\n${durMatch[2]} 分`;
  } else if (hOnly) {
    big = `${hOnly[1]} 小时`;
  } else {
    big = dur || score || '无记录';
  }
  return (
    <div className="rounded-xl bg-gradient-to-br from-sky-900/50 to-slate-900 border border-sky-800/40 aspect-square p-2.5 flex flex-col justify-between overflow-hidden">
      <p className="text-[9px] font-bold text-sky-300">睡眠数据大字报</p>
      <p className="text-lg font-black text-white leading-tight whitespace-pre-line">{big}</p>
      <p className="text-[9px] text-slate-400">喂 token 的是本鱼，睡觉的是你</p>
    </div>
  );
};

/**
 * 大肥鱼的朋友圈：仿朋友圈流式 UI。
 * 文案由真实睡眠事实生成（DeepSeek API 可用时走 LLM，否则本地傲娇模板），
 * 每张卡片底部都展示生成时的事实清单——"每句话都有出处"。
 */
export const MomentsOverlay: React.FC<Props> = ({ records, userProfile, onClose }) => {
  const momentsA11y = useModalA11y(true, onClose, '大肥鱼的朋友圈');
  const [moments, setMoments] = useState<Moment[]>(() => loadMoments());
  const [busy, setBusy] = useState(false);
  const [commenting, setCommenting] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [showCodex, setShowCodex] = useState(false);
  const [showShareCard, setShowShareCard] = useState(false);
  const [momentsCap, setMomentsCapState] = useState(() => getMomentsCap());
  const inputRef = useRef<HTMLInputElement>(null);

  const travelProgress = getTravelProgress();

  const hasAi =
    (!!userProfile?.aiConfig?.provider === true &&
      (userProfile.aiConfig.provider === 'deepseek'
        ? !!userProfile.aiConfig.deepseekApiKey
        : userProfile.aiConfig.provider === 'custom_openai'
        ? !!userProfile.aiConfig.customApiKey && !!userProfile.aiConfig.customBaseUrl
        : false));

  // 首次打开自动补今天的动态（已有则跳过）
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBusy(true);
      try {
        const res = await ensureTodayMoment(records, userProfile);
        if (!cancelled) setMoments(res.moments);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const regenerate = async () => {
    // M6 冷却接线（第 45 轮死代码扫描发现：isRegenCoolingDown/markRegenDone
    // 建好后从未被调用——冷却形同虚设，每次点击都直打 LLM）
    if (isRegenCoolingDown()) {
      setNote('刚生成过啦，让本鱼歇几分钟再来');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await ensureTodayMoment(records, userProfile, new Date(), true);
      markRegenDone();   // 成功后才起 10 分钟冷却（失败的生成不占用）
      setMoments(res.moments);
      setNote(res.generated ? '大肥鱼发新动态了！' : '今天她已经发过了～');
    } finally {
      setBusy(false);
    }
  };

  const toggleLike = (id: string) => setMoments(likeMoment(id));

  const sendComment = async (id: string) => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setBusy(true);
    try {
      setMoments(await commentMoment(id, text, userProfile?.aiConfig));
    } finally {
      setBusy(false);
      setCommenting(null);
    }
  };

  return (
    <div
      ref={momentsA11y.ref}
      {...momentsA11y.dialogProps}
      className="fixed inset-0 z-[90] flex flex-col bg-slate-950"
      style={{ backgroundColor: '#020617' }}
    >
      {/* 顶栏：两行布局——第 20 轮实测 5 个胶囊 + 标题挤在 390px 一行里，
          flex 默认收缩到 min-content（中文 = 一个字），标题和胶囊全部竖排。
          行 1：头像+标题（min-w-0 truncate）+ 关闭；行 2：胶囊横向滚动 */}
      <div className="shrink-0 px-4 pt-3 pb-2.5 border-b border-slate-800/80 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-xl shrink-0">🐋</div>
            <div className="min-w-0">
              <p className="text-xs font-black text-white leading-tight truncate">大肥鱼的朋友圈</p>
              <p className="text-[9px] text-slate-400 truncate">蓝色大肥鱼 · 聪明但懒 · 事已至此，先吃饭吧</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-800/80 border border-slate-700 text-white flex items-center justify-center cursor-pointer active:scale-90 transition-transform shrink-0"
            aria-label="关闭朋友圈"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="relative">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setShowShareCard(true)}
            className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full bg-indigo-950/80 border border-indigo-700/60 text-[10px] font-bold text-indigo-200 flex items-center gap-1 cursor-pointer active:scale-95 transition-transform"
          >
            <span>🖼️</span>
            <span>睡眠卡</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const i = MOMENTS_CAP_PRESETS.indexOf(momentsCap);
              const next = MOMENTS_CAP_PRESETS[(i + 1) % MOMENTS_CAP_PRESETS.length];
              setMomentsCap(next);
              setMomentsCapState(next);
              setMoments(capMoments(loadMoments()));
            }}
            className="px-2.5 py-1.5 rounded-full bg-white/10 border border-white/20 text-[10px] font-bold text-white flex items-center gap-1 cursor-pointer active:scale-95 transition-transform"
            aria-label={`朋友圈容量 ${momentsCap} 条，点击切换到下一档`}
          >
            <span>📦</span>
            <span>容量 {momentsCap}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowCodex(true)}
            className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full bg-indigo-950/80 border border-indigo-700/60 text-[10px] font-bold text-indigo-200 flex items-center gap-1 cursor-pointer active:scale-95 transition-transform"
          >
            <span>🗺️</span>
            <span>图鉴 {travelProgress.unlockedCount}/{travelProgress.totalCount}</span>
          </button>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={busy}
            className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full bg-white/10 border border-white/20 text-[10px] font-bold text-white flex items-center gap-1 cursor-pointer disabled:opacity-40 active:scale-95 transition-transform"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            生成今日动态
          </button>
        </div>
        {/* 右缘渐隐：胶囊可横向滚动（no-scrollbar 藏了滚动条） */}
        <div aria-hidden className="pointer-events-none absolute right-0 top-0 bottom-0 w-8" style={{ background: 'linear-gradient(90deg, transparent, #020617)' }} />
        </div>
      </div>

      {!hasAi && (
        <p className="px-4 pt-3 text-[10px] text-slate-400 leading-relaxed shrink-0">
          未配置 DeepSeek API：文案走本地傲娇模板（同样基于真实数据）。
          在「AI 顾问」里配置后，她会写得更有梗。
        </p>
      )}
      {note && <p className="px-4 pt-2 text-[10px] text-sky-300 font-bold shrink-0">{note}</p>}

      {/* 朋友圈时间线 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {moments.length === 0 && !busy && (
            <p className="text-center text-xs text-slate-400 pt-10">她还没发过动态……去睡一觉再来催她。</p>
          )}
          {moments.map((m) => (
            <div key={m.id} className="flex gap-2.5">
              <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-lg">
                🐋
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="text-[11px] font-black text-sky-300">蓝色大肥鱼</p>
                <p className="text-xs text-slate-100 leading-relaxed whitespace-pre-wrap">{stripMd(m.text)}</p>

                {/* 配图卡：九宫格布局（1 张大图 / 2-3 张并排 / 明信片独占） */}
                {m.cards.length > 0 && (
                  <div className={`grid gap-1 ${
                    m.cards.includes('postcard')
                      ? 'grid-cols-1 w-full max-w-[280px]'
                      : m.cards.length === 1
                      ? 'grid-cols-1 max-w-[190px]'
                      : m.cards.length === 2
                      ? 'grid-cols-2'
                      : 'grid-cols-3'
                  }`}>
                    {m.cards.map((c, i) => (
                      <CardView key={i} type={c} moment={m} />
                    ))}
                  </div>
                )}

                {/* 事实清单：每句都有出处 */}
                <details className="text-[9px] text-slate-400">
                  <summary className="cursor-pointer select-none">数据来源（她不许自己编数字）</summary>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {m.facts.map((f, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded-md bg-slate-800/80 border border-slate-700/60 text-[9px] text-slate-400">
                        {f}
                      </span>
                    ))}
                  </div>
                </details>

                <div className="flex items-center gap-4 pt-0.5">
                  <span className="text-[9px] text-slate-400">{dayLabel(m.date)} {clockLabel(m.ts)}</span>
                  <button
                    type="button"
                    onClick={() => toggleLike(m.id)}
                    className="flex items-center gap-1 text-[10px] font-bold cursor-pointer active:scale-90 transition-transform"
                  >
                    <Heart className={`w-3.5 h-3.5 ${m.liked ? 'text-rose-400 fill-rose-400' : 'text-slate-400'}`} />
                    <span className={m.liked ? 'text-rose-300' : 'text-slate-400'}>{m.liked ? '已赞' : '赞'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCommenting(commenting === m.id ? null : m.id);
                      setDraft('');
                      setTimeout(() => inputRef.current?.focus(), 50);
                    }}
                    className="flex items-center gap-1 text-[10px] font-bold text-slate-400 cursor-pointer active:scale-90 transition-transform"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    评论
                  </button>
                </div>

                {/* 点赞 + 评论区：朋友圈式灰卡（AI 好友生态） */}
                {(m.likes.length > 0 || m.liked || m.comments.length > 0 || m.replies.length > 0) && (
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 px-2.5 py-2 space-y-1.5">
                    {(m.likes.length > 0 || m.liked) && (
                      <p className="text-[10px] leading-relaxed flex flex-wrap items-center gap-1">
                        <Heart className="w-3 h-3 text-rose-400 fill-rose-400 shrink-0" />
                        <span className="text-sky-400 font-bold">{[...(m.liked ? ['鱼片'] : []), ...m.likes].join('、')}</span>
                        <span className="text-slate-400">觉得很赞</span>
                      </p>
                    )}
                    {(m.comments.length > 0 || m.replies.length > 0) && (
                      <div className="space-y-1">
                        {m.comments.map((c, i) => (
                          <p key={`c${i}`} className="text-[10px] leading-relaxed">
                            <span className="text-sky-400 font-bold">{c.friend}：</span>
                            <span className="text-slate-300">{stripMd(c.text)}</span>
                          </p>
                        ))}
                        {m.replies.map((r, i) => (
                          <p key={`r${i}`} className="text-[10px] leading-relaxed">
                            <span className={`font-bold ${r.friend === '鱼片' ? 'text-emerald-400' : 'text-sky-400'}`}>{r.friend}：</span>
                            <span className="text-slate-300">{stripMd(r.text)}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {commenting === m.id && (
                  <div className="flex gap-1.5">
                    <input
                      ref={inputRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void sendComment(m.id); }}
                      placeholder="和她说点什么……"
                      maxLength={80}
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => void sendComment(m.id)}
                      disabled={busy || !draft.trim()}
                      className="px-3 rounded-xl bg-sky-600 text-white text-[11px] font-bold cursor-pointer disabled:opacity-40 active:scale-95 transition-transform"
                    >
                      发送
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

      {showCodex && <TravelCodexModal onClose={() => setShowCodex(false)} />}
      <ShareCardModal
        open={showShareCard}
        onClose={() => setShowShareCard(false)}
        records={records}
        theme={APP_THEMES[userProfile.themeColor as keyof typeof APP_THEMES] || APP_THEMES.midnight}
      />
    </div>
  );
};

