/**
 * 全量备份（schema 2）：旧版导出只含睡眠记录——卸载/换机会丢掉
 * 图鉴收集、朋友圈、AI 配置与聊天。本模块把可再生的排除（会话态
 * 标记）、敏感的默认排除（API 密钥/HF token 不进文件——备份文件
 * 会离开设备，不应当凭据）、设备指纹级刻意排除（使用行为数据），
 * 其余全部纳入。
 *
 * 兼容：导入端自动识别旧版（纯 records 数组）与新版（schema 2）。
 */

export const BACKUP_SCHEMA = 2;

export interface FullBackup {
  app: 'somnacare';
  schema: number;
  exportedAt: string;
  records: unknown[];
  profile: Record<string, unknown> | null;
  travel: Record<string, unknown> | null;
  moments: unknown[];
  // 多会话（chatStore v1）起为 {v:1,sessions,activeId}；旧版平铺数组。形状校验由 loadChatState 承担
  chat: unknown;
  petPrefs: { skin?: string; bubbleEvery?: number; enabled?: boolean };
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

/** 这些 profile 字段是凭据，默认不进备份文件。 */
const SENSITIVE_PROFILE_KEYS = ['deepseekApiKey', 'customApiKey'];
const SENSITIVE_TOP_KEYS = ['somnacare_hf_token'];

/**
 * 导入白名单（复审 V13 残留）：profile/aiConfig 只接受下列已知字段。
 * 维护提醒：给 UserProfile / CustomAIConfig 加新字段时同步补这里——
 * 白名单的意义就是"没列进来的键（无论来自多旧的备份文件）都进不来"。
 */
const PROFILE_FIELDS = [
  'name', 'age', 'targetBedtime', 'targetWakeTime', 'targetDurationHours',
  'smartAlarmEnabled', 'smartWakeWindowMinutes', 'soundDetectionSensitivity',
  'themeColor', 'brightnessLevel', 'warmthFilter', 'eyeCare', 'chronotype',
  'bedtimeReminderEnabled', 'alarms', 'sleepRecordMode', 'aiConfig',
] as const;
const AI_CONFIG_FIELDS = [
  'provider', 'deepseekApiKey', 'deepseekModel', 'customBaseUrl',
  'customApiKey', 'customModelName', 'systemPersona', 'localModelVariant',
] as const;

/**
 * customBaseUrl 的客户端精简校验（isSafeHttpsUrl 的 APK 版）：
 * 仅 https + 非 loopback/私网/元数据/IPv4-mapped。server.ts 的完整版不进 APK。
 */
function isSafeEndpoint(url: unknown): boolean {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (h.startsWith('::ffff:')) return false;   // IPv4-mapped（Node 归一化形态，已实证可绕过字符串判定）
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
    // 凭据剥离（深拷贝，不动原对象）
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

  return {
    app: 'somnacare',
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    records: Array.isArray(records) ? records : [],
    profile: profile as Record<string, unknown> | null,
    travel: travel as Record<string, unknown> | null,
    moments: Array.isArray(moments) ? moments : [],
    // chat 形状 v1 起为 {v:1,sessions,activeId}（多会话，chatStore）；旧版为平铺数组。
    // 对象形状也必须带出——此前 Array.isArray 守卫把多会话聊天静默排除出全量备份
    chat: chat !== null && (Array.isArray(chat) || (typeof chat === 'object' && Array.isArray((chat as { sessions?: unknown }).sessions))) ? chat : [],
    petPrefs: {
      skin: skin || undefined,
      bubbleEvery: Number.isFinite(bubbleEvery) ? bubbleEvery : undefined,
      enabled: petEnabledRaw === '1' ? true : petEnabledRaw === '0' ? false : undefined,
    },
  };
}

export type ParsedBackup =
  | { kind: 'full'; data: FullBackup }
  | { kind: 'records-only'; records: unknown[] };

/** 导入上限（复审 V13）：超大文件同步 JSON.parse 会冻结主线程、超多记录会
 *  撑爆 localStorage 配额——在读入/落盘前先挡，错误文案与"不是合法备份"区分。 */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_RECORDS = 50000;

/** 识别备份类型：schema 2 全量 / 旧版纯记录数组。解析失败抛错。
 *  复审 R2：raw.length 上限作为 UI 层文件检查之外的纵深（字符串长度 ≤
 *  UTF-8 字节数，超限者字节必然超限——保守方向正确）。 */
export function parseBackup(raw: string): ParsedBackup {
  if (raw.length > IMPORT_MAX_BYTES) throw new Error('too-big');
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (parsed.length > IMPORT_MAX_RECORDS) throw new Error('too-many-records');
    return { kind: 'records-only', records: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (o.app === 'somnacare' && o.schema === BACKUP_SCHEMA) {
      const data = o as unknown as FullBackup;
      if (Array.isArray(data.records) && data.records.length > IMPORT_MAX_RECORDS) {
        throw new Error('too-many-records');
      }
      return { kind: 'full', data };
    }
    throw new Error('unknown-schema');
  }
  throw new Error('not-a-backup');
}

/** 落盘全量恢复（各数据域沿用读取端已有的逐字段清洗，坏数据自然回退默认）。 */
export function restoreFullBackup(data: FullBackup): {
  records: number; moments: number; chat: number; travel: boolean; profile: boolean;
} {
  // records：保留原始数组，读取端 App.tsx 已有逐条 sanitize + 过滤
  localStorage.setItem(KEYS.records, JSON.stringify(Array.isArray(data.records) ? data.records : []));

  // profile：合并回填（凭据字段不在备份里，保留导入设备上已有的值）。
  // 复审 V13 残留：浅合并本身无原型污染（对象展开是 CreateDataProperty），
  // 但会接受【任意】profile 字段——恶意备份可改写 aiConfig.customBaseUrl，
  // 之后 App 会把睡眠数据与对话发往该地址。导入时按白名单挑字段，
  // customBaseUrl 另过 https + 非 loopback/私网 校验（isSafeHttpsUrl 的
  // 客户端精简版——server.ts 的完整版不进 APK）。
  if (data.profile && typeof data.profile === 'object') {
    let existing: Record<string, any> = {};
    try {
      const cur = localStorage.getItem(KEYS.profile);
      if (cur) existing = JSON.parse(cur) ?? {};
    } catch { /* ignore */ }
    const currentAi = (existing.aiConfig ?? {}) as Record<string, unknown>;
    const src = data.profile as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const k of PROFILE_FIELDS) {
      if (src[k] !== undefined) merged[k] = src[k];
    }
    const srcAi = (src.aiConfig ?? {}) as Record<string, unknown>;
    const restoredAi: Record<string, unknown> = { ...(currentAi) };
    for (const k of AI_CONFIG_FIELDS) {
      if (srcAi[k] !== undefined) restoredAi[k] = srcAi[k];
    }
    if (restoredAi.customBaseUrl !== undefined && !isSafeEndpoint(restoredAi.customBaseUrl)) {
      delete restoredAi.customBaseUrl;   // 非 https / 内网 / 元数据地址：整条丢弃
    }
    // 凭据回填：备份里没有（空/缺失）→ 保留本机已有值
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
    // 平铺数组（旧备份）与多会话对象（新备份）都原样落盘——形状校验由
    // loadChatState 承担（它对两种形状都能迁移/读取）
    const ok = Array.isArray(c) || (c !== null && typeof c === 'object' && Array.isArray((c as { sessions?: unknown }).sessions));
    if (ok) localStorage.setItem(KEYS.chat, JSON.stringify(c));
  }
  if (data.petPrefs?.skin) localStorage.setItem(KEYS.skin, data.petPrefs.skin);
  if (typeof data.petPrefs?.bubbleEvery === 'number') {
    localStorage.setItem(KEYS.bubble, String(data.petPrefs.bubbleEvery));
  }
  if (typeof data.petPrefs?.enabled === 'boolean') {
    localStorage.setItem(KEYS.petEnabled, data.petPrefs.enabled ? '1' : '0');
  }
  // 敏感 top-level key（HF token）不在备份里 → 不动本机值

  return {
    records: Array.isArray(data.records) ? data.records.length : 0,
    moments: Array.isArray(data.moments) ? data.moments.length : 0,
    chat: Array.isArray(data.chat) ? data.chat.length : 0,
    travel: !!data.travel,
    profile: !!data.profile,
  };
}
