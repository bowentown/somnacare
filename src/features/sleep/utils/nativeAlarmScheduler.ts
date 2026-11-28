import { CustomAlarmSetting } from '../../../shared/types/sleep';
import { isNativePlatform, nativePlugin } from '../../../shared/native/nativeBridge';

// 平台判定与插件取用统一走 nativeBridge（第 94 轮）。此处只做转出，让既有
// 13 个 `from './nativeAlarmScheduler'` 的导入点零改动；新代码请直接从
// './nativeBridge' 引，别再从这里拿。
export { isNativePlatform };

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
  deleteChannel?: (channel: { id: string }) => Promise<any>;
  checkExactNotificationSetting?: () => Promise<{ exactAlarm: string }>;
  changeExactNotificationSetting?: () => Promise<{ exactAlarm: string }>;
}

/** 静音无震闹钟辅助渠道 ID（与 SleepCorePlugin.BANNER_CHANNEL_ID 对齐，解决 Android O+ 旧渠道不可原地降级静音）。 */
export const ALARM_BANNER_CHANNEL_ID = 'somnacare-alarm-silent';
const LEGACY_ALARM_BANNER_CHANNEL_ID = 'somnacare-alarm';

export async function requestAlarmPermissions(): Promise<boolean> {
  const plugin = nativePlugin<CapacitorLocalNotificationsPlugin>('LocalNotifications');
  if (!plugin) return false;
  try {
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
  const plugin = nativePlugin<CapacitorLocalNotificationsPlugin>('LocalNotifications');
  if (!plugin) {
    return { success: false, nativeScheduledCount: 0, invalidCount: 0 };
  }

  try {
    // 清理旧版高优有声渠道（Android O+ 对已存在渠道无法原地降级静音），
    // 并迁移至显式静音无震的 somnacare-alarm-silent 辅助渠道——
    // 持续响铃、闹钟音频焦点与穿透勿扰震动完全由 AlarmRingService 负责，避免双通知叠音。
    try {
      await plugin.deleteChannel?.({ id: LEGACY_ALARM_BANNER_CHANNEL_ID });
    } catch {
      // 旧渠道不存在或低版本不支持删除时静默跳过
    }
    try {
      await plugin.createChannel({
        id: ALARM_BANNER_CHANNEL_ID,
        name: '极光睡眠闹钟（静默）',
        description: '闹钟静默提醒通道（持续响铃与震动由原生闹钟服务负责）',
        importance: 2,
        sound: '',
        vibration: false,
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
      // 旧版本重复闹钟的 ID 可能越过 1e6（旧哈希 %1e6 + 700）：extra.alarmId
      // 是更可靠的归属标记，升级后也要能清掉
      .filter((n: { id: number; extra?: { alarmId?: string } }) =>
        n.id < PROPOSAL_NOTIFICATION_MIN_ID || !!n.extra?.alarmId);
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
      // 仅取消常规闹钟，保留尚未到点的 5/10 分钟贪睡闹钟（唯一一次性闹钟响后自动关闭时不能误杀贪睡）
      try { await nativePlugin('SleepCore')?.alarmRingCancel?.({ includeSnooze: false }); } catch { /* ignore */ }
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
          channelId: ALARM_BANNER_CHANNEL_ID,
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
            channelId: ALARM_BANNER_CHANNEL_ID,
            extra: { alarmId: alarm.id, isoDay },
          });
        });
      }
    }

    if (notificationsToSchedule.length > 0) {
      await plugin.schedule({ notifications: notificationsToSchedule });
    }

    // 持续响铃排程：熄屏循环铃声+穿透勿扰震动直到用户关闭/贪睡（最长 5 分钟）——
    // 透传 vibrate 开关与一次性闹钟的精确 triggerAtMs，避免跨夜响铃误删明天早起闹钟
    try {
      const nowMs = Date.now();
      await nativePlugin('SleepCore')?.alarmRingSchedule?.({
        alarmsJson: JSON.stringify(
          validAlarms.map((a) => {
            const isOneShot = !a.repeatDays || a.repeatDays.length === 0;
            let triggerAtMs: number | undefined;
            if (isOneShot) {
              const [h, m] = a.time.split(':').map(Number);
              const target = new Date(nowMs);
              target.setHours(h, m, 0, 0);
              if (target.getTime() <= nowMs) {
                target.setDate(target.getDate() + 1);
              }
              triggerAtMs = target.getTime();
            }
            return {
              id: a.id,
              time: a.time,
              repeatDays: a.repeatDays ?? [],
              tone: a.tone,
              label: a.label,
              vibrate: a.vibrate !== false,
              ...(triggerAtMs !== undefined ? { triggerAtMs } : {}),
            };
          }),
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
  const plugin = nativePlugin<CapacitorLocalNotificationsPlugin>('LocalNotifications');
  if (!plugin) return 'unknown';
  try {
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
  const plugin = nativePlugin<CapacitorLocalNotificationsPlugin>('LocalNotifications');
  if (!plugin) return false;
  try {
    if (typeof plugin.changeExactNotificationSetting !== 'function') return false;
    await plugin.changeExactNotificationSetting();
    return true;
  } catch {
    return false;
  }
}
