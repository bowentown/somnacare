import { useSyncExternalStore } from 'react';

export type SetState<T> = (partial: Partial<T> | ((prev: T) => Partial<T>)) => void;

export interface StoreApi<T> {
  getState: () => T;
  setState: SetState<T>;
  subscribe: (listener: () => void) => () => void;
  useStore: <S>(selector: (state: T) => S) => S;
}

/**
 * 零依赖选择器 Store 工厂（基于 React 19 内置 useSyncExternalStore）。
 *
 * 相比顶层 useState + props 透传：
 * - 只有 selector 返回值按 Object.is 发生变化的组件才会重渲染，消除全局 toast/横幅导致的五分区整树重绘；
 * - 可在组件外（hooks、原生桥回调、Vitest 单测）直接通过 getState / setState 读写，无需递增数字信号 hack。
 */
export function createStore<T extends object>(initialState: T): StoreApi<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  const getState = (): T => state;

  const setState: SetState<T> = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    if (!patch || Object.keys(patch).length === 0) return;
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof T>) {
      if (!Object.is(state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const useStore = <S,>(selector: (s: T) => S): S =>
    useSyncExternalStore(
      subscribe,
      () => selector(state),
      () => selector(state),
    );

  return { getState, setState, subscribe, useStore };
}
