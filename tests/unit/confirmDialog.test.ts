import { afterEach, describe, expect, it } from 'vitest';
import {
  alertDialog,
  confirmDialog,
  getActiveDialogSnapshot,
  resetDialogQueueForTest,
  resolveActiveDialogForTest,
} from '../../src/shared/ui/ConfirmDialogHost';

describe('ConfirmDialogHost 命令式弹窗队列', () => {
  afterEach(() => {
    resetDialogQueueForTest();
  });

  it('confirmDialog 支持字符串简写与完整配置，取消与确认分别 resolve false/true', async () => {
    const p1 = confirmDialog('删除这个闹钟？');
    expect(getActiveDialogSnapshot()).toMatchObject({
      mode: 'confirm',
      title: '请确认',
      message: '删除这个闹钟？',
      confirmText: '确定',
      cancelText: '取消',
      danger: false,
    });
    expect(resolveActiveDialogForTest(false)).toBe(true);
    expect(await p1).toBe(false);
    expect(getActiveDialogSnapshot()).toBeNull();

    const p2 = confirmDialog({
      title: '删除对话',
      message: '不可恢复',
      confirmText: '删除',
      cancelText: '保留',
      danger: true,
    });
    expect(getActiveDialogSnapshot()).toMatchObject({
      mode: 'confirm',
      title: '删除对话',
      message: '不可恢复',
      confirmText: '删除',
      cancelText: '保留',
      danger: true,
    });
    expect(resolveActiveDialogForTest(true)).toBe(true);
    expect(await p2).toBe(true);
  });

  it('并发调用严格按 FIFO 队列顺序展示，不互相覆盖', async () => {
    const order: string[] = [];
    const p1 = confirmDialog({ title: '第一步', message: '确认清空？', danger: true }).then((v) => {
      order.push(`p1:${v}`);
      return v;
    });
    const p2 = alertDialog({ title: '第二步', message: '已完成导入' }).then(() => {
      order.push('p2:done');
    });
    const p3 = confirmDialog({ title: '第三步', message: '继续？' }).then((v) => {
      order.push(`p3:${v}`);
      return v;
    });

    expect(getActiveDialogSnapshot()?.title).toBe('第一步');
    resolveActiveDialogForTest(true);
    expect(await p1).toBe(true);

    expect(getActiveDialogSnapshot()?.title).toBe('第二步');
    expect(getActiveDialogSnapshot()?.mode).toBe('alert');
    resolveActiveDialogForTest(false); // 即使按 ESC/遮罩关闭 alertDialog 也正常 resolve
    await p2;

    expect(getActiveDialogSnapshot()?.title).toBe('第三步');
    resolveActiveDialogForTest(false);
    expect(await p3).toBe(false);

    expect(getActiveDialogSnapshot()).toBeNull();
    expect(order).toEqual(['p1:true', 'p2:done', 'p3:false']);
  });

  it('空队列下 resolveActiveDialogForTest 返回 false 且不抛错', () => {
    expect(getActiveDialogSnapshot()).toBeNull();
    expect(resolveActiveDialogForTest(true)).toBe(false);
  });

  it('连续入队弹窗拥有严格递增唯一 id，且重置队列会安全 resolve 全部悬空 Promise', async () => {
    const p1 = confirmDialog({ title: 'A', message: '消息 A', danger: true });
    const id1 = getActiveDialogSnapshot()?.id ?? 0;
    const p2 = confirmDialog({ title: 'B', message: '消息 B', danger: true });

    resolveActiveDialogForTest(true);
    expect(await p1).toBe(true);

    const id2 = getActiveDialogSnapshot()?.id ?? 0;
    expect(id2).toBeGreaterThan(id1);

    resetDialogQueueForTest();
    expect(await p2).toBe(false);
    expect(getActiveDialogSnapshot()).toBeNull();
  });
});
