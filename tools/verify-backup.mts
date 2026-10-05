/**
 * 护栏：全量备份的 roundtrip 与凭据剥离。
 *
 * 备份文件会离开设备（发微信/存网盘）——凭据泄漏是静默事故，
 * 必须有护栏：buildFullBackup 的输出里绝不允许出现 API 密钥/HF token。
 *
 * 方法论约束：护栏必须能反向验证——构造含密钥的 profile 必须被剥掉。
 */
import { fileURLToPath } from 'node:url';

// localStorage polyfill（Node 环境跑真实 backup 模块）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { buildFullBackup, parseBackup, restoreFullBackup, BACKUP_SCHEMA, IMPORT_MAX_BYTES } =
  await import(new URL('../src/utils/backup.ts', import.meta.url).href);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 造数据：含密钥的 profile + 各数据域 ──
store.set('somnacare_sleep_records', JSON.stringify([
  { id: 'r1', date: '2026-10-01', bedtime: '23:00', wakeTime: '07:00', durationMinutes: 480, sleepScore: 85, deepSleepMinutes: 96, remSleepMinutes: 96, lightSleepMinutes: 240, awakeMinutes: 20, latencyMinutes: 10, latencyEstimated: true, sleepStages: [] },
]));
store.set('somnacare_user_profile', JSON.stringify({
  name: '鱼片',
  themeColor: 'midnight',
  targetBedtime: '23:30',
  targetWakeTime: '07:30',
  targetDurationHours: 8,
  aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-SECRET-123', customApiKey: 'ck-SECRET-456', deepseekModel: 'deepseek-chat' },
  alarms: [{ id: 'a1', time: '07:30', label: '晨起', enabled: true, repeatDays: [1, 2, 3, 4, 5], tone: 'gentle_chime', vibrate: true, smartWakeEnabled: false, smartWakeWindowMinutes: 20 }],
  eyeCare: { enabled: false },
}));
store.set('somnacare_travel_state', JSON.stringify({ currentEnergy: 30, targetEnergy: 80, totalTrips: 5, unlockedCardIds: ['card-asia-01', 'card-europe-19'], souvenirInventory: ['定胜糕'], goldStars: { 'card-asia-01': 3 }, pendingArrival: null }));
store.set('somnacare_pet_moments', JSON.stringify([{ id: 'm1', date: '2026-10-01', ts: 1, text: '哼', facts: [], cards: ['data'], likes: [], comments: [], liked: false, replies: [] }]));
store.set('somnacare_chat_history', JSON.stringify([{ id: 'c1', role: 'user', content: '你好', timestamp: '07:00' }]));
store.set('somnacare_hf_token', 'hf-SECRET-789');
store.set('somnacare_pet_skin', 'sakura');
store.set('somnacare_pet_bubble_every', '8');

// ── 1. 凭据剥离 ──
const backup = buildFullBackup();
const raw = JSON.stringify(backup);
check('备份不含 DeepSeek 密钥', !raw.includes('sk-SECRET-123'));
check('备份不含自建 API 密钥', !raw.includes('ck-SECRET-456'));
check('备份不含 HF token', !raw.includes('hf-SECRET-789'));
check('备份 schema = ' + BACKUP_SCHEMA, backup.schema === BACKUP_SCHEMA && backup.app === 'somnacare');
check('档案保留非敏感字段', (backup.profile as any)?.name === '鱼片' && (backup.profile as any)?.targetBedtime === '23:30');
check('图鉴进备份', (backup.travel as any)?.totalTrips === 5);
check('朋友圈/聊天进备份', backup.moments.length === 1 && backup.chat.length === 1);
check('桌宠偏好进备份', backup.petPrefs?.skin === 'sakura' && backup.petPrefs?.bubbleEvery === 8);
check('使用行为数据刻意排除', !raw.includes('somnacare_usage_days') && !('usage' in (backup as any)));

// ── 2. parse 识别两代格式 ──
const p1 = parseBackup(raw);
check('识别全量（schema 2）', p1.kind === 'full');
const legacy = JSON.stringify([{ id: 'r1', date: '2026-10-01' }]);
const p2 = parseBackup(legacy);
check('识别旧版（纯记录数组）', p2.kind === 'records-only');
let threw = false;
try { parseBackup('{"app":"other","schema":99}'); } catch { threw = true; }
check('未知 schema → 报错（防静默半恢复）', threw);

