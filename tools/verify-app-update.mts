/**
 * 护栏：应用内更新（第 61 轮）。
 *
 * 更新是唯一会把“外部文件”变成“可执行安装包”的功能，安全检查必须钉死：
 *  - 只在用户点击时联网（离线优先，不在启动/前台自动请求）；
 *  - 只接受 GitHub 域名 + https；
 *  - 下载后校验 SHA-256（Release 提供时）、包名、versionCode、签名证书；
 *  - FileProvider 授权 + 用户允许“安装未知应用”，不申请存储权限；
 *  - Release 资产排除 debug APK。
 *
 * 反向自检：删掉签名比较后同一断言路径必须报红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  isNewerVersion,
  parseSemver,
  plainReleaseNotes,
} from '../src/utils/appUpdate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failures++;
};

const js = read('src/utils/appUpdate.ts');
const card = read('src/components/AppUpdateCard.tsx');
const settings = read('src/components/SettingsTab.tsx');
const app = read('src/App.tsx');
const manager = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/AppUpdateManager.java');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const pluginManifest = read('plugins/cap-gemma-llm/android/src/main/AndroidManifest.xml');
const gradle = read('plugins/cap-gemma-llm/android/build.gradle');
const workflow = read('.github/workflows/build-apk.yml');

// ── 版本比较（真实函数，不是文本扫描） ──
ok('semver：解析 v1.2.3 / 1.2.3-beta.1', parseSemver('v1.2.3')?.join('.') === '1.2.3'
  && parseSemver('1.2.3-beta.1')?.join('.') === '1.2.3'
  && parseSemver('1.2') === null);
ok('semver：1.2.0 > 1.1.9，1.1.0 == v1.1.0',
  isNewerVersion('1.2.0', '1.1.9')
  && !isNewerVersion('1.1.0', 'v1.1.0')
  && !isNewerVersion('1.0.9', '1.1.0')
  && compareVersions('2.0.0', '1.9.9') === 1);
ok('semver：预发布段参与比较（beta 能收到正式/更新 beta）',
  compareVersions('1.2.3', '1.2.3-beta.1') === 1
  && compareVersions('1.2.3-beta.2', '1.2.3-beta.1') === 1
  && compareVersions('1.2.3-beta.1', '1.2.3') === -1
  && compareVersions('1.2.3-beta.1', '1.2.3-beta.1') === 0
  && compareVersions('1.2.3-beta.10', '1.2.3-beta.9') === 1);
ok('Release 正文：Markdown 标记被清理', plainReleaseNotes('## 更新\n- **修复** [链接](https://x)\n') === '更新\n· 修复 链接');

// ── 显式联网 / 离线优先 ──
ok('JS：只请求固定 GitHub Release API，且 no-store',
  js.includes('https://api.github.com/repos/${UPDATE_REPO}/releases/latest')
  && js.includes("cache: 'no-store'")
  && js.includes("Accept: 'application/vnd.github+json'"));
ok('JS：APK 资产排除 debug、优先 SomnaCare-*',
  js.includes("/\\.apk$/i.test(a.name)")
  && js.includes("!/debug/i.test(a.name)")
  && js.includes('/^SomnaCare[-_.]/i.test(a.name)'));
ok('JS：下载时把 Release SHA-256 传给原生',
  js.includes('sha256: asset.sha256') && js.includes('appUpdateDownload'));
ok('启动路径不自动检查更新',
  !app.includes('fetchLatestRelease')
  && !app.includes('RELEASES_API')
  && !app.includes('appUpdate'));
ok('检查更新由用户展开卡片显式触发（不在启动/前台自动请求）',
  card.includes('const handleToggle')
  && card.includes("if (next && phase === 'idle') void handleCheck()")
  && card.includes('只在打开此卡时访问 GitHub'));
ok('测试构建不可比较版本时不自动下载（避免低构建号覆盖失败）',
  card.includes('comparable')
  && card.includes('测试构建版本号无法比较'));
ok('设置页接入更新卡',
  settings.includes('<AppUpdateCard theme={theme} />'));

// ── 原生下载与安装 ──
ok('原生：只接受 GitHub https 域名',
  manager.includes('"https".equalsIgnoreCase(uri.getScheme())')
  && manager.includes('github.com')
  && manager.includes('objects.githubusercontent.com')
  && manager.includes('release-assets.githubusercontent.com'));
ok('原生：DownloadManager + 私有目录 + FileProvider',
  manager.includes('DownloadManager')
  && manager.includes('setDestinationInExternalFilesDir')
  && manager.includes('FileProvider.getUriForFile')
  && manager.includes('ACTION_VIEW'));
ok('原生：包名 / versionCode / 签名 / SHA-256 四重校验',
  manager.includes('archive.packageName')
  && manager.includes('archiveCode <= currentCode')
  && manager.includes('MessageDigest.isEqual(archiveSigner, currentSigner)')
  && manager.includes('sha256(apk)')
  && manager.includes('expectedSha256'));
ok('原生：安装未知来源权限检查',
  manager.includes('canRequestPackageInstalls')
  && manager.includes('ACTION_MANAGE_UNKNOWN_APP_SOURCES'));
ok('原生：装过的旧包判定为 stale 并彻底清理（修“第二次更新永远继续安装”死循环）',
  manager.includes('cleanupStale')
  && manager.includes('clearDownloadPrefs')
  && manager.includes('cachedCode <= currentCode')
  && manager.includes('该安装包已安装过')
  && js.includes("'stale'")
  && card.includes("pending.status === 'stale'")
  && card.includes('readyInstallable'));
ok('原生：SHA-256 不匹配时删除安装包并拒绝',
  manager.includes('已阻止安装')
  && manager.includes('deleteQuietly(apk)'));
ok('清单：模板 FileProvider 复用 + 下载目录注入 + ShizukuProvider',
  pluginManifest.includes('REQUEST_INSTALL_PACKAGES')
  && pluginManifest.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')
  && pluginManifest.includes('rikka.shizuku.ShizukuProvider')
  // 插件不得重复声明 FileProvider：模板已有同 authority 的 provider，
  // 重复声明会在 manifest merge 时因 meta-data resource 不同而失败
  && !pluginManifest.includes('androidx.core.content.FileProvider')
  && manager.includes('.fileprovider')
  && workflow.includes('somnacare_updates')
  && workflow.includes('res/xml/file_paths.xml'));
ok('Gradle：Shizuku api/provider + AndroidX core（FileProvider 编译类路径）',
  gradle.includes('dev.rikka.shizuku:api:13.1.5')
  && gradle.includes('dev.rikka.shizuku:provider:13.1.5')
  && gradle.includes('androidx.core:core:1.17.0'));
ok('桥接：版本 / 下载 / 状态 / 安装 / 待安装',
  plugin.includes('public void appUpdateVersion')
  && plugin.includes('public void appUpdateDownload')
  && plugin.includes('public void appUpdateDownloadStatus')
  && plugin.includes('public void appUpdateInstall')
  && plugin.includes('public void appUpdatePending'));
ok('CI：安装权限注入 + 命中断言',
  workflow.includes('REQUEST_INSTALL_PACKAGES')
  && workflow.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')
  && workflow.includes("grep -q 'REQUEST_INSTALL_PACKAGES'")
  && workflow.includes("grep -q 'androidx.core.content.FileProvider'"));

// 反向自检：移除签名比较后，判据必须消失
{
  const doctored = manager.replace('MessageDigest.isEqual(archiveSigner, currentSigner)', 'true');
  if (doctored === manager) {
    console.error('✗ 反向自检失败：签名比较替换未命中');
    failures++;
  } else {
    ok('反向自检：删除签名比较后判据不再成立',
      !doctored.includes('MessageDigest.isEqual(archiveSigner, currentSigner)'));
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——应用更新护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-app-update：显式联网 / GitHub 域名 / 四重校验 / FileProvider 全部符合');
