import type { TravelPostcard, UserTravelState } from '../types/travel';
import { TRIP_POOL, getPostcardById } from '../data/travelPostcards';

const TRAVEL_STATE_KEY = 'somnacare_travel_state';

/**
 * 单次旅行所需梦境能量：200 分 ≈ 2–3 晚高质量睡眠（单晚评分 70–90）。
 * 此前测试期 80 一晚就能出发，图鉴解锁过快、旅行缺少期待感（第 56 轮
 * 用户定档 200）。展示端一律引用本常量，不要写死数字。
 */
export const TRIP_ENERGY_TARGET = 200;

export function getInitialTravelState(): UserTravelState {
  return {
    currentEnergy: 0,
    targetEnergy: TRIP_ENERGY_TARGET,
    totalTrips: 0,
    unlockedCardIds: [],
    souvenirInventory: [],
    goldStars: {},
    countedScores: {},
    pendingArrival: null,
  };
}

/** counted 键：夜睡=date，小睡=date|nap（分离账本，互不顶替）。 */
function napKey(date: string, nap?: boolean): string {
  return nap ? `${date}|nap` : date;
}

/** 记录删除后的能量回退（第 51 轮审计 P1）：该夜已计入的分差全额扣除，
 *  键移除——"记录是唯一真值源"，删除的夜不能再驱动图鉴进度。 */
export function processRecordRemoval(date: string, nap?: boolean): UserTravelState {
  const state = loadTravelState();
  const key = napKey(date, nap);
  const counted = state.countedScores[key];
  if (counted === undefined) return state;
  state.currentEnergy = Math.max(0, state.currentEnergy - counted);
  delete state.countedScores[key];
  saveTravelState(state);
  return state;
}

/**
 * 恢复一条被删除的记录（第 57 轮撤销）：
 * 删除时能量被扣回并可能被 max(0) 截断，直接把原分加回去会凭空多出能量
 * （例：余额 50、删 92 分夜 → 0；再加 92 变 92）。这里只补"实际扣掉的
 * 差额"，同时恢复 counted 账本。影子诊断条目不回溯（可接受）。
 */
export function restoreRecordScore(
  date: string,
  sleepScore: number,
  nap?: boolean,
  energyLost = 0,
): UserTravelState {
  const state = loadTravelState();
  state.currentEnergy = Math.max(0, state.currentEnergy + Math.max(0, energyLost));
  state.countedScores[napKey(date, nap)] = Math.max(0, Math.min(100, Math.round(sleepScore)));
  saveTravelState(state);
  return state;
}

/** 清洗 {cardId: 星级} / {date: 已计分} 形态的映射：只保留有限数值（防坏值串型累加） */
function sanitizeScoreMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v === 'object' && v !== null) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    }
  }
  return out;
}

export function loadTravelState(): UserTravelState {
  try {
    const raw = localStorage.getItem(TRAVEL_STATE_KEY);
    if (!raw) return getInitialTravelState();
    const parsed = JSON.parse(raw);
    return {
      currentEnergy: typeof parsed.currentEnergy === 'number' && Number.isFinite(parsed.currentEnergy) ? parsed.currentEnergy : 0,
      targetEnergy: TRIP_ENERGY_TARGET,
      totalTrips: typeof parsed.totalTrips === 'number' && Number.isFinite(parsed.totalTrips) ? parsed.totalTrips : 0,
      unlockedCardIds: Array.isArray(parsed.unlockedCardIds) ? parsed.unlockedCardIds.filter((x: unknown): x is string => typeof x === 'string') : [],
      souvenirInventory: Array.isArray(parsed.souvenirInventory) ? parsed.souvenirInventory.filter((x: unknown): x is string => typeof x === 'string') : [],
      goldStars: sanitizeScoreMap(parsed.goldStars),
      countedScores: sanitizeScoreMap(parsed.countedScores),
      pendingArrival: typeof parsed.pendingArrival === 'string' ? parsed.pendingArrival : null,
    };
  } catch {
    return getInitialTravelState();
  }
}

