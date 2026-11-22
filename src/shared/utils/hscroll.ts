/**
 * 横向滚动条的 JS 拖拽补偿。
 *
 * 为什么需要它：分区滑动轨道给每个分区设了 `touch-action: pan-y`，让浏览器
 * 把横向手势完整让给分区切换手势（这是分区横滑跟手、不被浏览器滚动仲裁
 * 卡顿的根本）。但 CSS 规范规定 touch-action 取自身与所有祖先的交集，
 * 于是位于分区内部的原生 `overflow-x: auto` 元素（AI 顾问的快捷提示词行）
 * 也会失去横向滚动能力。
 *
 * 本模块直接驱动 `scrollLeft`，行为与原生一致，且完全掌握在 JS 手里：
 * 不会与分区手势竞争、不会被浏览器的滚动锁定打断、不受合成层限制。
 */

const START_PX = 6;    // 起拖阈值
const VEL_WINDOW = 90; // 速度采样窗口（ms）
const FRICTION = 0.94; // 惯性衰减系数
const MIN_V = 0.02;    // 低于此速度停止惯性
const EDGE_DAMP = 0.3; // 边界橡皮筋阻尼

type State = {
  id: number;
  startX: number;
  startY: number;
  startScroll: number;
  maxScroll: number;
  locked: 'h' | 'y' | null;
  samples: { t: number; x: number }[];
  raf: number;
  v: number;
};

const states = new WeakMap<Element, State>();

/** 把横滑区域挂上 JS 拖拽。返回一个清理函数。 */
export function attachHScroll(el: HTMLElement): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType !== 'mouse' && !e.isPrimary) return;
    const prev = states.get(el);
    if (prev?.raf) cancelAnimationFrame(prev.raf);
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScroll <= 0) return; // 内容没溢出，无需接管
    states.set(el, {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScroll: el.scrollLeft,
      maxScroll,
      locked: null,
      samples: [{ t: performance.now(), x: e.clientX }],
      raf: 0,
      v: 0,
    });
    // ★ 不能在 pointerdown 就 setPointerCapture：按 Pointer Events 规范，
    // 捕获期间产生的 click 事件会派发给捕获元素（行本身）而不是被点的
    // 胶囊按钮——行内容溢出是常态，快捷提问的点击会整体失效。
    // 捕获推迟到横向锁定时（见 onMove），拖拽语义不变、点击恢复正常
  };

  const onMove = (e: PointerEvent) => {
    const s = states.get(el);
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.locked) {
      if (Math.abs(dx) < START_PX && Math.abs(dy) < START_PX) return;
      // 纵向意图交还页面滚动（不 preventDefault，让分区 pane 正常滚）
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'y';
    }
    if (s.locked === 'y') {
      states.delete(el);
      return;
    }
    // 首次锁横向时才捕获：手指拖出元素边界后事件仍持续流入（拖拽语义需要），
    // 而纯点击（从未锁定）不捕获 → click 正常派发给被点的胶囊
    if (!el.hasPointerCapture?.(e.pointerId)) el.setPointerCapture?.(e.pointerId);
    if (e.cancelable) e.preventDefault();

    let next = s.startScroll - dx;
    if (next < 0) next *= EDGE_DAMP;
    else if (next > s.maxScroll) next = s.maxScroll + (next - s.maxScroll) * EDGE_DAMP;
    el.scrollLeft = next;

    const now = performance.now();
    s.samples.push({ t: now, x: e.clientX });
    if (s.samples.length > 12) s.samples.shift();
    const recent = s.samples.filter((p) => now - p.t <= VEL_WINDOW);
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = b.t - a.t;
      s.v = dt > 0 ? (a.x - b.x) / dt : 0; // 手指左移 → scrollLeft 增大
    }
  };

  const end = (e: PointerEvent) => {
    const s = states.get(el);
    if (!s || s.id !== e.pointerId) return;
    states.delete(el);
    el.releasePointerCapture?.(e.pointerId);
    if (s.locked !== 'h' || Math.abs(s.v) < MIN_V) return;

    // 惯性滑行：每帧按摩擦衰减推进，撞到边界直接停
    const glide = () => {
      const cur = states.get(el);
      if (cur) return; // 新的触摸已开始
      let pos = el.scrollLeft + s.v * 16;
      if (pos < 0 || pos > s.maxScroll) {
        pos = Math.max(0, Math.min(s.maxScroll, pos));
        s.v = 0;
      }
      el.scrollLeft = pos;
      s.v *= FRICTION;
      if (Math.abs(s.v) < MIN_V) {
        s.raf = 0;
        return;
      }
      s.raf = requestAnimationFrame(glide);
    };
    s.raf = requestAnimationFrame(glide);
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // 手指在元素外抬起时事件不冒泡回元素，绑 window 兜底避免状态卡死
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return () => {
    const s = states.get(el);
    if (s?.raf) cancelAnimationFrame(s.raf);
    states.delete(el);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  };
}
