import React, { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { getCurrentTheme, useProfileStore } from '../store/profileStore';
import { useModalA11y } from '../utils/modalA11y';

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除/清空/覆盖不可恢复），确认按钮使用高对比警示色 */
  danger?: boolean;
}

export interface AlertDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
}

export interface DialogRequestSnapshot {
  readonly id: number;
  readonly mode: 'confirm' | 'alert';
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly cancelText: string;
  readonly danger: boolean;
}

interface InternalDialogEntry extends DialogRequestSnapshot {
  resolve: (confirmed: boolean) => void;
}

const listeners = new Set<() => void>();
const queue: InternalDialogEntry[] = [];
let nextDialogId = 1;
let activeSnapshot: DialogRequestSnapshot | null = null;

function notify(): void {
  const head = queue[0] ?? null;
  activeSnapshot = head
    ? {
        id: head.id,
        mode: head.mode,
        title: head.title,
        message: head.message,
        confirmText: head.confirmText,
        cancelText: head.cancelText,
        danger: head.danger,
      }
    : null;
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveDialogSnapshot(): DialogRequestSnapshot | null {
  return activeSnapshot;
}

function resolveDialogById(id: number, confirmed: boolean): void {
  const head = queue[0];
  if (!head || head.id !== id) return;
  queue.shift();
  notify();
  head.resolve(confirmed);
}

/**
 * 主题化夜间确认弹窗（替代浏览器原生白色 window.confirm）：
 * 内部采用 FIFO 队列，并发调用按序排队展示，绝不互相覆盖或悬空 Promise。
 */
export function confirmDialog(input: string | ConfirmDialogOptions): Promise<boolean> {
  const opts: ConfirmDialogOptions = typeof input === 'string' ? { message: input } : input;
  return new Promise<boolean>((resolve) => {
    queue.push({
      id: nextDialogId++,
      mode: 'confirm',
      title: opts.title?.trim() || '请确认',
      message: opts.message,
      confirmText: opts.confirmText?.trim() || '确定',
      cancelText: opts.cancelText?.trim() || '取消',
      danger: opts.danger === true,
      resolve,
    });
    notify();
  });
}

/**
 * 主题化夜间提示弹窗（替代浏览器原生白色 window.alert）：
 * 与 confirmDialog 共用同一 FIFO 队列，点击确认 / ESC / 遮罩均会安全 resolve。
 */
export function alertDialog(input: string | AlertDialogOptions): Promise<void> {
  const opts: AlertDialogOptions = typeof input === 'string' ? { message: input } : input;
  return new Promise<void>((resolve) => {
    queue.push({
      id: nextDialogId++,
      mode: 'alert',
      title: opts.title?.trim() || '提示',
      message: opts.message,
      confirmText: opts.confirmText?.trim() || '知道了',
      cancelText: '',
      danger: false,
      resolve: () => resolve(),
    });
    notify();
  });
}

/** 仅供单元测试驱动当前栈顶弹窗响应 */
export function resolveActiveDialogForTest(confirmed: boolean): boolean {
  const head = queue[0];
  if (!head) return false;
  resolveDialogById(head.id, confirmed);
  return true;
}

/** 仅供单元测试重置弹窗队列，避免跨用例污染 */
export function resetDialogQueueForTest(): void {
  while (queue.length > 0) {
    const item = queue.shift();
    item?.resolve(false);
  }
  notify();
}

/**
 * 全局夜间主题弹窗宿主（挂载于 AppOverlays）：
 * 完整适配四套夜间主题、role="alertdialog"、ESC/Android 返回键/遮罩关闭、危险操作视觉区分。
 */
export const ConfirmDialogHost: React.FC = () => {
  const active = useSyncExternalStore(subscribe, getActiveDialogSnapshot, getActiveDialogSnapshot);
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);

  const handleDismiss = () => {
    if (!active) return;
    resolveDialogById(active.id, false);
  };

  const a11y = useModalA11y(!!active, handleDismiss, active?.title ?? '提示');
  const activeId = active?.id ?? 0;

  // 队列连续切到下一条弹窗时（!!active 维持 true），强制将焦点重置到新弹窗容器：
  // 防止上一条的按钮卸载后焦点掉回 body，或焦点停留在下一条危险确认按钮上造成误回车确认
  useEffect(() => {
    if (!activeId) return;
    a11y.ref.current?.focus({ preventScroll: true });
  }, [activeId, a11y.ref]);

  if (!active || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={a11y.ref}
      {...a11y.dialogProps}
      role="alertdialog"
      aria-describedby="confirm-dialog-desc"
      onClick={handleDismiss}
      className="fixed inset-0 z-[400] bg-black/75 flex items-center justify-center p-5 animate-fadeIn"
    >
      <div
        role="presentation"
        data-no-swipe
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-3xl p-5 border shadow-2xl space-y-4 ${theme.cardBg} ${theme.cardBorder} ${theme.textPrimary}`}
      >
        <div className="flex items-start gap-3">
          <div
            className={
              active.danger
                ? 'w-10 h-10 rounded-2xl bg-rose-500/15 border border-rose-400/40 text-rose-300 flex items-center justify-center shrink-0'
                : `w-10 h-10 rounded-2xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.accentText} flex items-center justify-center shrink-0`
            }
            aria-hidden="true"
          >
            {active.danger ? <AlertTriangle className="w-5 h-5" /> : <Info className="w-5 h-5" />}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
            <h3 className={`text-base font-black tracking-wide ${theme.textPrimary}`}>
              {active.title}
            </h3>
            <p
              id="confirm-dialog-desc"
              className={`text-xs leading-relaxed whitespace-pre-line break-words ${theme.textSecondary}`}
            >
              {active.message}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 pt-1">
          {active.mode === 'confirm' && (
            <button
              key={`${active.id}-cancel`}
              type="button"
              onClick={() => resolveDialogById(active.id, false)}
              className={`flex-1 py-2.5 px-4 rounded-xl ${theme.cardInnerBg} border ${theme.cardBorder} ${theme.textSecondary} hover:text-white text-xs font-bold active:scale-95 transition-all cursor-pointer focus-visible:outline-none ${theme.focusRing}`}
            >
              {active.cancelText}
            </button>
          )}
          <button
            key={`${active.id}-confirm`}
            type="button"
            onClick={() => resolveDialogById(active.id, true)}
            className={
              active.danger
                ? 'flex-1 py-2.5 px-4 rounded-xl bg-rose-800 hover:bg-[#be123c] text-white border border-rose-400/40 text-xs font-black shadow-lg active:scale-95 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300'
                : `flex-1 py-2.5 px-4 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-black shadow-lg active:scale-95 transition-all cursor-pointer focus-visible:outline-none ${theme.focusRing}`
            }
          >
            {active.confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