// ── 3. restore roundtrip：清空 store 后恢复，各域数值一致 ──
for (const k of [...store.keys()]) store.delete(k);
const summary = restoreFullBackup(p1.kind === 'full' ? p1.data : (null as never));
check('恢复：记录 1 条', summary.records === 1);
check('恢复：图鉴进度', JSON.parse(store.get('somnacare_travel_state')!).totalTrips === 5);
check('恢复：朋友圈 1 条', store.get('somnacare_pet_moments')!.includes('m1'));
check('恢复：聊天 1 条', store.get('somnacare_chat_history')!.includes('c1'));
check('恢复：桌宠偏好', store.get('somnacare_pet_skin') === 'sakura');
// 凭据回填：备份里没有 → 保留本机值（恢复前 store 里没有 → 应为空字符串，不报错）
const prof = JSON.parse(store.get('somnacare_user_profile')!);
check('恢复：aiConfig 存在且无密钥泄漏路径', prof.aiConfig && prof.aiConfig.deepseekApiKey === '');
// 再验证"本机已有密钥时保留"分支
store.set('somnacare_user_profile', JSON.stringify({ aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-LOCAL-EXISTING' } }));
restoreFullBackup(p1.kind === 'full' ? p1.data : (null as never));
const prof2 = JSON.parse(store.get('somnacare_user_profile')!);
check('恢复：本机已有密钥被保留（不被空值覆盖）', prof2.aiConfig.deepseekApiKey === 'sk-LOCAL-EXISTING');

// ── V13 残留（第 44 轮复审）：profile 字段注入 —— 恶意备份改写 customBaseUrl 必须被挡 ──
// （对象展开本身无原型污染——CreateDataProperty，复审实测——真正的面是"任意字段注入"）
{
  const malicious = {
    app: 'somnacare', schema: BACKUP_SCHEMA, exportedAt: '2026-10-05T00:00:00.000Z',
    records: [],
    profile: {
      name: '受害者',
      aiConfig: {
        provider: 'custom_openai',
        customBaseUrl: 'http://169.254.169.254/steal',   // 非 https + 元数据地址 → 必须整条丢弃
        customApiKey: 'attacker-key',
      },
      hackerField: 'pwned',                              // 白名单外的字段 → 不得进入 profile
    },
  };
  const parsed = parseBackup(JSON.stringify(malicious));
  if (parsed.kind !== 'full') {
    check('V13：恶意全量备份可解析', false);
  } else {
    restoreFullBackup(parsed.data);
    const prof = JSON.parse(store.get('somnacare_user_profile')!);
    check('V13：白名单外字段（hackerField）不进入 profile', !('hackerField' in prof));
    check('V13：customBaseUrl 非 https/元数据地址 → 被丢弃', prof.aiConfig?.customBaseUrl === undefined);
    check('V13：无原型污染残留', (Object.prototype as any).hackerField === undefined);
  }
  // 合法 https 端点照常保留
  const okBody = { app: 'somnacare', schema: BACKUP_SCHEMA, exportedAt: '', records: [],
    profile: { aiConfig: { provider: 'custom_openai', customBaseUrl: 'https://api.deepseek.com' } } };
  restoreFullBackup((parseBackup(JSON.stringify(okBody)) as { kind: 'full'; data: never }).data);
  const prof3 = JSON.parse(store.get('somnacare_user_profile')!);
  check('V13：合法 https customBaseUrl 保留', prof3.aiConfig.customBaseUrl === 'https://api.deepseek.com');
  // 上限分流：条数 / 字符长度（R2 纵深）
  try {
    parseBackup('[' + '1,'.repeat(60000) + '1]');
    check('V13：记录超 5 万条被拒', false);
  } catch (e) {
    check('V13：记录超 5 万条被拒（too-many-records）', (e as Error).message === 'too-many-records');
  }
  try {
    parseBackup('x'.repeat(IMPORT_MAX_BYTES + 1));
    check('V13：raw 超 20MB 被拒（R2 纵深）', false);
  } catch (e) {
    check('V13：raw 超 20MB 被拒（too-big）', (e as Error).message === 'too-big');
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——备份护栏口径不符`);
  process.exit(1);
}
console.log('\n✓ verify-backup：roundtrip 与凭据剥离全部符合口径');
