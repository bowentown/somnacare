/**
 * 构建期刷新 GKD 广告规则（第 74 轮）：拉取订阅仓库最新 dist，
 * 复用 tools/import-gkd-splash.mts 的同一实现重建 assets/ad_skip_rules.json。
 *
 * 任何失败都直接抛错退出 1——CI 侧负责回退到仓库已提交的版本
 * （刷新失败不阻塞发版，规则可以旧，构建不能挂）。
 *
 * 用法：npx tsx tools/refresh-gkd-rules.mts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from './import-gkd-splash.mts';

const RAW_DIST = 'https://raw.githubusercontent.com/Lin-arm/GKD_subscription/main/dist/gkd.json5';
const DIST_API = 'https://api.github.com/repos/Lin-arm/GKD_subscription/contents/dist';
const LIB_RE = /^gkd-\d+-selector-library\.json$/;

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'somnacare-ci',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gkd-'));
  const gkdPath = join(dir, 'gkd.json5');
  const gkd = await (await fetchOk(RAW_DIST)).text();
  writeFileSync(gkdPath, gkd);
  console.log(`gkd.json5 → ${(gkd.length / 1024).toFixed(0)}KB`);

  // 选择器库文件名带版本号（gkd-667-selector-library.json），从目录列表发现
  let libraryPath: string | undefined;
  try {
    const items = (await (await fetchOk(DIST_API)).json()) as Array<{ name?: string }>;
    const lib = Array.isArray(items) ? items.find((i) => LIB_RE.test(String(i?.name ?? ''))) : null;
    if (lib?.name) {
      libraryPath = join(dir, lib.name);
      const libJson = await (await fetchOk(`https://raw.githubusercontent.com/Lin-arm/GKD_subscription/main/dist/${lib.name}`)).text();
      writeFileSync(libraryPath, libJson);
      console.log(`${lib.name} → ${(libJson.length / 1024).toFixed(0)}KB`);
    }
  } catch (e) {
    console.warn('选择器库发现失败，只用主 dist 重建:', e instanceof Error ? e.message : e);
  }

  runImport(gkdPath, libraryPath);
}

main().catch((e) => {
  console.error('规则刷新失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
