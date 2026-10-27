import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Share2, Loader2, Stethoscope } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { SleepRecord } from '../types/sleep';
import { renderClinicalSummary } from '../utils/clinicalSummaryCard';
import { useModalA11y } from '../utils/modalA11y';
import { setPetOverlayVisible } from '../utils/petOverlay';
import { tapTick } from '../utils/haptics';
import { nativePlugin } from '../utils/nativeBridge';

interface Props {
  open: boolean;
  onClose: () => void;
  records: SleepRecord[];
  theme: ThemeConfig;
}

/**
 * 就诊摘要（第 56 轮）：Canvas 生成 → 预览 → 可选包含具体时刻 →
 * 原生分享 / Web 下载。默认不含具体时刻，避免随手转发时泄漏作息指纹。
 */
export const ClinicalSummaryModal: React.FC<Props> = ({ open, onClose, records, theme }) => {
  const a11y = useModalA11y(open, onClose, '就诊摘要');
  // 原生桌宠是系统悬浮窗，会压在 WebView 弹窗上方；打开摘要时临时收起，
  // 关闭后恢复（不改变桌宠开关）。Web/PWA 下该桥接为空操作。
  useEffect(() => {
    if (!open) return;
    void setPetOverlayVisible(false);
    return () => { void setPetOverlayVisible(true); };
  }, [open]);

  useEffect(() => {
    if (!open) setZoomed(false);
  }, [open]);
  const [includeTimes, setIncludeTimes] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const out = await renderClinicalSummary({ records, includeTimes, theme });
        if (cancelled) return;
        const url = URL.createObjectURL(out.blob);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setPreview(url);
      } catch (e) {
        if (!cancelled) setNote(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, includeTimes, records, theme]);

  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
  }, []);

  const handleExport = async () => {
    tapTick();
    setBusy(true);
    try {
      const out = await renderClinicalSummary({ records, includeTimes, theme });
      const fs = nativePlugin('Filesystem');
      const share = nativePlugin('Share');
      if (fs && share) {
        const b64 = out.dataUrl.split(',')[1];
        const name = `somnacare-clinical-summary-${Date.now()}.jpg`;
        const res = await fs.writeFile({
          path: name, data: b64, directory: 'DOCUMENTS', recursive: true,
        });
        if (!res?.uri) throw new Error('文件写入失败');
        await share.share({
          title: '睡眠就诊摘要', url: res.uri, dialogTitle: '保存或发送就诊摘要',
        });
      } else {
        const url = URL.createObjectURL(out.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `somnacare-clinical-summary-${out.rangeLabel.replace(/\s/g, '')}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
      setNote(null);
    } catch (e) {
      setNote('导出失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={a11y.ref}
      {...a11y.dialogProps}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-fadeIn"
    >
      <div className="w-full max-w-sm bg-gradient-to-b from-[#0f172a] to-[#020617] border border-[#1e293b] rounded-3xl p-5 shadow-2xl space-y-4 max-h-[92dvh] overflow-y-auto no-scrollbar">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Stethoscope className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-black text-white">就诊摘要</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭就诊摘要预览"
            className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 text-slate-300 hover:text-white flex items-center justify-center cursor-pointer active:scale-90 transition-transform"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-2xl overflow-hidden border border-slate-700/60 bg-black/40 flex items-center justify-center min-h-[280px]">
          {busy && !preview ? (
            <div className="flex items-center gap-2 text-slate-400 text-xs py-10">
              <Loader2 className="w-4 h-4 animate-spin" /> 正在绘制…
            </div>
          ) : preview ? (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              aria-label="放大查看就诊摘要"
              className="w-full cursor-zoom-in"
            >
              <img src={preview} alt="就诊摘要预览" className="w-full" />
            </button>
          ) : (
            <div className="text-slate-400 text-xs py-10 px-6 text-center">{note ?? '暂无可生成的内容'}</div>
          )}
        </div>
        {preview && (
          <p className="text-[9px] text-slate-400 text-center -mt-2">点按预览可放大查看</p>
        )}

        <button
          type="button"
          onClick={() => setIncludeTimes((v) => !v)}
          aria-pressed={includeTimes}
          className="flex items-center gap-2.5 cursor-pointer py-2.5 -my-2.5"
        >
          <span className={`relative w-10 h-5 rounded-full transition-colors ${includeTimes ? 'bg-sky-500' : 'bg-slate-600'}`}>
            <span
              className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
              style={{ left: includeTimes ? '22px' : '2px' }}
            />
          </span>
          <span className="text-[11px] font-bold text-slate-200">包含具体时刻</span>
        </button>
        <p className="text-[10px] text-slate-400 leading-relaxed -mt-1">不含梦境、心情与习惯记录</p>

        {note && <p className="text-[11px] text-rose-300 font-bold">{note}</p>}

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={busy || !preview}
          style={{ background: theme.accentHex }}
          className="w-full py-3 rounded-2xl text-[#0b1026] text-xs font-black shadow-lg active:scale-95 transition-transform cursor-pointer disabled:opacity-40 flex items-center justify-center gap-1.5"
        >
          <Share2 className="w-4 h-4" />
          {busy ? '处理中…' : '保存 / 分享'}
        </button>
      </div>

      {zoomed && preview && (
        <div
          className="fixed inset-0 z-[120] bg-black/95 overflow-auto"
          role="dialog"
          aria-label="就诊摘要大图"
          onClick={() => setZoomed(false)}
        >
          <img
            src={preview}
            alt="就诊摘要大图"
            draggable={false}
            className="w-[720px] max-w-none mx-auto my-6"
          />
          <p className="text-center text-slate-400 text-xs pb-6">点按任意处关闭</p>
        </div>
      )}
    </div>,
    document.body,
  );
};
