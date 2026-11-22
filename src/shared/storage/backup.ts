/**
 * 全量备份（schema 3，向后无损兼容 schema 2 与旧版 records-only）：
 *
 * - 延续全部安全红线：API 密钥、HF Token、customBaseUrl 永不导出、导入永不覆盖本机值；
 * - 新增可扩展 `slices` 容器，对接 `shared/storage/registry.ts`：任何新业务域
 *   调用 registerBackupSlice 即可自动纳入导出、恢复与失败原子回滚；
 * - 保留顶层字段（records / profile / travel / moments / chat / petPrefs）与 schema 2
 *   形状对齐，老备份文件通过 migrateV2ToV3 无缝迁移导入。
 */
import {
  recordDateMigrationDone,
  markRecordDateMigrationDone,
  migrateRecordDatesToNightKey,
  MIGRATION_KEY,
} from '../../features/sleep/utils/recordDateMigration';
import { sanitizeRecord } from '../../features/sleep/utils/recordSanitize';
import type { SleepRecord } from '../types/sleep';
import { listBackupSlices } from './registry';

export const BACKUP_SCHEMA = 3;
export const SUPPORTED_FULL_SCHEMAS = [2, 3] as const;

export interface FullBackup {
  app: 'somnacare';
  schema: number;
  exportedAt: string;
  /** 第 51 轮夜归属口径标记：导出时 records 已迁移则带 'night-v1' */
  dateSchema?: string;
  records: unknown[];
  profile: Record<string, unknown> | null;
  travel: Record<string, unknown> | null;
  moments: unknown[];
  chat: unknown;
  petPrefs: { skin?: string; bubbleEvery?: number; enabled?: boolean };
  /** schema 3 起：可扩展注册表切片（如 careNotifications、未来的 CBT-I 进度、自定义标签等） */
  slices?: Record<string, unknown>;
}

const KEYS = {
  records: 'somnacare_sleep_records',
  profile: 'somnacare_user_profile',
  travel: 'somnacare_travel_state',
  moments: 'somnacare_pet_moments',
  chat: 'somnacare_chat_history',
  skin: 'somnacare_pet_skin',
  bubble: 'somnacare_pet_bubble_every',
  petEnabled: 'somnacare_pet_enabled',
} as const;

/** 这些字段属于"数据去向"类凭据，永不进备份文件，导入后保留本机值。 */
const SENSITIVE_PROFILE_KEYS = ['deepseekApiKey', 'customApiKey', 'customBaseUrl'];

/**
 * 导入白名单（复审 V13）：profile / aiConfig 只接受下列已知字段。
 * 与 UserProfile / CustomAIConfig 保持双向一致（由 tests/unit/backup.test.ts 守卫）。
 */
const PROFILE_FIELDS = [
  'name', 'age', 'targetBedtime', 'targetWakeTime', 'targetDurationHours',
  'smartAlarmEnabled', 'smartWakeWindowMinutes', 'soundDetectionSensitivity',
  'themeColor', 'brightnessLevel', 'warmthFilter', 'eyeCare', 'chronotype',
  'bedtimeReminderEnabled',
  'nightRescueEnabled', 'alarms', 'sleepRecordMode', 'ambientLightEnabled', 'aiConfig',
] as const;
const AI_CONFIG_FIELDS = [
  'provider', 'deepseekApiKey', 'deepseekModel', 'customBaseUrl',
  'customApiKey', 'customModelName', 'systemPersona', 'localModelVariant',
] as const;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function buildFullBackup(): FullBackup {
  let profile = readJson(KEYS.profile);
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    profile = JSON.parse(JSON.stringify(profile));
    const ai = (profile as Record<string, any>).aiConfig;
    if (ai && typeof ai === 'object') {
      for (const k of SENSITIVE_PROFILE_KEYS) delete ai[k];
    }
  } else {
    profile = null;
  }

  let travel = readJson(KEYS.travel);
  if (!travel || typeof travel !== 'object' || Array.isArray(travel)) travel = null;

  const moments = readJson(KEYS.moments);
  const chat = readJson(KEYS.chat);
  const records = readJson(KEYS.records);

  const skin = localStorage.getItem(KEYS.skin);
  const bubbleRaw = localStorage.getItem(KEYS.bubble);
  const bubbleEvery = bubbleRaw !== null ? Number(bubbleRaw) : NaN;
  const petEnabledRaw = localStorage.getItem(KEYS.petEnabled);

  const slices: Record<string, unknown> = {};
  for (const slice of listBackupSlices()) {
    try {
      const val = slice.exportSlice();
      if (val !== undefined) slices[slice.id] = val;
    } catch {
      // 单个切片读取异常不阻塞核心睡眠备份
    }
  }

  return {
    app: 'somnacare',
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    dateSchema: recordDateMigrationDone() ? 'night-v1' : undefined,
    records: Array.isArray(records) ? records : [],
    profile: profile as Record<string, unknown> | null,
    travel: travel as Record<string, unknown> | null,
    moments: Array.isArray(moments) ? moments : [],
    chat:
      chat !== null &&
      (Array.isArray(chat) || (typeof chat === 'object' && Array.isArray((chat as { sessions?: unknown }).sessions)))
        ? chat
        : [],
    petPrefs: {
      skin: skin || undefined,
      bubbleEvery: Number.isFinite(bubbleEvery) ? bubbleEvery : undefined,
      enabled: petEnabledRaw === '1' ? true : petEnabledRaw === '0' ? false : undefined,
    },
    slices,
  };
}

