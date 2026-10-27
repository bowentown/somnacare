/**
 * 提议卡通知（第 56 轮）：早上不打开 App 也能收到"昨晚的睡眠待确认"，
 * 通知上的「确认记录」按钮直接把待确认动作带回来——回到 App 即完成落库，
 * 不需要再在卡上找按钮。
 *
 * 边界：
 *  - 只在 native + 自动档 + 提议卡真实在场时挂一条，每夜最多一条
 *    （somnacare_proposal_notified = targetDate）；
 *  - 通知文案只说"放下/拿起手机"，不声称监测了睡眠；
 *  - 动作经 localStorage 待办传递：插件事件可能先于 React 挂载到达，
 *    内存订阅只负责"App 已在前台"的即时场景。
 *
 * 插件同样走 window.Capacitor.Plugins 动态取用：静态 import
 * `@capacitor/local-notifications` 会拉起 @capacitor/core 的 web 运行时，
 * 把 e2e/网页预览的 isNativePlatform 改写掉（第 52 轮踩过的坑）。
 */
import { PROPOSAL_NOTIFICATION_MIN_ID } from './nativeAlarmScheduler';
import { nativePlugin } from './nativeBridge';

const NOTIFIED_KEY = 'somnacare_proposal_notified';
const ACTION_KEY = 'somnacare_proposal_action';
const PROMPTED_KEY = 'somnacare_proposal_notif_prompted';
const ACTION_TYPE_ID = 'somnacare-proposal-actions';
const CHANNEL_ID = 'somnacare-proposal';
const ACTION_TTL_MS = 6 * 3600000;

export interface ProposalAction {
  type: 'confirm' | 'edit';
  date: string;
  at: number;
}

type Subscriber = (action: ProposalAction) => void;
const subscribers = new Set<Subscriber>();
let listenerReady = false;
let channelReady = false;

function plugin(): any {
  return nativePlugin('LocalNotifications');
}

function idOf(date: string): number {
  const t = Date.parse(`${date}T00:00:00`);
  const day = Number.isFinite(t) ? Math.floor(t / 86400000) : 0;
  return PROPOSAL_NOTIFICATION_MIN_ID + (((day % 100000) + 100000) % 100000);
}

