/**
 * AI 顾问的多会话数据层（第 25 轮）：
 *
 * 存储键沿用 somnacare_chat_history（备份/恢复链路零改动）：
 *  - 旧形状：ChatMessage[]（平铺消息流）
 *  - 新形状：{ v: 1, sessions: ChatSession[], activeId }
 * 读取时按形状自动适配——旧数据整体迁移为第一段会话，旧备份恢复后同样生效。
 *
 * 会话命名 = 首条用户提问截断（不靠 LLM，离线可用、即时）。
 */
import { ChatMessage } from '../types/sleep';
import { stripMd } from './markdown';

export const CHAT_KEY = 'somnacare_chat_history';
/** 单会话消息上限（沿用旧版 120 条） */
const MAX_MESSAGES = 120;
/** 会话数上限：超过时最旧的自动让位（updatedAt 排序） */
const MAX_SESSIONS = 30;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ChatState {
  sessions: ChatSession[];
  activeId: string;
}

export function freshSession(): ChatSession {
  const now = Date.now();
  return {
    id: `sess-${now}-${Math.round(Math.random() * 1e4)}`,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** 会话标题 = 首条用户提问（截 18 字，不靠模型） */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '新对话';
  const text = stripMd(firstUser.content).replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

/** 与旧版同口径的消息清洗（空串/占位符/非法角色剔除） */
function sanitizeMessages(list: unknown): ChatMessage[] {
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter(
    (m): m is ChatMessage =>
      !!m && typeof (m as ChatMessage).content === 'string' &&
      (m as ChatMessage).content.trim() !== '' && (m as ChatMessage).content.trim() !== '……' &&
      ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant')
  );
}

export function loadChatState(): ChatState {
  try {
    const saved = localStorage.getItem(CHAT_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        // 旧版平铺消息流：整体迁移为第一段会话
        const msgs = sanitizeMessages(parsed);
        if (msgs.length > 0) {
          const s: ChatSession = {
            id: `sess-${Date.now()}`,
            title: deriveTitle(msgs) === '新对话' ? '历史对话' : deriveTitle(msgs),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: msgs,
          };
          return { sessions: [s], activeId: s.id };
        }
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)) {
        const raw = parsed as { sessions: unknown[]; activeId?: unknown };
        const sessions = (raw.sessions as unknown[])
          .map((s, i): ChatSession => {
            const o = (s ?? {}) as Record<string, unknown>;
            return {
              id: typeof o.id === 'string' && o.id ? o.id : `sess-${Date.now()}-${i}`,
              title: typeof o.title === 'string' && o.title ? o.title : '对话',
              createdAt: Number.isFinite(o.createdAt as number) ? (o.createdAt as number) : Date.now(),
              updatedAt: Number.isFinite(o.updatedAt as number) ? (o.updatedAt as number) : Date.now(),
              messages: sanitizeMessages(o.messages),
            };
          });
        if (sessions.length > 0) {
          const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
          const activeId = typeof raw.activeId === 'string' && sorted.some((s) => s.id === raw.activeId)
            ? raw.activeId
            : sorted[0].id;
          return { sessions: sorted, activeId };
        }
      }
    }
  } catch { /* 损坏则回到全新会话 */ }
  const s = freshSession();
  return { sessions: [s], activeId: s.id };
}

/** 持久化：排序（最近在前）+ 双重上限（会话数/消息数）。
 *  返回是否落盘成功——配额满时先裁最旧的一半会话重试一次，仍失败
 *  则如实返回 false（此前静默吞掉，用户以为已保存，重启后整段聊天
 *  消失，第 81 轮审计），由调用方提示。 */
export function persistChatState(state: ChatState): boolean {
  const sortAndCap = (list: ChatSession[]): ChatSession[] =>
    [...list]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS)
      .map((s) => ({ ...s, messages: s.messages.slice(-MAX_MESSAGES) }));
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ v: 1, sessions: sortAndCap(state.sessions), activeId: state.activeId }));
    return true;
  } catch { /* 配额满 → 降级重试 */ }
  try {
    // 降级：只保留最近 8 个会话、每会话最近 40 条
    const trimmed = sortAndCap(state.sessions)
      .slice(0, 8)
      .map((s) => ({ ...s, messages: s.messages.slice(-40) }));
    localStorage.setItem(CHAT_KEY, JSON.stringify({ v: 1, sessions: trimmed, activeId: state.activeId }));
    return true;
  } catch {
    return false;
  }
}

/** 相对时间标签（会话列表用）：今天 → HH:MM；今年 → M月D日；更早 → YYYY-M-D */
export function sessionTimeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return hm;
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
