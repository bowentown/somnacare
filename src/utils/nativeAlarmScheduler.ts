import { CustomAlarmSetting } from '../types/sleep';

/**
 * 原生 Android 进程级通知与闹钟调度器 (基于 Capacitor LocalNotifications)
 * - 当在 APK (Capacitor 原生环境) 运行时：调度进程级精确通知，即使应用被杀或息屏，由 Android 系统底层唤醒响铃；
 * - 当在 Web/PWA 环境运行时：保留优雅降级提示，引导安装 APK，同时利用 Web Audio 前台兜底。
 */

interface CapacitorLocalNotificationsPlugin {
  checkPermissions: () => Promise<{ display: string }>;
  requestPermissions: () => Promise<{ display: string }>;
  schedule: (options: { notifications: any[] }) => Promise<any>;
  cancel: (options: { notifications: { id: number }[] }) => Promise<any>;
  getPending: () => Promise<{ notifications: any[] }>;
  createChannel: (channel: {
    id: string;
    name: string;
    description?: string;
    importance?: number;
    sound?: string;
    vibration?: boolean;
    visibility?: number;
  }) => Promise<any>;
  checkExactNotificationSetting?: () => Promise<{ exactAlarm: string }>;
  changeExactNotificationSetting?: () => Promise<{ exactAlarm: string }>;
}

function getCapacitor(): any {
  return (window as any).Capacitor;
}

export function isNativePlatform(): boolean {
  const cap = getCapacitor();
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

export async function requestAlarmPermissions(): Promise<boolean> {
  const cap = getCapacitor();
  if (!isNativePlatform() || !cap?.Plugins?.LocalNotifications) {
    return false;
  }
  try {
    const plugin: CapacitorLocalNotificationsPlugin = cap.Plugins.LocalNotifications;
    const current = await plugin.checkPermissions();
    if (current.display !== 'granted') {
      const res = await plugin.requestPermissions();
      return res.display === 'granted';
    }
    return true;
  } catch (err) {
    console.warn('[NativeAlarm] 权限检查或请求异常:', err);
    return false;
  }
}

/**
 * 通知 ID 分区间（第 56 轮）：闹钟哈希 < 1_000_000；≥ 此值的是提议卡通知。
 * 闹钟全量重排时只取消本区间，不能把待确认的提议通知一起清掉。
 */
export const PROPOSAL_NOTIFICATION_MIN_ID = 1_000_000;

/**
 * 为单个闹钟分配稳定的数字 ID（以支持原生 Notification id）
 */
function hashStringToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  // 闹钟 ID 必须落在 [0, 1_000_000) 区间内：重复闹钟还要 +700，
  // 用 %1_000_000 会越界撞进提议通知区间（第 56 轮）
  return Math.abs(hash) % 100000;
}

/**
 * 将启用的闹钟集合全量同步到 Android 系统级通知调度队列
 */
