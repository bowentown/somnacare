/**
 * 原生桥访问（唯一入口）。
 *
 * 为什么必须唯一（第 94 轮）：平台判定与插件取用此前散在多处手写——同一段
 * `isNativePlatform()` 判定 + `Plugins.X ?? null` 在 utils 里被复制了 6 份。
 * 每一份都是一次重新踩坑的机会，而这两个坑都真实发生过：
 *
 *  1. `@capacitor/core` 的 `createCapacitor()` 读的是
 *     **`window.CapacitorCustomPlatform`**——`window.Capacitor` 的【兄弟】
 *     属性，不是嵌套属性。塞进 `Capacitor` 里 → `isNativePlatform()` 恒
 *     false，依赖 native 的分支整体不渲染（第 90 轮实测，e2e 假红一轮）。
 *  2. **绝不能静态 import** `@capacitor/core` 或任何插件包：那会拉起它的
 *     web 运行时，并在页面加载时改写 `window.Capacitor`，把 e2e 与网页预览
 *     的平台判定一起改掉（第 52 轮踩过，见 proposalNotify.ts 的注释）。
 *     本模块因此只**动态读** `window.Capacitor`，不引任何包。
 */

/** Capacitor 运行时对象；Web / e2e / 网页预览下可能不存在。异常一律按"不存在"处理。 */
function capacitor(): any | null {
  try {
    return (window as any).Capacitor ?? null;
  } catch {
    return null;
  }
}

/** 是否跑在原生容器（APK）内。Web / e2e / 网页预览一律 false。 */
export function isNativePlatform(): boolean {
  const cap = capacitor();
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

/**
 * 取原生插件实例。非原生平台、或插件未注册时返回 null。
 *
 * "Web 端绝不拿到原生插件"是安全边界而非便利：调用方据此走 web 回退分支，
 * 若这里在 web 上漏出实例，原生专用逻辑（悬浮窗/无障碍/精确闹钟）会被当
 * 作可用而静默失效。
 */
export function nativePlugin<T = any>(name: string): T | null {
  if (!isNativePlatform()) return null;
  try {
    return ((capacitor()?.Plugins ?? {})[name] ?? null) as T | null;
  } catch {
    return null;
  }
}
