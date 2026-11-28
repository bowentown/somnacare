import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from './_helpers';
import {
  BACKUP_SCHEMA,
  buildFullBackup,
  type FullBackup,
  migrateV2ToV3,
  parseBackup,
  restoreFullBackup,
} from '../../src/shared/storage/backup';
import {
  listBackupSlices,
  registerBackupSlice,
  STORAGE_CATALOG,
  unregisterBackupSlice,
} from '../../src/shared/storage/registry';

const storage = installMemoryStorage();

describe('统一 Storage 注册表与 Backup v3 向下兼容迁移', () => {
  beforeEach(() => {
    storage.clear();
    unregisterBackupSlice('testCustomSlice');
  });

  it('STORAGE_CATALOG 完整登记全部 43 个 somnacare_* 键且无重名', () => {
    expect(BACKUP_SCHEMA).toBe(3);
    expect(STORAGE_CATALOG.length).toBe(43);
    const keys = STORAGE_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(43);
    expect(keys.every((k) => k.startsWith('somnacare_'))).toBe(true);

    // 敏感密钥必须标记为 secret，绝不能进入 backup 策略
    const hf = STORAGE_CATALOG.find((e) => e.key === 'somnacare_hf_token');
    expect(hf?.policy).toBe('secret');
    // 关怀提醒、睡前干预、深夜刷屏提醒与跳广告排除名单切片均已通过注册表纳管
    expect(listBackupSlices().some((s) => s.id === 'careNotifications')).toBe(true);
    expect(listBackupSlices().some((s) => s.id === 'intervention')).toBe(true);
    expect(listBackupSlices().some((s) => s.id === 'petStimulusGuard')).toBe(true);
    expect(listBackupSlices().some((s) => s.id === 'adSkip')).toBe(true);
  });

  it('真实 v1.42.0（schema: 2）备份可无缝升级到 v3 并恢复记录、档案、图鉴、朋友圈与聊天', () => {
    const v2Snapshot = {
      app: 'somnacare',
      schema: 2,
      exportedAt: '2026-10-01T08:00:00.000Z',
      records: [
        {
          id: 'v2-rec-1',
          date: '2026-09-30',
          bedtime: '23:15',
          wakeTime: '07:15',
          durationMinutes: 480,
          sleepScore: 88,
          deepSleepMinutes: 100,
          remSleepMinutes: 95,
          lightSleepMinutes: 265,
          awakeMinutes: 20,
          latencyMinutes: 12,
          latencyEstimated: true,
        },
      ],
      profile: {
        name: '老版本用户',
        themeColor: 'serene_blue',
        targetBedtime: '23:00',
        targetWakeTime: '07:00',
        targetDurationHours: 8,
        aiConfig: { provider: 'local_rules' },
      },
      travel: {
        currentEnergy: 120,
        targetEnergy: 200,
        totalTrips: 3,
        unlockedCardIds: ['card-asia-01', 'card-asia-02'],
        souvenirInventory: ['粉白软糯定胜糕'],
        goldStars: {},
        countedScores: { '2026-09-30': 88 },
        pendingArrival: null,
      },
      moments: [
        {
          id: 'm-v2',
          date: '2026-09-30',
          ts: 1760000000000,
          text: '昨夜睡得不错',
          facts: [],
          cards: ['data'],
          likes: [],
          comments: [],
          liked: true,
          replies: [],
        },
      ],
      chat: {
        sessions: [
          {
            id: 's-v2',
            title: '深睡建议',
            updatedAt: 1760000000000,
            messages: [{ id: 'msg1', role: 'user', content: '怎么睡更香', timestamp: '22:30' }],
          },
        ],
        activeId: 's-v2',
      },
      petPrefs: { skin: 'sakura', bubbleEvery: 6 },
    };

    const parsed = parseBackup(JSON.stringify(v2Snapshot));
    expect(parsed.kind).toBe('full');
    if (parsed.kind !== 'full') throw new Error('expected full');
    expect(parsed.data.schema).toBe(3);

    const summary = restoreFullBackup(parsed.data);
    expect(summary.records).toBe(1);
    expect(summary.profile).toBe(true);
    expect(summary.travel).toBe(true);
    expect(summary.moments).toBe(1);
    expect(summary.chat).toBe(1);
    expect(storage.map.get('somnacare_pet_skin')).toBe('sakura');
    expect(storage.map.get('somnacare_pet_bubble_every')).toBe('6');
    expect(JSON.parse(storage.map.get('somnacare_user_profile')!).themeColor).toBe('serene_blue');

    // 直接调用 migrateV2ToV3 也幂等
    const upgraded = migrateV2ToV3(v2Snapshot as unknown as FullBackup);
    expect(upgraded.schema).toBe(3);
  });

  it('内置 careNotifications 切片与新注册扩展切片支持 v3 导出、恢复与失败原子回滚', () => {
    storage.map.set('somnacare_notify_morning', '0');
    storage.map.set('somnacare_notify_recall', '1');

    registerBackupSlice({
      id: 'testCustomSlice',
      storageKeys: ['somnacare_test_winddown'],
      exportSlice: () => {
        const raw = localStorage.getItem('somnacare_test_winddown');
        return raw ? JSON.parse(raw) : undefined;
      },
      importSlice: (data) => {
        if (data && typeof data === 'object' && 'fail' in (data as Record<string, unknown>)) {
          throw new Error('simulated-slice-failure');
        }
        if (data !== undefined) {
          localStorage.setItem('somnacare_test_winddown', JSON.stringify(data));
        }
      },
    });

    storage.map.set('somnacare_test_winddown', JSON.stringify({ checklist: ['放下手机', '4-7-8呼吸'] }));
    const backup = buildFullBackup();
    expect(backup.schema).toBe(3);
    expect(backup.slices?.careNotifications).toEqual({ morning: false, recall: true });
    expect(backup.slices?.testCustomSlice).toEqual({ checklist: ['放下手机', '4-7-8呼吸'] });

    // 清空后完整恢复
    storage.clear();
    const res = restoreFullBackup(backup);
    expect(res.slices).toContain('careNotifications');
    expect(res.slices).toContain('testCustomSlice');
    expect(storage.map.get('somnacare_notify_morning')).toBe('0');
    expect(storage.map.get('somnacare_notify_recall')).toBe('1');
    expect(JSON.parse(storage.map.get('somnacare_test_winddown')!).checklist).toHaveLength(2);

    // 故障注入：导入中自定义切片抛错时，先前已写入的所有键必须原子回滚
    storage.map.set('somnacare_notify_morning', '1');
    const badBackup = {
      ...backup,
      slices: {
        careNotifications: { morning: false, recall: false },
        testCustomSlice: { fail: true },
      },
    };
    expect(() => restoreFullBackup(badBackup)).toThrow('simulated-slice-failure');
    expect(storage.map.get('somnacare_notify_morning')).toBe('1');
    expect(storage.map.get('somnacare_notify_recall')).toBe('1');
  });
});