export type ParsedBackup =
  | { kind: 'full'; data: FullBackup }
  | { kind: 'records-only'; records: unknown[] };

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_RECORDS = 50000;

/** 将 schema 2 备份结构无损升迁为 schema 3 */
export function migrateV2ToV3(raw: FullBackup): FullBackup {
  return {
    ...raw,
    schema: BACKUP_SCHEMA,
    slices: raw.slices && typeof raw.slices === 'object' ? raw.slices : {},
  };
}

/** 识别备份类型：schema 2/3 全量 或 旧版纯记录数组。解析失败抛错。 */
export function parseBackup(raw: string): ParsedBackup {
  if (raw.length > IMPORT_MAX_BYTES) throw new Error('too-big');
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (parsed.length > IMPORT_MAX_RECORDS) throw new Error('too-many-records');
    return { kind: 'records-only', records: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (
      o.app === 'somnacare' &&
      (o.schema === 2 || o.schema === BACKUP_SCHEMA)
    ) {
      const data = o as unknown as FullBackup;
      if (!Array.isArray(data.records)) {
        throw new Error('bad-records');
      }
      if (data.records.length > IMPORT_MAX_RECORDS) {
        throw new Error('too-many-records');
      }
      return {
        kind: 'full',
        data: o.schema === 2 ? migrateV2ToV3(data) : data,
      };
    }
    throw new Error('unknown-schema');
  }
  throw new Error('not-a-backup');
}

/** 落盘全量恢复（含所有已注册切片的原子快照与异常整体回滚）。 */
export function restoreFullBackup(data: FullBackup): {
  records: number;
  moments: number;
  chat: number;
  travel: boolean;
  profile: boolean;
  slices: string[];
} {
  const sliceKeys = listBackupSlices().flatMap((s) => s.storageKeys);
  const snapshotKeys = Array.from(
    new Set([
      KEYS.records,
      KEYS.profile,
      KEYS.travel,
      KEYS.moments,
      KEYS.chat,
      KEYS.skin,
      KEYS.bubble,
      KEYS.petEnabled,
      MIGRATION_KEY,
      ...sliceKeys,
    ]),
  );
  const snapshot = snapshotKeys.map((k) => [k, localStorage.getItem(k)] as const);
  try {
    return restoreFullBackupInner(data);
  } catch (err) {
    for (const [k, v] of snapshot) {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* 回滚本身失败已尽力 */
      }
    }
    throw err;
  }
}

