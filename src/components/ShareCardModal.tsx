import React, { useEffect, useRef, useState } from 'react';
import { tapTick } from '../utils/haptics';
import { createPortal } from 'react-dom';
import { X, Share2, Download, Loader2 } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { SleepRecord } from '../types/sleep';
import { renderWeeklyCard } from '../utils/sleepShareCard';
import { useModalA11y } from '../utils/modalA11y';
import { setPetOverlayVisible } from '../utils/petOverlay';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';

interface Props {
  open: boolean;
  onClose: () => void;
  records: SleepRecord[];
  theme: ThemeConfig;
}

/** 每周睡眠分享卡：Canvas 生成 → 预览 → 可勾选内容 → 原生分享 / Web 下载。 */
export const ShareCardModal: React.FC<Props> = ({ open, onClose, records, theme }) => {
  const modalA11y = useModalA11y(open, onClose, '每周睡眠分享卡');
  const [showRegularity, setShowRegularity] = useState(true);
  const [showDuration, setShowDuration] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void setPetOverlayVisible(false);
    return () => { void setPetOverlayVisible(true); };
  }, [open]);

  // 生成（主题色/开关变化即重绘）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const pageBgHex = theme.pageBg.match(/#([0-9a-fA-F]{6})/)?.[0] ?? '#0B1026';
        const out = await renderWeeklyCard({
          records,
          accentHex: theme.accentHex,
          pageBgHex,
          showRegularity,
          showDuration,
        });
        if (cancelled) return;
        const url = URL.createObjectURL(out.blob);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setPreview(url);
      } catch (e) {
        if (!cancelled) setNote('卡片生成失败：' + (e instanceof Error ? e.message : String(e)));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, showRegularity, showDuration, records, theme]);

  useEffect(() => {
    return () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); };
  }, []);

  const handleShare = async () => {
    tapTick();
    setBusy(true);
    try {
      const pageBgHex = theme.pageBg.match(/#([0-9a-fA-F]{6})/)?.[0] ?? '#0B1026';
      const out = await renderWeeklyCard({
        records, accentHex: theme.accentHex, pageBgHex, showRegularity, showDuration,
      });
      const cap = (window as any).Capacitor;
      if (cap?.isNativePlatform?.()) {
        const pl = cap.Plugins;
        const b64 = out.dataUrl.split(',')[1];
        const name = `somnacare-week-card-${Date.now()}.jpg`;
        const res = await pl?.Filesystem?.writeFile({
          path: name, data: b64, directory: 'DOCUMENTS', recursive: true,
        });
        await pl?.Share?.share({ title: '我的每周睡眠卡', url: res.uri, dialogTitle: '分享睡眠卡' });
      } else {
        const url = URL.createObjectURL(out.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `somnacare-week-card.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
      setNote(null);
    } catch (e) {
      setNote('分享失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const Toggle = ({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) => (
    <button
      type="button"
      onClick={() => set(!on)}
      aria-pressed={on}
      className="flex items-center gap-2.5 cursor-pointer py-2.5 -my-2.5"
    >
      <span className={`relative w-10 h-5 rounded-full transition-colors ${on ? 'bg-sky-500' : 'bg-slate-600'}`}>
        <span
          className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
          style={{ left: on ? '22px' : '2px' }}
        />
      </span>
      <span className="text-[11px] font-bold text-slate-200">{label}</span>
    </button>
  );

  return createPortal(
    <div
      ref={modalA11y.ref}
      {...modalA11y.dialogProps}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-fadeIn"
      style={{ backgroundColor: 'rgba(2, 6, 23, 0.92)' }}
    >
      <div className="w-full max-w-sm bg-gradient-to-b from-[#0f172a] to-[#020617] border border-[#1e293b] rounded-3xl p-5 shadow-2xl space-y-4 max-h-[92dvh] overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Share2 className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-black text-white">每周睡眠分享卡</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭分享卡预览"
            className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 text-slate-300 hover:text-white flex items-center justify-center cursor-pointer active:scale-90 transition-transform"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 预览 */}
        <div className="rounded-2xl overflow-hidden border border-slate-700/60 bg-black/40 flex items-center justify-center min-h-[280px]">
          {busy && !preview ? (
            <div className="flex items-center gap-2 text-slate-400 text-xs py-10">
              <Loader2 className="w-4 h-4 animate-spin" /> 正在绘制卡片…
            </div>
          ) : preview ? (
            <img src={preview} alt="每周睡眠分享卡预览" className="w-full" />
          ) : (
            <div className="text-slate-400 text-xs py-10">{note ?? '暂无可生成的内容'}</div>
          )}
        </div>

        {/* 内容开关（隐私：默认只放聚合数字） */}
        <div className="flex items-center gap-5 px-1">
          <Toggle label="显示规律度" on={showRegularity} set={setShowRegularity} />
          <Toggle label="显示平均时长" on={showDuration} set={setShowDuration} />
        </div>
        <p className="text-[10px] text-slate-400 leading-relaxed -mt-1">
          卡片只包含聚合数字，不含具体就寝/起床时刻与梦境记录，可放心分享。
        </p>

        {note && <p className="text-[11px] text-rose-300 font-bold">{note}</p>}

        <button
          type="button"
          onClick={() => void handleShare()}
          disabled={busy || !preview}
          style={{ background: theme.accentHex }}
          className="w-full py-3 rounded-2xl text-[#0b1026] text-xs font-black shadow-lg active:scale-95 transition-transform cursor-pointer disabled:opacity-40"
        >
          {busy ? '处理中…' : '保存并分享这张卡'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-full py-2 text-slate-400 hover:text-slate-200 text-[11px] font-medium transition-colors cursor-pointer"
        >
          稍后再说
        </button>
      </div>
    </div>,
    document.body,
  );
};
