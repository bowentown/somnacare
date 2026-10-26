/**
 * APK 更新检查（第 61 轮）：只在用户点「检查更新」时联网。
 *
 * 边界：
 *  - 100% 离线优先：启动/前台恢复都不自动请求 GitHub；
 *  - 只读公开 Release API，不需要 token，也不上传任何本机数据；
 *  - 版本比较以 tag 的语义化版本为准；安装前由原生侧再校验
 *    包名 / 版本号 / 签名证书 /（可选）SHA-256，任何一项不符都拒绝调起安装器；
 *  - Web/PWA 只展示 Release 信息，不提供 APK 安装入口。
 */
import { isNativePlatform } from './nativeAlarmScheduler';

export const UPDATE_REPO = 'bowentown/somnacare';
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  /** GitHub Release API 的 digest（形如 sha256:...）；旧资产可能没有 */
  sha256: string | null;
}

export interface LatestRelease {
  tag: string;
  version: string;
  publishedAt: string;
  notes: string;
  htmlUrl: string;
  asset: UpdateAsset | null;
}

export interface InstalledVersion {
  native: boolean;
  versionName: string;
  versionCode: number;
  packageName: string;
}

export type DownloadPhase =
  | 'missing'
  | 'pending'
  | 'running'
  | 'paused'
  | 'successful'
  | 'ready'
  | 'installing'
  | 'failed'
  /** 已装过的旧包（versionCode ≤ 当前），原生侧已清理文件与记录 */
  | 'stale';

export interface DownloadStatus {
  downloadId: number;
  status: DownloadPhase;
  bytesDownloaded: number;
  totalBytes: number;
  reason?: string;
  /** paused 时的机器可读原因：wifi=等待 Wi-Fi（可改用流量）network=无网 retry=稍后重试 */
  pausedReason?: 'wifi' | 'network' | 'retry';
  versionName?: string;
  versionCode?: number;
}

