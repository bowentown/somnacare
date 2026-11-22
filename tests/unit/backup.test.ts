import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMemoryStorage } from './_helpers';
import { buildFullBackup, parseBackup, restoreFullBackup, BACKUP_SCHEMA, IMPORT_MAX_BYTES } from '../../src/shared/storage/backup';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const storage = installMemoryStorage();

describe('全量备份（roundtrip、凭据与 customBaseUrl 剥离、白名单双向一致）', () => {
  beforeEach(() => storage.clear());

  it('导出剥离所有敏感凭据并保留业务域，清空后可无损恢复且保留本机密钥', () => {
    storage.map.set(
      'somnacare_sleep_records',
      JSON.stringify([
        {
          id: 'r1', date: '2026-10-01', bedtime: '23:00', wakeTime: '07:00', durationMinutes: 480,
          sleepScore: 85, deepSleepMinutes: 96, remSleepMinutes: 96, lightSleepMinutes: 240,
          awakeMinutes: 20, latencyMinutes: 10, latencyEstimated: true,
        },
      ]),
    );
    storage.map.set(
      'somnacare_user_profile',
      JSON.stringify({
        name: '鱼片',
        themeColor: 'midnight',
        targetBedtime: '23:30',
        targetWakeTime: '07:30',
        targetDurationHours: 8,
        aiConfig: {
          provider: 'deepseek',
          deepseekApiKey: 'sk-SECRET-123',
          customApiKey: 'ck-SECRET-456',
          customBaseUrl: 'https://api.deepseek.com',
          deepseekModel: 'deepseek-chat',
        },
        alarms: [{ id: 'a1', time: '07:30', label: '晨起', enabled: true, repeatDays: [1, 2, 3, 4, 5], tone: 'gentle_chime', vibrate: true, smartWakeEnabled: false, smartWakeWindowMinutes: 20 }],
        eyeCare: { enabled: false },
      }),
    );
    storage.map.set('somnacare_travel_state', JSON.stringify({ currentEnergy: 30, targetEnergy: 80, totalTrips: 5, unlockedCardIds: ['card-asia-01'], souvenirInventory: ['定胜糕'], goldStars: { 'card-asia-01': 3 }, pendingArrival: null }));
    storage.map.set('somnacare_pet_moments', JSON.stringify([{ id: 'm1', date: '2026-10-01', ts: 1, text: '哼', facts: [], cards: ['data'], likes: [], comments: [], liked: false, replies: [] }]));
    storage.map.set('somnacare_chat_history', JSON.stringify([{ id: 'c1', role: 'user', content: '你好', timestamp: '07:00' }]));
    storage.map.set('somnacare_hf_token', 'hf-SECRET-789');
    storage.map.set('somnacare_pet_skin', 'sakura');
    storage.map.set('somnacare_pet_bubble_every', '8');

    const backup = buildFullBackup();
    const raw = JSON.stringify(backup);
    expect(raw).not.toContain('sk-SECRET-123');
    expect(raw).not.toContain('ck-SECRET-456');
    expect(raw).not.toContain('hf-SECRET-789');
    expect(raw).not.toContain('customBaseUrl');
    expect(raw).not.toContain('somnacare_usage_days');
    expect(backup.schema).toBe(BACKUP_SCHEMA);
    expect(backup.app).toBe('somnacare');
    expect((backup.profile as any)?.name).toBe('鱼片');
    expect((backup.travel as any)?.totalTrips).toBe(5);
    expect(backup.moments).toHaveLength(1);
    expect(backup.petPrefs?.skin).toBe('sakura');

    const p1 = parseBackup(raw);
    expect(p1.kind).toBe('full');
    expect(parseBackup(JSON.stringify([{ id: 'r1', date: '2026-10-01' }])).kind).toBe('records-only');
    expect(() => parseBackup('{"app":"other","schema":99}')).toThrow();

    storage.clear();
    const summary = restoreFullBackup(p1.kind === 'full' ? p1.data : (null as never));
    expect(summary.records).toBe(1);
    expect(JSON.parse(storage.map.get('somnacare_travel_state')!).totalTrips).toBe(5);
    expect(storage.map.get('somnacare_pet_skin')).toBe('sakura');
    expect(JSON.parse(storage.map.get('somnacare_user_profile')!).aiConfig.deepseekApiKey).toBe('');

    storage.map.set('somnacare_user_profile', JSON.stringify({ aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-LOCAL-EXISTING' } }));
    restoreFullBackup(p1.kind === 'full' ? p1.data : (null as never));
    expect(JSON.parse(storage.map.get('somnacare_user_profile')!).aiConfig.deepseekApiKey).toBe('sk-LOCAL-EXISTING');
  });

  it('策略级安全：备份携带的任何 customBaseUrl 与白名单外字段绝不落盘，超限输入被拒', () => {
    const mk = (customBaseUrl?: string) => ({
      app: 'somnacare',
      schema: BACKUP_SCHEMA,
      exportedAt: '2026-10-05T00:00:00.000Z',
      records: [],
      profile: {
        name: '受害者',
        hackerField: 'pwned',
        aiConfig: {
          provider: 'custom_openai',
          customApiKey: 'attacker-key',
          ...(customBaseUrl ? { customBaseUrl } : {}),
        },
      },
    });

    const probeUrls = [
      'http://169.254.169.254/steal',
      'https://[::1]:8443/',
      'https://[fd00::1]/',
      'https://100.64.0.1/',
      'https://attacker.example/v1',
      'https://api.deepseek.com',
    ];
    for (const url of probeUrls) {
      storage.map.set(
        'somnacare_user_profile',
        JSON.stringify({ aiConfig: { provider: 'custom_openai', customBaseUrl: 'https://api.deepseek.com', customApiKey: 'sk-LOCAL' } }),
      );
      const parsed = parseBackup(JSON.stringify(mk(url)));
      restoreFullBackup(parsed.kind === 'full' ? parsed.data : (null as never));
      const prof = JSON.parse(storage.map.get('somnacare_user_profile')!);
      expect(prof.aiConfig.customBaseUrl).toBe('https://api.deepseek.com');
      expect(prof.aiConfig.customApiKey).toBe('sk-LOCAL');
      expect('hackerField' in prof).toBe(false);
    }

    storage.map.set('somnacare_user_profile', JSON.stringify({}));
    const parsedEmpty = parseBackup(JSON.stringify(mk('https://attacker.example/v1')));
    restoreFullBackup(parsedEmpty.kind === 'full' ? parsedEmpty.data : (null as never));
    expect(JSON.parse(storage.map.get('somnacare_user_profile')!).aiConfig?.customBaseUrl || '').toBe('');

    expect(() => parseBackup('[' + '1,'.repeat(60000) + '1]')).toThrow('too-many-records');
    expect(() => parseBackup('x'.repeat(IMPORT_MAX_BYTES + 1))).toThrow('too-big');
  });

  it('导入白名单与 UserProfile / CustomAIConfig 类型定义双向一致', () => {
    const typesSrc = readFileSync(join(ROOT, 'src/shared/types/sleep.ts'), 'utf-8');
    const backupSrc = readFileSync(join(ROOT, 'src/shared/storage/backup.ts'), 'utf-8');

    const ifaceFields = (name: string): string[] => {
      const start = typesSrc.indexOf(`export interface ${name}`);
      const open = typesSrc.indexOf('{', start);
      const close = typesSrc.indexOf('\n}', open);
      return [...typesSrc.slice(open, close).matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1]).sort();
    };
    const listedFields = (constName: string): string[] => {
      const m = backupSrc.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\]`));
      return m ? [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort() : [];
    };

    expect(listedFields('PROFILE_FIELDS')).toEqual(ifaceFields('UserProfile'));
    expect(listedFields('AI_CONFIG_FIELDS')).toEqual(ifaceFields('CustomAIConfig'));
  });
});