function restoreFullBackupInner(data: FullBackup): {
  records: number;
  moments: number;
  chat: number;
  travel: boolean;
  profile: boolean;
  slices: string[];
} {
  const incoming = Array.isArray(data.records) ? data.records : [];
  const alreadyNight = data.dateSchema === 'night-v1' || recordDateMigrationDone();
  let outRecords: unknown[] = incoming;
  if (data.dateSchema !== 'night-v1' && recordDateMigrationDone()) {
    let chronotype: 'night' | 'day' | 'irregular' = 'night';
    const c = (data.profile as any)?.chronotype;
    if (c === 'day' || c === 'irregular') chronotype = c;
    outRecords = migrateRecordDatesToNightKey(
      incoming.map((r) => sanitizeRecord(r)).filter((r): r is SleepRecord => r !== null),
      chronotype,
    ).records;
  }
  localStorage.setItem(KEYS.records, JSON.stringify(outRecords));
  if (alreadyNight) {
    markRecordDateMigrationDone();
  }

  if (data.profile && typeof data.profile === 'object') {
    let existing: Record<string, any> = {};
    try {
      const cur = localStorage.getItem(KEYS.profile);
      if (cur) existing = JSON.parse(cur) ?? {};
    } catch {
      /* ignore */
    }
    const currentAi = (existing.aiConfig ?? {}) as Record<string, unknown>;
    const src = data.profile as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const k of PROFILE_FIELDS) {
      if (src[k] !== undefined) merged[k] = src[k];
    }
    const srcAi = (src.aiConfig ?? {}) as Record<string, unknown>;
    const restoredAi: Record<string, unknown> = { ...currentAi };
    const NEVER_FROM_BACKUP = new Set(['deepseekApiKey', 'customApiKey']);
    for (const k of AI_CONFIG_FIELDS) {
      if (srcAi[k] !== undefined && !NEVER_FROM_BACKUP.has(k)) restoredAi[k] = srcAi[k];
    }
    // 策略级安全：customBaseUrl 永不随备份迁移
    delete restoredAi.customBaseUrl;
    for (const k of SENSITIVE_PROFILE_KEYS) {
      if (!restoredAi[k]) restoredAi[k] = currentAi[k] ?? '';
    }
    merged.aiConfig = restoredAi;
    localStorage.setItem(KEYS.profile, JSON.stringify(merged));
  }

  if (data.travel && typeof data.travel === 'object') {
    localStorage.setItem(KEYS.travel, JSON.stringify(data.travel));
  }
  if (Array.isArray(data.moments)) {
    localStorage.setItem(KEYS.moments, JSON.stringify(data.moments));
  }
  {
    const c = data.chat as unknown;
    const ok =
      Array.isArray(c) ||
      (c !== null && typeof c === 'object' && Array.isArray((c as { sessions?: unknown }).sessions));
    if (ok) localStorage.setItem(KEYS.chat, JSON.stringify(c));
  }
  if (data.petPrefs?.skin) localStorage.setItem(KEYS.skin, data.petPrefs.skin);
  if (typeof data.petPrefs?.bubbleEvery === 'number') {
    localStorage.setItem(KEYS.bubble, String(data.petPrefs.bubbleEvery));
  }
  if (typeof data.petPrefs?.enabled === 'boolean') {
    localStorage.setItem(KEYS.petEnabled, data.petPrefs.enabled ? '1' : '0');
  }

  // 恢复已注册的可扩展切片（只接受在注册表中登记的切片，未知字段静默忽略）
  const restoredSlices: string[] = [];
  if (data.slices && typeof data.slices === 'object') {
    for (const slice of listBackupSlices()) {
      if (Object.prototype.hasOwnProperty.call(data.slices, slice.id)) {
        slice.importSlice((data.slices as Record<string, unknown>)[slice.id]);
        restoredSlices.push(slice.id);
      }
    }
  }

  const chatRaw = data.chat as unknown;
  const chatCount = Array.isArray(chatRaw)
    ? chatRaw.length
    : chatRaw !== null &&
        typeof chatRaw === 'object' &&
        Array.isArray((chatRaw as { sessions?: unknown }).sessions)
      ? (chatRaw as { sessions: unknown[] }).sessions.length
      : 0;

  return {
    records: Array.isArray(data.records) ? data.records.length : 0,
    moments: Array.isArray(data.moments) ? data.moments.length : 0,
    chat: chatCount,
    travel: !!data.travel,
    profile: !!data.profile,
    slices: restoredSlices,
  };
}