function plugin(): any {
  if (!isNativePlatform()) return null;
  try {
    return (window as any).Capacitor?.Plugins?.GemmaLLM ?? null;
  } catch {
    return null;
  }
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeStatus(raw: any): DownloadStatus {
  const status = typeof raw?.status === 'string' ? raw.status : 'missing';
  const pausedReason = raw?.pausedReason;
  return {
    downloadId: toInt(raw?.downloadId),
    status: status as DownloadPhase,
    bytesDownloaded: toInt(raw?.bytesDownloaded),
    totalBytes: toInt(raw?.totalBytes),
    ...(typeof raw?.reason === 'string' && raw.reason ? { reason: raw.reason } : {}),
    ...(pausedReason === 'wifi' || pausedReason === 'network' || pausedReason === 'retry'
      ? { pausedReason }
      : {}),
    ...(typeof raw?.versionName === 'string' ? { versionName: raw.versionName } : {}),
    ...(typeof raw?.versionCode === 'number' ? { versionCode: raw.versionCode } : {}),
  };
}

/** 解析 v1.2.3 / 1.2.3-beta.1 这类版本；解析不了返回 null。 */
export function parseSemver(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 返回 latest 相对 current 的新旧：>0 更新，0 相同，<0 更旧；无法比较返回 null。 */
export function compareVersions(latest: string, current: string): number | null {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  // 主版本号相同时按 semver 预发布规则比较：无 prerelease > 有 prerelease
  // （此前 1.2.3-beta.1 会被判成与 1.2.3 相同，测试版永远收不到更新提示）
  const preA = prereleaseOf(latest);
  const preB = prereleaseOf(current);
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const as = preA.split('.');
  const bs = preB.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function prereleaseOf(value: string): string | null {
  const m = /^v?\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(value.trim());
  return m ? m[1] : null;
}


/** Release 正文是 Markdown；这里只做去掉标记的纯文本化（UI 用 textContent 渲染）。 */
export function plainReleaseNotes(body: unknown): string {
  if (typeof body !== 'string') return '';
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickApkAsset(assets: any[]): UpdateAsset | null {
  const candidates = assets.filter(
    (a) => typeof a?.name === 'string'
      && /\.apk$/i.test(a.name)
      && !/debug/i.test(a.name)
      && typeof a?.browser_download_url === 'string'
  );
  // 优先项目固定命名的 SomnaCare-*.apk，避免误选其它架构/调试资产
  const chosen = candidates.find((a) => /^SomnaCare[-_.]/i.test(a.name)) ?? candidates[0];
  if (!chosen) return null;
  const digest = typeof chosen.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(chosen.digest)
    ? chosen.digest.slice(7).toLowerCase()
    : null;
  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    size: toInt(chosen.size),
    sha256: digest,
  };
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<LatestRelease> {
  const res = await fetch(RELEASES_API, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
    signal,
  });
  if (!res.ok) {
    throw new Error(res.status === 404 ? '还没有发布过 APK' : `GitHub 返回 ${res.status}`);
  }
  const data = await res.json();
  const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
  if (!tag) throw new Error('Release 缺少版本标签');
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    publishedAt: typeof data?.published_at === 'string' ? data.published_at : '',
    notes: plainReleaseNotes(data?.body),
    htmlUrl: typeof data?.html_url === 'string' ? data.html_url : RELEASES_PAGE,
    asset: pickApkAsset(Array.isArray(data?.assets) ? data.assets : []),
  };
}

/** 当前安装包版本（APK）。Web 环境返回 native:false。 */
export async function getInstalledVersion(): Promise<InstalledVersion> {
  const pl = plugin();
  const fallback: InstalledVersion = {
    native: !!pl,
    versionName: pl ? '未知' : '网页版',
    versionCode: 0,
    packageName: '',
  };
  if (!pl?.appUpdateVersion) return fallback;
  try {
    const res = await pl.appUpdateVersion();
    return {
      native: true,
      versionName: typeof res?.versionName === 'string' && res.versionName ? res.versionName : '未知',
      versionCode: toInt(res?.versionCode),
      packageName: typeof res?.packageName === 'string' ? res.packageName : '',
    };
  } catch {
    return fallback;
  }
}

export async function canInstallPackages(): Promise<boolean> {
  const pl = plugin();
  if (!pl?.appUpdateCanInstall) return false;
  try {
    const res = await pl.appUpdateCanInstall();
    return res?.allowed === true;
  } catch {
    return false;
  }
}

export async function openUnknownSourcesSettings(): Promise<void> {
  const pl = plugin();
  if (!pl?.appUpdateOpenUnknownSources) return;
  try {
    await pl.appUpdateOpenUnknownSources();
  } catch {
    /* 打不开时 UI 提示手动前往 */
  }
}

export async function openReleasePage(url: string): Promise<void> {
  const pl = plugin();
  if (pl?.appUpdateOpenRelease) {
    try {
      await pl.appUpdateOpenRelease({ url });
      return;
    } catch {
      /* 原生打开失败时退回 WebView 新窗口 */
    }
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* 浏览器拦截弹窗时忽略 */
  }
}

export interface StartDownloadResult {
  ok: boolean;
  downloadId?: number;
  reason?: string;
}

export async function startUpdateDownload(
  asset: UpdateAsset,
  opts?: { allowMetered?: boolean },
): Promise<StartDownloadResult> {
  const pl = plugin();
  if (!pl?.appUpdateDownload) return { ok: false, reason: '当前环境不支持安装 APK' };
  try {
    const res = await pl.appUpdateDownload({
      url: asset.url,
      sha256: asset.sha256 ?? '',
      // 默认仅 Wi-Fi：APK 通常 60-100MB，移动流量需用户在卡上显式选择
      allowMetered: opts?.allowMetered === true,
    });
    const downloadId = toInt(res?.downloadId);
    if (res?.ok === true && downloadId > 0) return { ok: true, downloadId };
    return { ok: false, reason: typeof res?.reason === 'string' ? res.reason : '无法开始下载' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '无法开始下载' };
  }
}

export async function getDownloadStatus(downloadId: number): Promise<DownloadStatus> {
  const pl = plugin();
  if (!pl?.appUpdateDownloadStatus) {
    return { downloadId, status: 'missing', bytesDownloaded: 0, totalBytes: 0 };
  }
  try {
    return normalizeStatus(await pl.appUpdateDownloadStatus({ downloadId }));
  } catch {
    return { downloadId, status: 'missing', bytesDownloaded: 0, totalBytes: 0 };
  }
}

/** 读取上一次未完成的下载（进程被杀后重开仍能续上安装）。 */
export async function getPendingUpdate(): Promise<DownloadStatus | null> {
  const pl = plugin();
  if (!pl?.appUpdatePending) return null;
  try {
    const res = await pl.appUpdatePending();
    if (res?.found !== true) return null;
    return normalizeStatus(res);
  } catch {
    return null;
  }
}

export interface InstallResult {
  installing: boolean;
  needPermission: boolean;
  reason?: string;
}

export async function installUpdate(downloadId: number): Promise<InstallResult> {
  const pl = plugin();
  if (!pl?.appUpdateInstall) return { installing: false, needPermission: false, reason: '当前环境不支持安装 APK' };
  try {
    const res = await pl.appUpdateInstall({ downloadId });
    return {
      installing: res?.installing === true,
      needPermission: res?.needPermission === true,
      ...(typeof res?.reason === 'string' && res.reason ? { reason: res.reason } : {}),
    };
  } catch (e) {
    return {
      installing: false,
      needPermission: false,
      reason: e instanceof Error ? e.message : '安装失败',
    };
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
}
