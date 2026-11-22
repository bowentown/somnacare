import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NavTab } from '../../shared/ui/BottomNavBar';
import { setActiveTab, uiStore } from '../../shared/store/uiStore';
import { hapticPage } from '../../shared/utils/haptics';
import { MOTION } from '../../shared/utils/motionTokens';
import { setGestureLive } from '../../shared/utils/gestureGate';

export const TAB_ORDER: readonly NavTab[] = ['today', 'trends', 'coach', 'eyecare', 'settings'];

const SNAP_MS = MOTION.snapMs;
const SWIPE_START = 6;
const DIR_BIAS = 1.1;
const COMMIT_RATIO = 0.15;
const FLICK_V = 0.26;
const VEL_WINDOW = 90;
const EDGE_DAMP = 0.3;

interface DragState {
  id: number;
  x0: number;
  y0: number;
  base: number;
  w: number;
  idx: number;
  locked: 'h' | 'y' | null;
  skip: boolean;
  samples: { t: number; x: number }[];
}

/**
 * 五分区跟手横向滑动轨道 + 懒挂载与开屏后空闲预热（从 App.tsx 抽离，保留第 130–132 轮全部手感物理参数）。
 */
export function useTabSwipe(activeTab: NavTab, hydrated: boolean) {
  const [mountedPanes, setMountedPanes] = useState<Set<NavTab>>(() => new Set<NavTab>(['today']));
  const trackRef = useRef<HTMLDivElement>(null);
  const lastSwipeAtRef = useRef(-Infinity);
  const idxRef = useRef(0);
  const snapMsRef = useRef(300);
  const paneWRef = useRef(0);
  const trackPosRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);

  const mountPane = useCallback((id: NavTab) => {
    setMountedPanes((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const preheatNeighbors = useCallback(
    (id: NavTab) => {
      const i = TAB_ORDER.indexOf(id);
      if (i > 0) mountPane(TAB_ORDER[i - 1]);
      if (i >= 0 && i < TAB_ORDER.length - 1) mountPane(TAB_ORDER[i + 1]);
    },
    [mountPane],
  );

  // 补水后挂载当前分区，并在开屏动画撤除后的空闲窗口预热相邻分区
  useEffect(() => {
    if (!hydrated) return;
    mountPane(activeTab);
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    const cancelRic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;

    const kickoff = (): (() => void) => {
      const idleId = ric ? ric(() => preheatNeighbors(activeTab), { timeout: 3000 }) : 0;
      const t = ric ? 0 : window.setTimeout(() => preheatNeighbors(activeTab), 300);
      return () => {
        if (ric && cancelRic) cancelRic(idleId);
        if (t) window.clearTimeout(t);
      };
    };

    const waitMs = Math.max(0, MOTION.splashMinMs + MOTION.splashFadeMs - performance.now());
    let cancelInner: (() => void) | null = null;
    let outer = 0;
    if (waitMs > 0) {
      outer = window.setTimeout(() => {
        cancelInner = kickoff();
      }, waitMs);
    } else {
      cancelInner = kickoff();
    }
    return () => {
      if (outer) window.clearTimeout(outer);
      cancelInner?.();
    };
  }, [activeTab, hydrated, mountPane, preheatNeighbors]);

  const applyTrack = (px: number, animate: boolean, ms = SNAP_MS) => {
    const el = trackRef.current;
    if (!el) return;
    trackPosRef.current = px;
    el.style.transition = animate ? `transform ${ms}ms cubic-bezier(0.22,1,0.36,1)` : 'none';
    el.style.transform = `translate3d(${px}px,0,0)`;
  };

  // Pointer Events 横向拖拽绑定：依赖 [hydrated] 确保轨道挂载后立即接线
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      paneWRef.current = el.parentElement?.clientWidth || window.innerWidth;
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', measure);

    const onDown = (e: PointerEvent) => {
      if (uiStore.getState().subpageStack.length > 0) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'mouse' && !e.isPrimary) return;
      const w = paneWRef.current || el.parentElement?.clientWidth || window.innerWidth;
      if (!w) return;
      const skip = !!(e.target as HTMLElement)?.closest?.(
        'input, textarea, select, [data-no-swipe], [data-native-hscroll]',
      );
      dragRef.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        base: -idxRef.current * w,
        w,
        idx: idxRef.current,
        locked: null,
        skip,
        samples: [{ t: performance.now(), x: e.clientX }],
      };
      if (!skip) el.style.transition = 'none';
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.skip || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;

      if (!d.locked) {
        if (Math.abs(dx) < SWIPE_START && Math.abs(dy) < SWIPE_START) return;
        if (Math.abs(dx) < Math.abs(dy) * DIR_BIAS) {
          d.locked = 'y';
          return;
        }
        d.locked = 'h';
        setGestureLive(true);
        document.documentElement.classList.add('gesture-live');
      }
      if (d.locked === 'y') return;

      if (e.cancelable) e.preventDefault();

      let offset = d.base + dx;
      const min = -(TAB_ORDER.length - 1) * d.w;
      if (offset > 0) offset *= EDGE_DAMP;
      else if (offset < min) offset = min + (offset - min) * EDGE_DAMP;
      applyTrack(offset, false);
      d.samples.push({ t: performance.now(), x: e.clientX });
      if (d.samples.length > 12) d.samples.shift();
    };

    const swallowClick = (e: MouseEvent) => {
      if (performance.now() - lastSwipeAtRef.current > 350) return;
      e.stopPropagation();
      e.preventDefault();
    };

    const finish = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setGestureLive(false);
      document.documentElement.classList.remove('gesture-live');
      if (d.skip || d.id !== e.pointerId || d.locked !== 'h') return;

      const now = performance.now();
      const recent = d.samples.filter((s) => now - s.t <= VEL_WINDOW);
      let v = 0;
      if (recent.length >= 2) {
        const a = recent[0];
        const b = recent[recent.length - 1];
        const dt = b.t - a.t;
        if (dt > 0) v = (b.x - a.x) / dt;
      }
      const moved = trackPosRef.current - d.base;
      let idx = d.idx;
      if (Math.abs(moved) > d.w * COMMIT_RATIO || Math.abs(v) > FLICK_V) {
        idx = d.idx + (moved < 0 ? 1 : -1);
      }
      idx = Math.max(0, Math.min(TAB_ORDER.length - 1, idx));
      const ms = Math.max(130, Math.min(SNAP_MS, SNAP_MS - Math.abs(v) * 120));
      snapMsRef.current = ms;

      if (Math.abs(moved) > 10) {
        lastSwipeAtRef.current = performance.now();
      }

      if (idx !== d.idx) {
        hapticPage();
        setActiveTab(TAB_ORDER[idx]);
      } else {
        applyTrack(-d.idx * d.w, true, ms);
      }
      setTimeout(() => preheatNeighbors(TAB_ORDER[idx]), 0);
    };

    window.addEventListener('click', swallowClick, { capture: true });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('click', swallowClick, { capture: true });
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('resize', measure);
      ro.disconnect();
      setGestureLive(false);
      document.documentElement.classList.remove('gesture-live');
    };
  }, [hydrated, preheatNeighbors]);

  // activeTab / hydrated 变更 → 同帧吸附落位
  useLayoutEffect(() => {
    const idx = TAB_ORDER.indexOf(activeTab);
    idxRef.current = idx;
    if (dragRef.current) return;
    applyTrack(-idx * (paneWRef.current || window.innerWidth), true, snapMsRef.current);
  }, [activeTab, hydrated]);

  return { trackRef, mountedPanes };
}