function readAction(): ProposalAction | null {
  try {
    const raw = localStorage.getItem(ACTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProposalAction;
    if (!parsed || (parsed.type !== 'confirm' && parsed.type !== 'edit')) return null;
    if (typeof parsed.date !== 'string' || !Number.isFinite(parsed.at)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// 动作可能由两条通道同时到达（插件事件 + 冷启动 Intent 读取），
// 10 秒内同类型同日期只广播一次，避免确认被消费后又留下待办
let lastWritten: ProposalAction | null = null;
function writeAction(action: ProposalAction): void {
  if (
    lastWritten &&
    lastWritten.type === action.type &&
    lastWritten.date === action.date &&
    Date.now() - lastWritten.at < 10_000
  ) return;
  lastWritten = action;
  try { localStorage.setItem(ACTION_KEY, JSON.stringify(action)); } catch { /* ignore */ }
  for (const fn of subscribers) fn(action);
}

/** 消费一次待办动作（冷启动先读盘；6 小时内有效，避免隔天误确认）。 */
export function consumeProposalAction(): ProposalAction | null {
  const action = readAction();
  if (!action) return null;
  try { localStorage.removeItem(ACTION_KEY); } catch { /* ignore */ }
  if (Date.now() - action.at > ACTION_TTL_MS) return null;
  return action;
}

export function subscribeProposalAction(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 冷启动：直接从 Activity 启动 Intent 读取通知动作（插件事件会丢的场景）。 */
async function readLaunchAction(): Promise<ProposalAction | null> {
  try {
    const res = await nativePlugin('GemmaLLM')?.proposalNotificationAction?.();
    if (res?.date && (res.actionId === 'confirm' || res.actionId === 'edit')) {
      return { type: res.actionId, date: res.date, at: Date.now() };
    }
  } catch { /* 旧原生包没有该方法：退回插件事件通道 */ }
  return null;
}

/** 注册动作按钮与监听（幂等；App 启动时调用一次即可）。 */
export function initProposalNotify(): void {
  const pl = plugin();
  if (!pl) return;
  void (async () => {
    try {
      if (!listenerReady) {
        await pl.registerActionTypes?.({
          types: [{
            id: ACTION_TYPE_ID,
            actions: [
              { id: 'confirm', title: '确认记录' },
              { id: 'edit', title: '改一下' },
            ],
          }],
        });
        await pl.addListener?.('localNotificationActionPerformed', (evt: any) => {
          const extra = evt?.notification?.extra;
          const date = extra?.proposalDate ?? extra?.proposal_date;
          if (typeof date !== 'string') return;
          // actionId 为空 / 'tap' = 用户只是点了通知本体：正常打开 App，
          // 卡片就在睡眠页，不需要凭空确认
          if (evt?.actionId !== 'confirm' && evt?.actionId !== 'edit') return;
          writeAction({ type: evt.actionId, date, at: Date.now() });
        });
        listenerReady = true;
      }
      // 冷启动：插件没机会派发 onNewIntent 事件，直接读启动 Intent。
      // 只走这一条通道写盘（写盘会广播给已订阅的提议卡），避免双触发
      const launch = await readLaunchAction();
      if (launch) writeAction(launch);
    } catch { /* 插件版本不支持动作类型时静默降级为普通通知 */ }
  })();
}

/**
 * 为这一夜的提议挂一条通知（每夜最多一次）。返回是否已安排/已存在。
 * 通知权限未授予时最多主动请求一次，拒绝后不再打扰。
 */
export async function scheduleProposalNotification(proposal: {
  date: string;
  bedtime: string;
  wakeTime: string;
}): Promise<boolean> {
  const pl = plugin();
  if (!pl) return false;
  try {
    if (localStorage.getItem(NOTIFIED_KEY) === proposal.date) return true;
  } catch { /* ignore */ }

  try {
    let perm = await pl.checkPermissions?.();
    if (perm?.display !== 'granted') {
      let prompted = false;
      try { prompted = localStorage.getItem(PROMPTED_KEY) === '1'; } catch { /* ignore */ }
      if (prompted) return false;
      try { localStorage.setItem(PROMPTED_KEY, '1'); } catch { /* ignore */ }
      perm = await pl.requestPermissions?.();
    }
    if (perm?.display !== 'granted') return false;
  } catch {
    return false;
  }

  try {
    // 动作注册与调度在同一链里再确认一次：App 启动注册是异步的，
    // 首条通知可能在注册完成前发出（否则通知上没有「确认记录」按钮）
    try {
      await pl.registerActionTypes?.({
        types: [{
          id: ACTION_TYPE_ID,
          actions: [
            { id: 'confirm', title: '确认记录' },
            { id: 'edit', title: '改一下' },
          ],
        }],
      });
    } catch { /* 旧版本插件不支持动作，降级为普通通知 */ }
    if (!channelReady) {
      try {
        await pl.createChannel?.({
          id: CHANNEL_ID,
          name: '昨晚的睡眠记录',
          description: '早上提醒确认自动识别到的睡眠',
          importance: 4,
          visibility: 1,
        });
      } catch { /* 渠道已存在不阻断 */ }
      channelReady = true;
    }
    await pl.schedule?.({
      notifications: [{
        id: idOf(proposal.date),
        title: '昨晚的睡眠记录待确认',
        body: `${proposal.bedtime} 放下手机 → ${proposal.wakeTime} 拿起，点一下完成记录`,
        schedule: { at: new Date(Date.now() + 90_000), allowWhileIdle: true },
        channelId: CHANNEL_ID,
        actionTypeId: ACTION_TYPE_ID,
        extra: { proposalDate: proposal.date },
      }],
    });
    try { localStorage.setItem(NOTIFIED_KEY, proposal.date); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

/** 确认/改一下/否定后撤掉通知，避免通知栏里留下已处理的动作。 */
export function cancelProposalNotification(date: string): void {
  const pl = plugin();
  if (!pl) return;
  try {
    void pl.cancel?.({ notifications: [{ id: idOf(date) }] });
  } catch { /* ignore */ }
}
