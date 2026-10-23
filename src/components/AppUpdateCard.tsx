import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  DownloadCloud,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';
import { tapTick } from '../utils/haptics';
import {
  canInstallPackages,
  compareVersions,
  fetchLatestRelease,
  formatBytes,
  getDownloadStatus,
  getInstalledVersion,
  getPendingUpdate,
  installUpdate,
  openReleasePage,
  openUnknownSourcesSettings,
  startUpdateDownload,
  type DownloadStatus,
  type InstalledVersion,
  type LatestRelease,
} from '../utils/appUpdate';

interface Props {
  theme: ThemeConfig;
}

type Phase = 'idle' | 'checking' | 'latest' | 'available' | 'error';

const ACTIVE_DOWNLOAD: DownloadStatus['status'][] = ['pending', 'running', 'paused', 'successful'];

/**
 * 应用更新卡（第 61 轮，第 63 轮折叠化）。
 *
 * 默认收起，只占一行；点开时才请求 GitHub（用户显式动作）。
 * 安装链路的安全边界在原生侧：包名、versionCode、签名证书、SHA-256
 * 全部通过后才调起系统安装器。
 */
export const AppUpdateCard: React.FC<Props> = ({ theme }) => {
  const native = isNativePlatform();
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<InstalledVersion | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [download, setDownload] = useState<DownloadStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparable, setComparable] = useState(true);
  const installBusy = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const v = await getInstalledVersion();
      if (!alive) return;
      setInstalled(v);
      if (!native) return;
      const pending = await getPendingUpdate();
      if (!alive || !pending) return;
      // stale = 原生侧判定“这个包已经装过”并清理了文件与记录——绝不能再当
      // 待安装展示（第 72 轮实锤：装完 v(n) 后 pending 残留，UI 永远显示
      // “继续安装”指向旧包，install 又被构建号检查拒绝，卡死循环）
      if (pending.status === 'stale') {
        setMessage('之前下载的安装包已经装过，已清理；重新检查后可下载新版');
        return;
      }
      if (pending.status === 'ready') {
        if (v.native && pending.versionCode && pending.versionCode <= v.versionCode) {
          setMessage('之前下载的安装包已经装过，请重新检查下载新版');
          return;
        }
        setDownload(pending);
        setMessage(`已下载${pending.versionName ? ` v${pending.versionName}` : '更新包'}，等待安装`);
      } else if (ACTIVE_DOWNLOAD.includes(pending.status)) {
        setDownload(pending);
      }
    })();
    return () => { alive = false; };
  }, [native]);

  const handleInstall = useCallback(async (downloadId: number) => {
    if (installBusy.current) return;
    installBusy.current = true;
    try {
      const allowed = await canInstallPackages();
      if (!allowed) {
        await openUnknownSourcesSettings();
        setMessage('请先允许「安装未知应用」，返回后点「继续安装」');
        return;
      }
      const res = await installUpdate(downloadId);
      if (res.installing) {
        setDownload((prev) => (prev ? { ...prev, status: 'installing' } : prev));
        setMessage('安装包校验通过，已打开系统安装器');
      } else if (res.needPermission) {
        await openUnknownSourcesSettings();
        setMessage('请先允许「安装未知应用」，返回后点「继续安装」');
      } else {
        setMessage(res.reason ?? '安装没有启动，请重试');
      }
    } finally {
      installBusy.current = false;
    }
  }, []);

  const activeDownload = !!download && ACTIVE_DOWNLOAD.includes(download.status);

  useEffect(() => {
    if (!download || !activeDownload) return;
    let cancelled = false;
    const tick = async () => {
      const st = await getDownloadStatus(download.downloadId);
      if (cancelled) return;
      if (st.status === 'stale') {
        // 原生侧判定包已装过并清理——清空本地状态，别再显示“继续安装”
        setDownload(null);
        setMessage('之前下载的安装包已经装过，已清理；点「重新检查」下载新版');
        return;
      }
      setDownload(st);
      if (st.status === 'ready') {
        if (!installed || (st.versionCode && st.versionCode <= installed.versionCode)) {
          setDownload(null);
          setMessage('之前下载的安装包已经装过，已清理；点「重新检查」下载新版');
          return;
        }
        void handleInstall(st.downloadId);
      } else if (st.status === 'failed') {
        setMessage(st.reason ?? '下载失败，请重试');
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // download.downloadId 决定轮询对象；status 变化不需要重建定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [download?.downloadId, activeDownload, handleInstall]);

  const handleCheck = async () => {
    if (busy) return;
    tapTick();
    setOpen(true);
    setBusy(true);
    setPhase('checking');
    setError(null);
    setMessage(null);
    try {
      const [version, latest] = await Promise.all([getInstalledVersion(), fetchLatestRelease()]);
      setInstalled(version);
      setRelease(latest);
      if (latest.asset === null) {
        setComparable(true);
        setPhase('available');
        return;
      }
      const cmp = compareVersions(latest.version, version.versionName);
      setComparable(cmp !== null);
      setPhase(cmp !== null && cmp <= 0 ? 'latest' : 'available');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : '检查更新失败');
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && phase === 'idle') void handleCheck();
  };

  const handleDownload = async () => {
    if (!release?.asset || busy) return;
    tapTick();
    setBusy(true);
    setMessage(null);
    try {
      if (native && !(await canInstallPackages())) {
        await openUnknownSourcesSettings();
        setMessage('请先允许「安装未知应用」，返回后再点下载');
        return;
      }
      const started = await startUpdateDownload(release.asset);
      if (!started.ok || !started.downloadId) {
        setMessage(started.reason ?? '无法开始下载');
        return;
      }
      setDownload({
        downloadId: started.downloadId,
        status: 'pending',
        bytesDownloaded: 0,
        totalBytes: release.asset.size,
      });
    } finally {
      setBusy(false);
    }
  };

  const versionLabel = installed
    ? (installed.native ? `v${installed.versionName}` : '网页版')
    : '读取中…';
  const pct = download && download.totalBytes > 0
    ? Math.min(100, Math.round((download.bytesDownloaded / download.totalBytes) * 100))
    : null;
  const downloadBusy = !!download && ['pending', 'running', 'paused'].includes(download.status);
  // “继续安装”只对真正比当前新的包出现——旧包（已装过）一律走重新下载
  const readyInstallable = !!download && download.status === 'ready'
    && (!download.versionCode || !installed || download.versionCode > installed.versionCode);
  const readyToInstall = !!download
    && (download.status === 'installing' || (download.status === 'ready' && readyInstallable));
  const summary = downloadBusy
    ? `下载中 ${pct ?? 0}%`
    : readyToInstall
      ? '待安装'
      : phase === 'latest'
        ? `已是最新 ${release?.tag ?? ''}`
        : phase === 'available' && release
          ? `新版本 ${release.tag}`
          : `当前 ${versionLabel}`;

  return (
    <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl overflow-hidden`}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className={`w-full flex items-center gap-3 px-5 text-left cursor-pointer ${open ? 'py-4' : 'py-4'}`}
      >
        <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
          <RefreshCw className={`w-5 h-5 ${phase === 'checking' ? 'animate-spin' : ''}`} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-black text-white">应用更新</h3>
          <p className={`text-[10px] truncate ${phase === 'available' ? theme.accentText : 'text-slate-400'}`}>
            {summary}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-5 pb-5 pt-3 border-t border-slate-700/60 space-y-3">
          {phase === 'checking' && (
            <div className="flex items-center gap-2 text-[11px] text-slate-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在读取 GitHub Release…
            </div>
          )}

          {phase === 'idle' && (
            <button
              type="button"
              onClick={() => void handleCheck()}
              className={`w-full py-2.5 rounded-xl ${theme.accentBg} ${theme.accentFg} text-[11px] font-black shadow-md active:scale-[0.98] transition-transform cursor-pointer`}
            >
              检查更新
            </button>
          )}

          {phase === 'latest' && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-400/30 px-3 py-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <p className="text-[11px] font-bold text-emerald-200">
                已是最新版本{release ? `（${release.tag}）` : ''}
              </p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-400/30 px-3 py-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-rose-200 leading-relaxed">
                {error ?? '检查失败'}。稍后再试，或直接前往 Release 页面。
              </p>
            </div>
          )}

          {phase === 'available' && release && (
            <div className="space-y-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-black text-white">发现新版本 {release.tag}</p>
                <p className="text-[9px] font-mono text-slate-500 shrink-0">
                  {release.publishedAt ? release.publishedAt.slice(0, 10) : '未标注日期'}
                </p>
              </div>
              <p className="text-[10px] text-slate-400">
                {release.asset
                  ? `${formatBytes(release.asset.size)}${release.asset.sha256 ? ' · 已提供 SHA-256' : ''}`
                  : '这个 Release 还没有上传 APK'}
              </p>

              {release.notes && (
                <div>
                  <button
                    type="button"
                    onClick={() => setNotesOpen((v) => !v)}
                    aria-expanded={notesOpen}
                    className="text-[10px] font-bold text-slate-300 underline decoration-slate-600 underline-offset-2 cursor-pointer"
                  >
                    {notesOpen ? '收起更新说明' : '查看更新说明'}
                  </button>
                  {notesOpen && (
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-black/20 border border-slate-700/50 p-3 text-[10px] leading-relaxed text-slate-300 font-sans">
                      {release.notes.slice(0, 4000)}
                    </pre>
                  )}
                </div>
              )}

              {native && release.asset && !comparable && (
                <p className="rounded-xl bg-amber-500/10 border border-amber-400/30 px-3 py-2 text-[10px] text-amber-200 leading-relaxed">
                  测试构建版本号无法比较，请从 Release 页面手动确认。
                </p>
              )}

              {download && (downloadBusy || download.status === 'ready' || download.status === 'installing' || download.status === 'failed') && (
                <div className="rounded-xl bg-black/20 border border-slate-700/50 p-3 space-y-2">
                  {(downloadBusy || download.status === 'failed') && (
                    <>
                      <div className="flex items-center justify-between text-[10px] text-slate-300">
                        <span>{download.status === 'paused' ? '下载已暂停' : '正在下载'}</span>
                        <span className="font-mono text-slate-400">
                          {pct !== null ? `${pct}%` : formatBytes(download.bytesDownloaded)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-[width] duration-500"
                          style={{ width: `${pct ?? 8}%`, background: theme.accentHex }}
                        />
                      </div>
                    </>
                  )}
                  {download.status === 'ready' && (
                    <p className="text-[10px] font-bold text-emerald-300 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      下载完成，签名与版本校验通过
                    </p>
                  )}
                  {download.status === 'installing' && (
                    <p className="text-[10px] font-bold text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      已打开系统安装器
                    </p>
                  )}
                  {download.status === 'failed' && (
                    <p className="text-[10px] text-rose-300 leading-relaxed">{message ?? '下载失败，请重试'}</p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {native && release.asset && comparable && (
                  <button
                    type="button"
                    aria-label={readyToInstall ? '继续安装已下载的更新包' : '下载并安装新版本'}
                    onClick={() => {
                      if (readyToInstall) {
                        void handleInstall(download!.downloadId);
                      } else {
                        void handleDownload();
                      }
                    }}
                    disabled={busy || downloadBusy}
                    className={`flex-1 py-2.5 rounded-xl ${theme.accentBg} ${theme.accentFg} text-[11px] font-black shadow-md active:scale-[0.98] transition-transform cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5`}
                  >
                    {downloadBusy ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 下载中…</>
                    ) : readyToInstall ? (
                      <><DownloadCloud className="w-3.5 h-3.5" /> 继续安装</>
                    ) : (
                      <><DownloadCloud className="w-3.5 h-3.5" /> 下载并安装</>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void openReleasePage(release.htmlUrl)}
                  className={`${native && release.asset && comparable ? '' : 'flex-1'} px-3 py-2.5 rounded-xl bg-slate-800/80 border border-slate-600 text-slate-200 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Release 页面
                </button>
              </div>
            </div>
          )}

          {message && <p className="text-[10px] text-amber-300 leading-relaxed">{message}</p>}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] text-slate-500 leading-relaxed">
              只在打开此卡时访问 GitHub；安装前校验签名与版本。
            </p>
            {phase !== 'checking' && phase !== 'idle' && (
              <button
                type="button"
                onClick={() => void handleCheck()}
                disabled={busy}
                className="text-[10px] font-bold text-slate-300 shrink-0 cursor-pointer disabled:opacity-40"
              >
                重新检查
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
