import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from './_helpers';
import {
  buildFullBackup,
  parseBackup,
  restoreFullBackup,
} from '../../src/shared/storage/backup';
import {
  AD_SKIP_EXCLUDED_STORAGE_KEY,
  getAdSkipStatus,
  pushRestoredAdSkipExcludedToNative,
  readLocalAdSkipExcludedPkgs,
  refreshAdSkipRules,
  syncAdSkipExcludedToLocal,
  writeLocalAdSkipExcludedPkgs,
} from '../../src/features/extensions/ad-skip/adSkip';

const storage = installMemoryStorage();

function installMockAdSkipNative() {
  const mock = {
    adSkipStatus: vi.fn(async () => ({
      enabled: true,
      serviceEnabled: true,
      hits: 12,
      diag: ['12:00:01 hit=app-splash[跳过]'],
      excludedPkgs: ['com.eg.android.AlipayGphone', 'com.tencent.mm'],
      excludedLabels: {
        'com.tencent.mm': '微信',
        'com.eg.android.AlipayGphone': '支付宝',
      },
      recentHits: [
        { pkg: 'tv.danmaku.bili', label: '哔哩哔哩', at: 1760000005000, source: 'app-splash', text: '跳过 3s' },
        { pkg: 'com.taobao.taobao', label: '淘宝', at: 1760000004000, source: 'app-splash', text: '跳过' },
        { pkg: 'com.sankuai.meituan', label: '美团', at: 1760000003000, source: 'app-inapp', text: '关闭' },
        { pkg: 'com.baidu.tieba', label: '贴吧', at: 1760000002000, source: 'app-splash', text: '跳过' },
        { pkg: 'com.zhihu.android', label: '知乎', at: 1760000001000, source: 'global-splash', text: '跳过' },
        { pkg: 'com.overflow.sixth', label: '第6条应被截断', at: 1760000000000 },
      ],
      rulesVersion: 668,
      rulesAppCount: 1153,
      rulesSource: 'hot',
      rulesUpdatedAt: 1760000005000,
    })),
    adSkipSetExcludedPackages: vi.fn(async ({ pkgs }: { pkgs: string[] }) => ({
      ok: true,
      excludedPkgs: pkgs,
      excludedLabels: {},
    })),
    adSkipRefreshRules: vi.fn(async () => ({
      ok: true,
      version: 669,
      appCount: 1158,
      updatedAt: 1760000010000,
    })),
  };
  (globalThis as any).window = {
    ...(globalThis as any).window,
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { AdSkip: mock },
    },
  };
  return mock;
}

describe('广告跳过：Backup v3 白名单切片、最近 5 条命中与手动刷新规则桥接', () => {
  beforeEach(() => {
    storage.clear();
    delete (globalThis as any).window?.Capacitor;
  });

  it('adSkip.excludedPkgs 完整纳入 Backup v3 导出、清洗去重、恢复与回滚', () => {
    writeLocalAdSkipExcludedPkgs(['  com.tencent.mm ', 'com.cmbchina.pb', 'com.tencent.mm', '']);
    const backup = buildFullBackup();
    expect(backup.schema).toBe(3);
    expect(backup.slices?.adSkip).toEqual({
      excludedPkgs: ['com.cmbchina.pb', 'com.tencent.mm'],
    });

    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.kind).toBe('full');
    if (parsed.kind !== 'full') throw new Error('expected full');

    storage.clear();
    expect(readLocalAdSkipExcludedPkgs()).toEqual([]);

    const summary = restoreFullBackup(parsed.data);
    expect(summary.slices).toContain('adSkip');
    expect(readLocalAdSkipExcludedPkgs()).toEqual(['com.cmbchina.pb', 'com.tencent.mm']);
    expect(JSON.parse(storage.map.get(AD_SKIP_EXCLUDED_STORAGE_KEY)!)).toEqual([
      'com.cmbchina.pb',
      'com.tencent.mm',
    ]);
  });

  it('原生状态解析最近 5 条跳过事件、已排除应用名与规则元数据，并支持双向同步与手动刷新', async () => {
    const mock = installMockAdSkipNative();

    const st = await getAdSkipStatus();
    expect(st.enabled).toBe(true);
    expect(st.excludedLabels['com.tencent.mm']).toBe('微信');
    expect(st.excludedLabels['com.eg.android.AlipayGphone']).toBe('支付宝');
    expect(st.recentHits).toHaveLength(5);
    expect(st.recentHits[0].label).toBe('哔哩哔哩');
    expect(st.rulesVersion).toBe(668);
    expect(st.rulesAppCount).toBe(1153);
    expect(st.rulesSource).toBe('hot');

    // 导出前同步原生名单到 localStorage
    storage.clear();
    const synced = await syncAdSkipExcludedToLocal();
    expect(synced).toEqual(['com.eg.android.AlipayGphone', 'com.tencent.mm']);
    expect(readLocalAdSkipExcludedPkgs()).toEqual(['com.eg.android.AlipayGphone', 'com.tencent.mm']);

    // 导入后推送恢复的名单回原生
    writeLocalAdSkipExcludedPkgs(['com.icbc', 'com.tencent.mm']);
    await pushRestoredAdSkipExcludedToNative();
    expect(mock.adSkipSetExcludedPackages).toHaveBeenCalledWith({
      pkgs: ['com.icbc', 'com.tencent.mm'],
    });

    // 显式手动刷新规则
    const refreshed = await refreshAdSkipRules();
    expect(refreshed.ok).toBe(true);
    expect(refreshed.version).toBe(669);
    expect(refreshed.appCount).toBe(1158);
  });
});