export function saveTravelState(state: UserTravelState): void {
  try {
    localStorage.setItem(TRAVEL_STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore storage errors */
  }
}

/**
 * 抽卡去重引擎：
 * 优先从未解锁卡池中抽取（纯保底无重复）；
 * 当卡池已全集齐时，进入二周目，增加该卡片的镀金星级。
 */
export function rollNextPostcard(
  state: UserTravelState,
  pool: TravelPostcard[] = TRIP_POOL
): { card: TravelPostcard; isNew: boolean } {
  const unlockedSet = new Set(state.unlockedCardIds);
  const unobtained = pool.filter((c) => !unlockedSet.has(c.id));

  if (unobtained.length > 0) {
    const randomIndex = Math.floor(Math.random() * unobtained.length);
    return { card: unobtained[randomIndex], isNew: true };
  }

  const allRandomIndex = Math.floor(Math.random() * pool.length);
  return { card: pool[allRandomIndex], isNew: false };
}

/**
 * 结算睡眠评分并注入旅行能量池（阈值 TRIP_ENERGY_TARGET）。
 * @param sleepScore 睡眠得分 (0~100)
 * @param date 记录日期（YYYY-MM-DD）：同一晚重复保存/补录时按"取更高分"去重，
 *             此前每次保存都全额充能——重跑一次睡眠追踪能量就翻倍
 */
/**
 * 重归类后重链能量账本（第 88 轮 D7）：作息切换会同时改 kind 与 date
 * （夜归属↔自然日差 1 天）——旧账本键全部指向不存在的键，表现为
 * "删除不回退能量、重录同分双计"（实测 85 → 170）。按记录 id 把每笔
 * 有主账迁到重归类后的新键；无主账（记录已删）原样保留。
 */
export function relinkLedgerAfterReclassify(
  before: Array<{ id: string; date: string; kind?: string }>,
  after: Array<{ id: string; date: string; kind?: string }>,
): void {
  const byId = new Map(after.map((r) => [r.id, r]));
  const state = loadTravelState();
  const next: Record<string, number> = {};
  let changed = false;
  for (const [key, score] of Object.entries(state.countedScores)) {
    const isNap = key.endsWith('|nap');
    const date = isNap ? key.slice(0, -4) : key;
    const owner = before.find((r) => r.date === date && (isNap ? r.kind === 'nap' : r.kind !== 'nap'));
    if (!owner) {
      next[key] = score;   // 无主账：不动（记录本身已不在，等删除路径自然清理）
      continue;
    }
    const moved = byId.get(owner.id);
    const newKey = moved ? (moved.kind === 'nap' ? `${moved.date}|nap` : moved.date) : key;
    if (newKey !== key) changed = true;
    next[newKey] = Math.max(next[newKey] ?? 0, score);
  }
  if (changed) {
    state.countedScores = next;
    saveTravelState(state);
  }
}

export function processDailySleepScore(sleepScore: number, date?: string, nap?: boolean): {
  state: UserTravelState;
  triggeredTrip: boolean;
  newCard?: TravelPostcard;
} {
  const state = loadTravelState();
  const safeScore = Math.max(0, Math.min(100, Math.round(sleepScore)));
  let energy = state.currentEnergy;
  if (date) {
    // counted 键按记录种类分离：夜睡用 date，小睡用 date|nap——此前同日
    // 先记夜睡再记小睡会共用一个键互相顶替 counted 值（能量账本错乱）
    const key = napKey(date, nap);
    const counted = state.countedScores[key] || 0;
    const delta = safeScore - counted;
    if (delta !== 0) {
      // 正差充能、负差扣回（向下修正/删除后重录低分不再永久虚高——
      // "记录是唯一真值源"，审计第 51 轮 P1：旧实现只有 delta>0 分支）
      energy = Math.max(0, energy + delta);
      state.countedScores[key] = safeScore;
    }
  } else {
    energy += safeScore;   // 无日期（理论不达）：维持旧的逐次累加语义
  }
  let triggered = false;
  let newCard: TravelPostcard | undefined;

  if (energy >= state.targetEnergy) {
    energy -= state.targetEnergy; // 溢出分数顺延保留至下一轮
    triggered = true;

    const { card, isNew } = rollNextPostcard(state);
    newCard = card;

    state.totalTrips += 1;
    if (isNew) {
      if (!state.unlockedCardIds.includes(card.id)) {
        state.unlockedCardIds.push(card.id);
      }
      if (!state.souvenirInventory.includes(card.souvenir.name)) {
        state.souvenirInventory.push(card.souvenir.name);
      }
    } else {
      state.goldStars[card.id] = (state.goldStars[card.id] || 0) + 1;
    }
    state.pendingArrival = card.id;
  }

  state.currentEnergy = energy;
  saveTravelState(state);
  return { state, triggeredTrip: triggered, newCard };
}

export function clearPendingArrival(): void {
  const state = loadTravelState();
  if (state.pendingArrival) {
    state.pendingArrival = null;
    saveTravelState(state);
  }
}

export function getTravelProgress(): {
  unlockedCount: number;
  totalCount: number;
  percentage: number;
} {
  const state = loadTravelState();
  // 进度只统计插画已就绪的大洲（TRIP_POOL）——不然达成率永远停在 36%
  const poolIds = new Set(TRIP_POOL.map((c) => c.id));
  const totalCount = TRIP_POOL.length;
  const unlockedCount = state.unlockedCardIds.filter((id) => poolIds.has(id)).length;
  const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
  return { unlockedCount, totalCount, percentage };
}

export { getPostcardById };