export async function syncAlarmsToNative(alarms: CustomAlarmSetting[]): Promise<{ success: boolean; nativeScheduledCount: number; invalidCount: number }> {
  if (!isNativePlatform()) {
    return { success: false, nativeScheduledCount: 0, invalidCount: 0 };
  }

  const cap = getCapacitor();
  const plugin: CapacitorLocalNotificationsPlugin = cap?.Plugins?.LocalNotifications;
  if (!plugin) {
    return { success: false, nativeScheduledCount: 0, invalidCount: 0 };
  }

  try {
    // 专用闹钟通知通道：IMPORTANCE_HIGH 但不出声——持续响铃由 AlarmRingService
    // 的 MediaPlayer 循环负责，通知只出横幅（渠道出声会与服务叠放）。
    // 注意：Android 渠道创建后不可变，旧安装需卸载重装才去掉原 30 秒铃声。
    try {
      await plugin.createChannel({
        id: 'somnacare-alarm',
        name: '极光睡眠闹钟',
        description: '定时睡眠唤醒（重要级，熄屏可响）',
        importance: 5,
        visibility: 1,
      });
    } catch {
      // 通道已存在或创建失败不阻断调度
    }

    // 1. 取消已挂起的历史闹钟通知，防止重复堆叠。
    //    只清闹钟区间——提议卡通知（≥ PROPOSAL_NOTIFICATION_MIN_ID）归
    //    proposalNotify 管，用户在通知栏点"确认记录"前不能被闹钟同步吞掉
    const pending = await plugin.getPending();
    const pendingAlarms = (pending?.notifications ?? [])
      .filter((n: { id: number }) => n.id < PROPOSAL_NOTIFICATION_MIN_ID);
    if (pendingAlarms.length > 0) {
      await plugin.cancel({
        notifications: pendingAlarms.map((n: { id: number }) => ({ id: n.id })),
      });
    }

    // 坏时间条目（<input type="time"> 被清空后入库）会让 plugin.schedule 整批
    // 被拒——原生重排是逐条容错，这里对齐：跳过坏值而不是拖垮全部闹钟
    const validAlarms = alarms.filter((a) => a.enabled && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time || ''));
    const invalidCount = alarms.filter((a) => a.enabled).length - validAlarms.length;
    if (validAlarms.length === 0) {
      try { await (cap.Plugins?.GemmaLLM as any)?.alarmRingCancel?.(); } catch { /* ignore */ }
      return { success: true, nativeScheduledCount: 0, invalidCount };
    }

    const notificationsToSchedule: any[] = [];

    for (const alarm of validAlarms) {
      const [h, m] = alarm.time.split(':').map(Number);
      const baseId = hashStringToInt(alarm.id);

      // 单次闹钟 (无重复日)
      if (!alarm.repeatDays || alarm.repeatDays.length === 0) {
        const targetDate = new Date();
        targetDate.setHours(h, m, 0, 0);
        // 如果今天设定时间已过，推算到明天
        if (targetDate.getTime() <= Date.now()) {
          targetDate.setDate(targetDate.getDate() + 1);
        }

        notificationsToSchedule.push({
          id: baseId,
          title: `⏰ 极光唤醒：${alarm.label || '早晨唤醒'}`,
          body: `现在是 ${alarm.time}，起床时间到啦！愿您今日神采奕奕。`,
          schedule: {
            at: targetDate,
            allowWhileIdle: true,
          },
          channelId: 'somnacare-alarm',
          extra: { alarmId: alarm.id },
        });
      } else {
        // 重复闹钟 (星期 1-7, 对应 Capacitor weekday 2-7, 1)
        // Capacitor weekday: 1 = Sunday, 2 = Monday, ... 7 = Saturday
        alarm.repeatDays.forEach((isoDay, index) => {
          const capacitorWeekday = isoDay === 7 ? 1 : isoDay + 1;
          notificationsToSchedule.push({
            id: baseId + (index + 1) * 100,
            title: `⏰ 极光唤醒：${alarm.label || '早晨唤醒'}`,
            body: `现在是 ${alarm.time}，起床时间到啦！`,
            schedule: {
              on: {
                weekday: capacitorWeekday,
                hour: h,
                minute: m,
              },
              allowWhileIdle: true,
            },
            channelId: 'somnacare-alarm',
            extra: { alarmId: alarm.id, isoDay },
          });
        });
      }
    }

    if (notificationsToSchedule.length > 0) {
      await plugin.schedule({ notifications: notificationsToSchedule });
    }

    // 持续响铃排程：熄屏循环铃声+振动直到用户关闭（最长 5 分钟）——
    // Capacitor 通知只有渠道 30 秒铃声，播完即止，这就是"响一声就没"的根因
    try {
      await (cap.Plugins?.GemmaLLM as any)?.alarmRingSchedule?.({
        alarmsJson: JSON.stringify(
          validAlarms.map((a) => ({
            id: a.id,
            time: a.time,
            repeatDays: a.repeatDays ?? [],
            tone: a.tone,
            label: a.label,
          })),
        ),
      });
    } catch { /* 响铃排程失败不阻断通知调度 */ }

    return { success: true, nativeScheduledCount: notificationsToSchedule.length, invalidCount };
  } catch (err) {
    console.error('[NativeAlarm] 同步原生闹钟失败:', err);
    return { success: false, nativeScheduledCount: 0, invalidCount: 0 };
  }
}

/**
 * 精确闹钟权限三态。此前徽章无条件声称"系统级精确唤醒已激活"，而插件在
 * 权限缺失时会静默降级为非精确闹钟（只写一行 logcat）——Android 14+ 上
 * SCHEDULE_EXACT_ALARM 默认拒绝，界面承诺与实际行为不符。
 */
export type ExactAlarmStatus = 'granted' | 'denied' | 'unknown';

export async function getExactAlarmStatus(): Promise<ExactAlarmStatus> {
  const cap = getCapacitor();
  if (!isNativePlatform() || !cap?.Plugins?.LocalNotifications) return 'unknown';
  try {
    const plugin = cap.Plugins.LocalNotifications as CapacitorLocalNotificationsPlugin;
    if (typeof plugin.checkExactNotificationSetting !== 'function') return 'unknown';
    const res = await plugin.checkExactNotificationSetting();
    // 原生插件返回的键是 snake_case（LocalNotificationsPlugin.kt: exact_alarm），
    // 此前手写接口按 camelCase 读 → 恒为 unknown，徽章与"去授权"入口从未生效
    const v = (res as any)?.exact_alarm ?? (res as any)?.exactAlarm;
    return v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 带用户去系统"闹钟和提醒"授权页（插件 6.0+ 提供，旧版本降级返回 false）。 */
export async function openExactAlarmSettings(): Promise<boolean> {
  const cap = getCapacitor();
  if (!isNativePlatform() || !cap?.Plugins?.LocalNotifications) return false;
  try {
    const plugin = cap.Plugins.LocalNotifications as CapacitorLocalNotificationsPlugin;
    if (typeof plugin.changeExactNotificationSetting !== 'function') return false;
    await plugin.changeExactNotificationSetting();
    return true;
  } catch {
    return false;
  }
}
