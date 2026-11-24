import { createStore } from './createStore';
import type { CustomAlarmSetting, SleepRecord } from '../types/sleep';
import type { NavTab } from '../ui/BottomNavBar';
import type { BedtimeReminderPhase } from '../../features/sleep/components/BedtimeReminder';

export type SubpageId =
  | 'settings/appearance'
  | 'settings/schedule'
  | 'settings/pet'
  | 'settings/widgets'
  | 'settings/data'
  | 'settings/extensions'
  | 'intervention/wind-down'
  | 'trends/history'
  | 'trends/calendar'
  | 'trends/usage'
  | 'eyecare/schedule'
  | 'eyecare/health';

export interface SubpageEntry {
  id: SubpageId;
  params?: Record<string, unknown>;
}

export interface ManualLogPrefill {
  date: string;
  bedtime: string;
  wakeTime: string;
}

export interface UIState {
  activeTab: NavTab;
  subpageStack: SubpageEntry[];
  toastMessage: string | null;
  activeSleepOpen: boolean;
  manualLogOpen: boolean;
  manualLogPrefill: ManualLogPrefill | null;
  editTarget: SleepRecord | null;
  codexOpen: boolean;
  pendingPostcardId: string | null;
  momentsOpen: boolean;
  aiConfigOpen: boolean;
  chatTyping: boolean;
  bedtimeReminder: BedtimeReminderPhase | null;
  ringingAlarm: CustomAlarmSetting | null;
  sleepStartSignal: number;
}

const initialUIState: UIState = {
  activeTab: 'today',
  subpageStack: [],
  toastMessage: null,
  activeSleepOpen: false,
  manualLogOpen: false,
  manualLogPrefill: null,
  editTarget: null,
  codexOpen: false,
  pendingPostcardId: null,
  momentsOpen: false,
  aiConfigOpen: false,
  chatTyping: false,
  bedtimeReminder: null,
  ringingAlarm: null,
  sleepStartSignal: 0,
};

export const uiStore = createStore<UIState>(initialUIState);
export const useUIStore = uiStore.useStore;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let chatBlurTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string, durationMs = 3200): void {
  uiStore.setState({ toastMessage: msg });
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    uiStore.setState({ toastMessage: null });
  }, durationMs);
}

export function setActiveTab(tab: NavTab): void {
  // 切换底栏主 Tab 自动清掉当前二级子页栈，符合移动端直觉
  uiStore.setState({ activeTab: tab, subpageStack: [] });
}

export function pushSubpage(id: SubpageId, params?: Record<string, unknown>): void {
  uiStore.setState((prev) => ({
    subpageStack: [...prev.subpageStack, { id, params }],
  }));
}

export function popSubpage(): boolean {
  const stack = uiStore.getState().subpageStack;
  if (stack.length === 0) return false;
  uiStore.setState({ subpageStack: stack.slice(0, -1) });
  return true;
}

export function clearSubpages(): void {
  if (uiStore.getState().subpageStack.length === 0) return;
  uiStore.setState({ subpageStack: [] });
}

export function openActiveSleepModal(): void {
  uiStore.setState({ activeSleepOpen: true });
}

export function closeActiveSleepModal(): void {
  uiStore.setState({ activeSleepOpen: false });
}

export function openManualLogModal(prefill?: ManualLogPrefill): void {
  uiStore.setState({
    manualLogOpen: true,
    manualLogPrefill: prefill ?? null,
    editTarget: null,
  });
}

export function openEditRecordModal(record: SleepRecord): void {
  uiStore.setState({
    manualLogOpen: true,
    manualLogPrefill: { date: record.date, bedtime: record.bedtime, wakeTime: record.wakeTime },
    editTarget: record,
  });
}

export function closeManualLogModal(): void {
  uiStore.setState({
    manualLogOpen: false,
    manualLogPrefill: null,
    editTarget: null,
  });
}

export function setChatTypingFocus(focused: boolean): void {
  if (chatBlurTimer !== null) {
    clearTimeout(chatBlurTimer);
    chatBlurTimer = null;
  }
  if (focused) {
    uiStore.setState({ chatTyping: true });
  } else {
    chatBlurTimer = setTimeout(() => {
      chatBlurTimer = null;
      uiStore.setState({ chatTyping: false });
    }, 280);
  }
}

export function openAutoCheckSubpage(): void {
  uiStore.setState({
    activeTab: 'settings',
    subpageStack: [{ id: 'settings/data', params: { autoCheck: Date.now() } }],
  });
}

export function openMoments(): void {
  uiStore.setState({ activeTab: 'coach', subpageStack: [], momentsOpen: true });
}

export function closeMoments(): void {
  uiStore.setState({ momentsOpen: false });
}

/**
 * 统一 DeepLink 路由入口（供桌面小组件、桌宠点击、通知栏拉起调用）。
 */
export function handleDeepLink(rawRoute: string): boolean {
  const cleaned = rawRoute.replace(/^somnacare:\/\//, '').replace(/^open\//, '').trim();
  if (!cleaned) return false;
  const [path, query = ''] = cleaned.split('?');
  const qs = new URLSearchParams(query);

  switch (path) {
    case 'today':
    case 'sleep':
      setActiveTab('today');
      return true;
    case 'sleep/start':
      setActiveTab('today');
      openActiveSleepModal();
      return true;
    case 'trends':
      setActiveTab('trends');
      return true;
    case 'trends/history':
    case 'trends/calendar':
    case 'trends/usage':
      uiStore.setState({
        activeTab: 'trends',
        subpageStack: [{ id: path as SubpageId }],
      });
      return true;
    case 'coach':
      setActiveTab('coach');
      return true;
    case 'eyecare':
      setActiveTab('eyecare');
      return true;
    case 'eyecare/schedule':
    case 'eyecare/health':
      uiStore.setState({
        activeTab: 'eyecare',
        subpageStack: [{ id: path as SubpageId }],
      });
      return true;
    case 'settings':
      setActiveTab('settings');
      return true;
    case 'pet/moments':
      openMoments();
      return true;
    case 'pet/codex':
      uiStore.setState({ codexOpen: true });
      return true;
    case 'intervention/wind-down':
    case 'intervention/breathing':
      uiStore.setState({
        activeTab: 'today',
        subpageStack: [{ id: 'intervention/wind-down', params: { section: path.endsWith('breathing') ? 'breathing' : 'all' } }],
      });
      return true;
    case 'settings/appearance':
    case 'settings/schedule':
    case 'settings/pet':
    case 'settings/widgets':
    case 'settings/data':
    case 'settings/extensions':
      uiStore.setState({
        activeTab: 'settings',
        subpageStack: [
          {
            id: path as SubpageId,
            params: qs.get('autoCheck') ? { autoCheck: Date.now() } : undefined,
          },
        ],
      });
      return true;
    default:
      return false;
  }
}

/** 仅供单元测试复位状态 */
export function resetUIStore(): void {
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (chatBlurTimer !== null) {
    clearTimeout(chatBlurTimer);
    chatBlurTimer = null;
  }
  uiStore.setState({ ...initialUIState, subpageStack: [] });
}
