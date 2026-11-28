import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from './_helpers';

const fitSleepModelMock = vi.fn();

vi.mock('../../src/features/sleep/utils/sleepModel', async () => {
  const actual = await vi.importActual<typeof import('../../src/features/sleep/utils/sleepModel')>(
    '../../src/features/sleep/utils/sleepModel',
  );
  return {
    ...actual,
    fitSleepModel: (...args: unknown[]) => fitSleepModelMock(...args),
  };
});

import {
  clearProposalFitCache,
  computeModelProposal,
} from '../../src/features/sleep/utils/proposal';

const storage = installMemoryStorage();

function makeOkFitOutcome(targetDate: string, nowMs: number) {
  return {
    status: 'ok' as const,
    targetDate,
    bedtime: '23:30',
    wakeTime: '07:15',
    bedtimeMs: nowMs - 9 * 3600_000,
    wakeMs: nowMs - 1.25 * 3600_000,
    delta: 920,
    lambdaRatio: 6.4,
    nightsFitted: 10,
    sleepEventsInTarget: 1,
  };
}

describe('proposal.ts M3 拟合缓存：observedUntil 5 分钟桶归一使 approximateHit 真正生效', () => {
  beforeEach(() => {
    storage.clear();
    clearProposalFitCache();
    fitSleepModelMock.mockReset();
  });

  it('同一 5 分钟桶内即使 events 换出新数组引用、observedUntil 推进 2 分钟且 offEvents/rawOnEvents 少量新增，也命中缓存', () => {
    // 锚定在 08:01:00（桶起始 08:00:00，同桶范围 08:00:00 ~ 08:04:59.999）
    const base = new Date(2026, 9, 20, 8, 1, 0, 0);
    const t1 = base.getTime();
    const t2 = t1 + 2 * 60_000; // 08:03:00，仍在同一 5 分钟桶内
    const evs1 = Array.from({ length: 400 }, (_, i) => t1 - (400 - i) * 180_000);
    const evs2 = [...evs1, t2 - 60_000]; // 模拟回前台 force 刷新产出的新数组引用
    const off1 = [t1 - 3600_000, t1 - 600_000];
    const off2 = [...off1, t2 - 90_000]; // 同桶内锁屏 1 次
    const raw1 = [t1 - 3000_000, t1 - 300_000];
    const raw2 = [...raw1, t2 - 30_000]; // 同桶内亮屏 1 次

    fitSleepModelMock.mockReturnValue(makeOkFitOutcome('2026-10-19', t1));

    const r1 = computeModelProposal({
      events: evs1,
      offEvents: off1,
      rawOnEvents: raw1,
      observedUntil: t1,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: base,
    });
    const r2 = computeModelProposal({
      events: evs2,
      offEvents: off2,
      rawOnEvents: raw2,
      observedUntil: t2,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: new Date(t2),
    });

    expect(r1.proposal?.targetDate).toBe('2026-10-19');
    expect(r2.proposal?.targetDate).toBe('2026-10-19');
    expect(fitSleepModelMock).toHaveBeenCalledTimes(1);
  });

  it('跨越 5 分钟桶边界、输入规模跨越最小样本门（含空数组）或事件数剧变（>=50）时缓存失效并重新拟合', () => {
    const base = new Date(2026, 9, 20, 8, 1, 0, 0);
    const t1 = base.getTime();
    const tNextBucket = t1 + 6 * 60_000; // 08:07:00，进入下一个 5 分钟桶
    const evs = Array.from({ length: 400 }, (_, i) => t1 - (400 - i) * 180_000);

    fitSleepModelMock.mockReturnValue(makeOkFitOutcome('2026-10-19', t1));

    computeModelProposal({
      events: evs,
      observedUntil: t1,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: base,
    });
    expect(fitSleepModelMock).toHaveBeenCalledTimes(1);

    // 跨桶 → 重新拟合
    computeModelProposal({
      events: [...evs],
      observedUntil: tNextBucket,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: new Date(tNextBucket),
    });
    expect(fitSleepModelMock).toHaveBeenCalledTimes(2);

    // 同桶但输入截断（长度差 >= 50）→ 不误命中，重新拟合
    computeModelProposal({
      events: evs.slice(-40),
      observedUntil: tNextBucket + 30_000,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: new Date(tNextBucket + 30_000),
    });
    expect(fitSleepModelMock).toHaveBeenCalledTimes(3);

    // 此前缓存 eventCount=40（<50），切为空数组 [] 时绝不能误命中 approximateHit
    fitSleepModelMock.mockReturnValueOnce({ status: 'insufficient', reason: '事件不足' });
    const emptyRes = computeModelProposal({
      events: [],
      observedUntil: tNextBucket + 40_000,
      chronotype: 'night',
      records: [],
      sessionActive: false,
      handledDate: null,
      now: new Date(tNextBucket + 40_000),
    });
    expect(fitSleepModelMock).toHaveBeenCalledTimes(4);
    expect(emptyRes.fallbackAllowed).toBe(true);
  });
});
