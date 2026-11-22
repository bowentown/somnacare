import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../src/shared/store/createStore';
import {
  clearSubpages,
  handleDeepLink,
  openAutoCheckSubpage,
  openMoments,
  popSubpage,
  pushSubpage,
  resetUIStore,
  setActiveTab,
  uiStore,
} from '../../src/shared/store/uiStore';

describe('轻量选择器 Store 与二级子页栈', () => {
  beforeEach(() => {
    resetUIStore();
  });

  it('createStore 仅在状态实际变更时通知订阅者，并支持函数式更新与退订', () => {
    const store = createStore({ count: 0, label: 'init' });
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });

    // 无实际字段变化时不应触发无谓通知
    store.setState({ count: 0 });
    expect(calls).toBe(0);

    // 局部 patch 触发通知
    store.setState({ count: 1 });
    expect(calls).toBe(1);
    expect(store.getState()).toEqual({ count: 1, label: 'init' });

    // 函数式更新触发通知
    store.setState((prev) => ({ count: prev.count + 2, label: 'done' }));
    expect(calls).toBe(2);
    expect(store.getState()).toEqual({ count: 3, label: 'done' });

    // 退订后不再收到通知
    unsub();
    store.setState({ count: 99 });
    expect(calls).toBe(2);
    expect(store.getState().count).toBe(99);
  });

  it('二级子页栈支持压栈、弹栈、清空，且切换底栏主 Tab 自动清栈', () => {
    expect(uiStore.getState().subpageStack).toEqual([]);
    expect(popSubpage()).toBe(false);

    pushSubpage('settings/appearance');
    pushSubpage('settings/data', { autoCheck: 123 });
    expect(uiStore.getState().subpageStack).toHaveLength(2);
    expect(uiStore.getState().subpageStack[1]).toEqual({
      id: 'settings/data',
      params: { autoCheck: 123 },
    });

    expect(popSubpage()).toBe(true);
    expect(uiStore.getState().subpageStack).toEqual([{ id: 'settings/appearance', params: undefined }]);

    setActiveTab('trends');
    expect(uiStore.getState().activeTab).toBe('trends');
    expect(uiStore.getState().subpageStack).toEqual([]);

    pushSubpage('intervention/wind-down');
    clearSubpages();
    expect(uiStore.getState().subpageStack).toEqual([]);
  });

  it('DeepLink 路由与快捷入口能准确落位主 Tab、子页栈与弹窗', () => {
    expect(handleDeepLink('somnacare://sleep/start')).toBe(true);
    expect(uiStore.getState().activeTab).toBe('today');
    expect(uiStore.getState().activeSleepOpen).toBe(true);

    expect(handleDeepLink('intervention/wind-down')).toBe(true);
    expect(uiStore.getState().activeTab).toBe('today');
    expect(uiStore.getState().subpageStack[0]?.id).toBe('intervention/wind-down');

    expect(handleDeepLink('open/settings/data?autoCheck=1')).toBe(true);
    expect(uiStore.getState().activeTab).toBe('settings');
    expect(uiStore.getState().subpageStack[0]?.id).toBe('settings/data');
    expect(typeof uiStore.getState().subpageStack[0]?.params?.autoCheck).toBe('number');

    expect(handleDeepLink('pet/codex')).toBe(true);
    expect(uiStore.getState().codexOpen).toBe(true);

    openMoments();
    expect(uiStore.getState().activeTab).toBe('coach');
    expect(uiStore.getState().momentsOpen).toBe(true);
    expect(uiStore.getState().subpageStack).toEqual([]);

    openAutoCheckSubpage();
    expect(uiStore.getState().activeTab).toBe('settings');
    expect(uiStore.getState().subpageStack[0]?.id).toBe('settings/data');

    expect(handleDeepLink('unknown/route')).toBe(false);
    expect(handleDeepLink('   ')).toBe(false);
  });
});
