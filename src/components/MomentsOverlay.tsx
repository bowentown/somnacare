import React, { useEffect, useRef, useState } from 'react';
import { X, Heart, MessageCircle, Loader2, RefreshCw, Image as ImageIcon, Package, Map } from 'lucide-react';
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
const CardView: React.FC<{
  type: MomentCard;
  moment: Moment;
  selfieCtx: { rotated?: TravelPostcard; isSakura: boolean };
}> = ({ type, moment, selfieCtx }) => {
  if (type === 'postcard') {
    return (
      <div className="w-full py-1">
        <PostcardCard postcardId={moment.postcardId} />
      </div>
    );
  }
  if (type === 'selfie') {
    // 皮肤跟随 petOverlay 单一真相源；轮换明信片由父级算好传入
    const { rotated, isSakura } = selfieCtx;
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
    // 战报口径（第 29 轮，用户定义）：周一起算、夜按"放下手机那晚"归属——
    //   n = 达标（≥80 分）夜数 / x = 已度过夜数；missed = 未记录夜数。
    // 旧快照只有"近 N 日"口径，保留兼容；没有可读数据时返回 null，
    // 不再画一张只有破折号的空卡（周一 / 本周无记录）。
    const weekMatch = moment.facts.map((f) => f.match(/本周已过 (\d+) 天，达标 (\d+) 天/)).find(Boolean) ?? null;
    const recMatch = moment.facts.map((f) => f.match(/本周有记录 (\d+) 天，未记录 (\d+) 天/)).find(Boolean) ?? null;
    const slotsMatch = moment.facts.map((f) => f.match(/本周逐夜 ([0-2-]{7})/)).find(Boolean) ?? null;
    const legacyMatch = moment.facts.map((f) => f.match(/近 (\d+) 日有 (\d+) 天/)).find(Boolean) ?? null;
    let goodDays = 0;
    let recDays = 0;
    let elapsedDays = 0;
    let missed: number | null = null;
    if (weekMatch && recMatch) {
      elapsedDays = Number(weekMatch[1]);
      goodDays = Number(weekMatch[2]);
      recDays = Number(recMatch[1]);
      missed = Number(recMatch[2]);
    } else if (legacyMatch) {
      recDays = Number(legacyMatch[1]);
      goodDays = Number(legacyMatch[2]);
      elapsedDays = recDays;
    }
    if (elapsedDays <= 0 || recDays <= 0) return null;

    const pct = Math.min(100, Math.round((goodDays / Math.max(1, elapsedDays)) * 100));
    const slots: string[] = slotsMatch
      ? slotsMatch[1].split('')
      : Array.from({ length: 7 }, (_, i) => {
          if (i >= elapsedDays) return '-';
          if (i < goodDays) return '2';
          if (i < recDays) return '1';
          return '0';
        });
    const slotTone = (s: string): string =>
      s === '2' ? 'bg-emerald-400'
        : s === '1' ? 'bg-amber-300'
          : s === '0' ? 'bg-slate-600'
            : 'bg-slate-800 opacity-50';

    return (
      <div className="rounded-xl bg-gradient-to-br from-emerald-950/70 to-slate-900 border border-emerald-800/40 aspect-square p-2.5 flex flex-col justify-between">
        <p className="text-[9px] font-bold text-emerald-300">本周达标战报</p>
        <div className="flex items-end justify-between gap-1">
          <div>
            <p className="text-2xl font-black text-white leading-none">
              {goodDays}<span className="text-xs text-slate-400 font-bold">/{elapsedDays}</span>
            </p>
            <p className="text-[9px] text-slate-400 mt-0.5">晚达标</p>
          </div>
          <span className="text-[9px] font-mono text-emerald-300">{pct}%</span>
        </div>
        <div>
          <div className="flex gap-[3px]">
            {slots.map((s, i) => (
              <span key={i} className={`flex-1 h-1.5 rounded-full ${slotTone(s)}`} />
            ))}
          </div>
          <p className="text-[9px] text-slate-400 mt-0.5 whitespace-nowrap">
            {missed !== null && missed > 0 ? `${missed} 晚未记录` : '每晚都有记录'}
          </p>
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

  // 自拍轮换上下文提升（第 81 轮性能）：此前每张自拍卡每次渲染都要
  // JSON.parse 一次旅行状态；评论输入打字会触发父级重渲染，逐卡重复解析
  const selfieCtx = React.useMemo(() => {
    const unlocked = loadTravelState()
      .unlockedCardIds.map((id) => getPostcardById(id))
      .filter((c): c is TravelPostcard => !!c);
    const dayKey = toLocalDateString().split('-').reduce((a, p) => a + Number(p), 0);
    return {
      rotated: unlocked.length > 0 ? unlocked[dayKey % unlocked.length] : undefined,
      isSakura: getPetSkin() === 'sakura',
    };
  }, [moments]);

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
            <div className="w-9 h-9 rounded-xl overflow-hidden bg-slate-900 border border-white/10 flex items-center justify-center shrink-0">
              <img
                src={`${import.meta.env.BASE_URL || '/'}whale-selfie.png`}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
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
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setShowShareCard(true)}
            className="shrink-0 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-3 text-[10px] font-bold text-slate-200 cursor-pointer active:scale-95 transition-transform"
          >
            <ImageIcon className="w-3.5 h-3.5 text-indigo-300" />
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
            className="shrink-0 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-3 text-[10px] font-bold text-slate-200 cursor-pointer active:scale-95 transition-transform"
            aria-label={`朋友圈容量 ${momentsCap} 条，点击切换到下一档`}
          >
            <Package className="w-3.5 h-3.5 text-slate-400" />
            <span>容量 {momentsCap}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowCodex(true)}
            className="shrink-0 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-sky-400/25 bg-sky-500/10 px-3 text-[10px] font-bold text-sky-200 cursor-pointer active:scale-95 transition-transform"
          >
            <Map className="w-3.5 h-3.5 text-sky-300" />
            <span>图鉴 {travelProgress.unlockedCount}/{travelProgress.totalCount}</span>
          </button>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={busy}
            className="shrink-0 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/15 bg-white/10 px-3 text-[10px] font-bold text-white cursor-pointer disabled:opacity-40 active:scale-95 transition-transform"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            生成动态
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
          {moments.length === 0 && busy && (
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 p-4 animate-pulse" aria-label="正在生成动态">
              <div className="h-3.5 w-1/3 bg-white/10 rounded-full mb-3" />
              <div className="h-3 w-full bg-white/10 rounded-full mb-2" />
              <div className="h-3 w-5/6 bg-white/10 rounded-full" />
              <p className="text-[11px] text-sky-300/80 font-bold pt-3">大肥鱼正在写今天的动态…</p>
            </div>
          )}
          {moments.map((m) => (
            <div key={m.id} className="flex gap-2.5">
              <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-lg">
                🐋
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="text-[11px] font-black text-sky-300">蓝色大肥鱼</p>
                <p className="text-xs text-slate-100 leading-relaxed whitespace-pre-wrap break-words">{stripMd(m.text)}</p>

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
                      <CardView key={i} type={c} moment={m} selfieCtx={selfieCtx} />
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
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-[11px] text-white placeholder:text-slate-400 outline-none focus:border-sky-500"
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

