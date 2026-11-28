/**
 * 全应用 localStorage 键唯一台账与可扩展备份注册表（Phase 2A）。
 *
 * 原则：
 * 1. 所有既有 somnacare_* 键名保持原样，确保老用户覆盖安装 APK 零数据丢失；
 * 2. 新增持久化业务域（如 Phase 5 CBT-I / 自定义日记标签）只需调用 registerBackupSlice，
 *    即可自动进入全量导出/导入与回滚快照，不再需要人工同步多处白名单。
 */

export type StoragePolicy = 'backup' | 'ephemeral' | 'privacy' | 'secret';

export interface StorageKeyMeta {
  key: string;
  domain: 'sleep' | 'profile' | 'pet' | 'coach' | 'eyecare' | 'intervention' | 'adskip' | 'ui';
  policy: StoragePolicy;
}

/** 全仓 43 个持久化键台账（40 个线上既有键 + Phase 5 睡前仪式 + Phase 6 深夜刷屏轻提醒 + v1.44 跳广告排除名单） */
export const STORAGE_CATALOG: readonly StorageKeyMeta[] = [
  // 核心可备份数据域
  { key: 'somnacare_sleep_records', domain: 'sleep', policy: 'backup' },
  { key: 'somnacare_user_profile', domain: 'profile', policy: 'backup' },
  { key: 'somnacare_travel_state', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_pet_moments', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_chat_history', domain: 'coach', policy: 'backup' },
  { key: 'somnacare_pet_skin', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_pet_bubble_every', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_pet_enabled', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_pet_stimulus_guard', domain: 'pet', policy: 'backup' },
  { key: 'somnacare_ad_skip_excluded', domain: 'adskip', policy: 'backup' },
  { key: 'somnacare_notify_morning', domain: 'sleep', policy: 'backup' },
  { key: 'somnacare_notify_recall', domain: 'sleep', policy: 'backup' },
  { key: 'somnacare_intervention_v1', domain: 'intervention', policy: 'backup' },

  // 凭据（永不进入备份文件）
  { key: 'somnacare_hf_token', domain: 'coach', policy: 'secret' },

  // 设备级隐私/行为遥测（刻意排除出备份文件）
  { key: 'somnacare_usage_days', domain: 'sleep', policy: 'privacy' },
  { key: 'somnacare_model_shadow', domain: 'sleep', policy: 'privacy' },

  // 会话态 / 缓存 / 一次性提示与迁移标记（可再生，无需随备份迁移）
  { key: 'somnacare_activesleep_start', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_bedtime_start', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_analysis_v1', domain: 'coach', policy: 'ephemeral' },
  { key: 'somnacare_chat_collapsed', domain: 'coach', policy: 'ephemeral' },
  { key: 'somnacare_eyecare_started', domain: 'eyecare', policy: 'ephemeral' },
  { key: 'somnacare_last_backup_at', domain: 'ui', policy: 'ephemeral' },
  { key: 'somnacare_llm_state', domain: 'coach', policy: 'ephemeral' },
  { key: 'somnacare_moments_cap', domain: 'pet', policy: 'ephemeral' },
  { key: 'somnacare_morning_notified', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_nap_overwrite_notice_shown', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_onboarded_v1', domain: 'ui', policy: 'ephemeral' },
  { key: 'somnacare_pet_mom_regen_at', domain: 'pet', policy: 'ephemeral' },
  { key: 'somnacare_pet_say_fail', domain: 'pet', policy: 'ephemeral' },
  { key: 'somnacare_pet_say_llm', domain: 'pet', policy: 'ephemeral' },
  { key: 'somnacare_proposal_action', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_proposal_handled', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_proposal_notif_prompted', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_proposal_notified', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_proposal_unlocked', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_recall_week', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_record_date_schema', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_reminder_fired', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_score_schema', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_sleep_records_backup_corrupted', domain: 'sleep', policy: 'ephemeral' },
  { key: 'somnacare_splash_shown', domain: 'ui', policy: 'ephemeral' },
  { key: 'somnacare_usage_card_open', domain: 'ui', policy: 'ephemeral' },
  { key: 'somnacare_usage_prompted', domain: 'sleep', policy: 'ephemeral' },
];

export interface BackupSlice<T = unknown> {
  /** 备份对象 slices[id] 中的唯一键 */
  id: string;
  /** 该切片读写的 localStorage 键（用于导入前原子快照与失败回滚） */
  storageKeys: string[];
  exportSlice: () => T | undefined;
  importSlice: (data: T) => void;
}

const sliceMap = new Map<string, BackupSlice>();

/** 注册可扩展备份切片（幂等，重复注册同一 id 以新定义为准） */
export function registerBackupSlice<T>(slice: BackupSlice<T>): void {
  sliceMap.set(slice.id, slice as BackupSlice);
}

/** 取消注册（供单测清理） */
export function unregisterBackupSlice(id: string): void {
  sliceMap.delete(id);
}

export function listBackupSlices(): BackupSlice[] {
  return [...sliceMap.values()];
}

// 内置切片：关怀通知开关（此前只写在 KEYS 常量中未实际导入导出，现通过注册表自动纳入 v3 备份）
registerBackupSlice<{ morning?: boolean; recall?: boolean }>({
  id: 'careNotifications',
  storageKeys: ['somnacare_notify_morning', 'somnacare_notify_recall'],
  exportSlice: () => {
    const m = localStorage.getItem('somnacare_notify_morning');
    const r = localStorage.getItem('somnacare_notify_recall');
    if (m === null && r === null) return undefined;
    return {
      ...(m !== null ? { morning: m !== '0' } : {}),
      ...(r !== null ? { recall: r !== '0' } : {}),
    };
  },
  importSlice: (data) => {
    if (!data || typeof data !== 'object') return;
    if (typeof data.morning === 'boolean') {
      localStorage.setItem('somnacare_notify_morning', data.morning ? '1' : '0');
    }
    if (typeof data.recall === 'boolean') {
      localStorage.setItem('somnacare_notify_recall', data.recall ? '1' : '0');
    }
  },
});

// 内置切片：Phase 5 睡前仪式 / CBT-I 微课进度
registerBackupSlice<unknown>({
  id: 'intervention',
  storageKeys: ['somnacare_intervention_v1'],
  exportSlice: () => {
    const raw = localStorage.getItem('somnacare_intervention_v1');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  importSlice: (data) => {
    if (data && typeof data === 'object') {
      localStorage.setItem('somnacare_intervention_v1', JSON.stringify(data));
    }
  },
});

// 内置切片：Phase 6 深夜高刺激刷屏超时大肥鱼轻提醒配置
registerBackupSlice<unknown>({
  id: 'petStimulusGuard',
  storageKeys: ['somnacare_pet_stimulus_guard'],
  exportSlice: () => {
    const raw = localStorage.getItem('somnacare_pet_stimulus_guard');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  importSlice: (data) => {
    if (data && typeof data === 'object') {
      localStorage.setItem('somnacare_pet_stimulus_guard', JSON.stringify(data));
    }
  },
});

// 内置切片：v1.44.0 广告跳过按应用排除白名单（Backup v3 统一备份/恢复）
registerBackupSlice<{ excludedPkgs: string[] }>({
  id: 'adSkip',
  storageKeys: ['somnacare_ad_skip_excluded'],
  exportSlice: () => {
    const raw = localStorage.getItem('somnacare_ad_skip_excluded');
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { excludedPkgs?: unknown }).excludedPkgs)
          ? (parsed as { excludedPkgs: unknown[] }).excludedPkgs
          : null;
      if (!list) return undefined;
      const clean = Array.from(
        new Set(
          list
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ).sort();
      return { excludedPkgs: clean };
    } catch {
      return undefined;
    }
  },
  importSlice: (data) => {
    if (!data || typeof data !== 'object') return;
    const rawList = (data as { excludedPkgs?: unknown }).excludedPkgs;
    if (!Array.isArray(rawList)) return;
    const clean = Array.from(
      new Set(
        rawList
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ).sort();
    localStorage.setItem('somnacare_ad_skip_excluded', JSON.stringify(clean));
  },
});
