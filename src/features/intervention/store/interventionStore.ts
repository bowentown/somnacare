import { createStore } from '../../../shared/store/createStore';
import { toLocalDateString } from '../../../shared/utils/dateUtils';

export const INTERVENTION_STORAGE_KEY = 'somnacare_intervention_v1';

export type BreathModeId = '478' | 'box' | '46';

export interface InterventionState {
  completedLessonIds: string[];
  ritualDate: string;
  completedRitualIds: string[];
  preferredBreathMode: BreathModeId;
}

export const RITUAL_ITEMS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'phone_down', label: '调暗屏幕并远离强光', hint: '睡前 30 分钟切至暖色护眼或放下高刺激信息流' },
  { id: 'brain_dump', label: '把待办写下来移出脑海', hint: '用一两行备忘托付明天的事，减少卧床反刍' },
  { id: 'breathing', label: '完成 3 轮慢速呼吸引导', hint: '通过延长呼气让节奏自然放缓' },
  { id: 'cool_dark', label: '整理昏暗偏凉的卧床环境', hint: '关灯拉帘，给身体明确的休息信号' },
];

function createDefaultState(): InterventionState {
  return {
    completedLessonIds: [],
    ritualDate: toLocalDateString(new Date()),
    completedRitualIds: [],
    preferredBreathMode: '478',
  };
}

function sanitizeState(raw: unknown): InterventionState {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  const completedLessonIds = Array.isArray(obj.completedLessonIds)
    ? [...new Set(obj.completedLessonIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
    : [];
  const today = toLocalDateString(new Date());
  const ritualDate = typeof obj.ritualDate === 'string' ? obj.ritualDate : today;
  const completedRitualIds =
    ritualDate === today && Array.isArray(obj.completedRitualIds)
      ? [...new Set(obj.completedRitualIds.filter((v): v is string => typeof v === 'string'))]
      : [];
  const preferredBreathMode: BreathModeId =
    obj.preferredBreathMode === 'box' || obj.preferredBreathMode === '46' ? obj.preferredBreathMode : '478';

  return {
    completedLessonIds,
    ritualDate: today,
    completedRitualIds,
    preferredBreathMode,
  };
}

function loadInitialState(): InterventionState {
  try {
    const raw = localStorage.getItem(INTERVENTION_STORAGE_KEY);
    if (!raw) return createDefaultState();
    return sanitizeState(JSON.parse(raw));
  } catch {
    return createDefaultState();
  }
}

function persistState(state: InterventionState): void {
  try {
    localStorage.setItem(INTERVENTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export const interventionStore = createStore<InterventionState>(loadInitialState());
export const useInterventionStore = interventionStore.useStore;

function updateAndPersist(updater: (prev: InterventionState) => InterventionState): void {
  const next = updater(interventionStore.getState());
  interventionStore.setState(next);
  persistState(next);
}

export function hydrateInterventionStore(): void {
  interventionStore.setState(loadInitialState());
}

export function toggleLessonCompleted(lessonId: string): void {
  updateAndPersist((prev) => {
    const exists = prev.completedLessonIds.includes(lessonId);
    const completedLessonIds = exists
      ? prev.completedLessonIds.filter((id) => id !== lessonId)
      : [...prev.completedLessonIds, lessonId];
    return { ...prev, completedLessonIds };
  });
}

export function toggleRitualItem(itemId: string, now: Date = new Date()): void {
  const today = toLocalDateString(now);
  updateAndPersist((prev) => {
    const baseIds = prev.ritualDate === today ? prev.completedRitualIds : [];
    const exists = baseIds.includes(itemId);
    const completedRitualIds = exists
      ? baseIds.filter((id) => id !== itemId)
      : [...baseIds, itemId];
    return { ...prev, ritualDate: today, completedRitualIds };
  });
}

export function setPreferredBreathMode(mode: BreathModeId): void {
  updateAndPersist((prev) => ({ ...prev, preferredBreathMode: mode }));
}

/** 仅供单测复位 */
export function resetInterventionStore(): void {
  interventionStore.setState(createDefaultState());
}
