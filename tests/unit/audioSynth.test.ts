import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeAudioParam {
  value = 0;
  setValueAtTime(v: number) { this.value = v; }
  linearRampToValueAtTime(v: number) { this.value = v; }
  exponentialRampToValueAtTime(v: number) { this.value = v; }
  setTargetAtTime(v: number) { this.value = v; }
}

class FakeAudioNode {
  gain = new FakeAudioParam();
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  connect() { return this; }
  disconnect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  sampleRate = 8000;
  currentTime = 0;
  oscillatorCount = 0;
  bufferCount = 0;
  destination = new FakeAudioNode();
  addEventListener() {}
  resume() { return Promise.resolve(); }
  createGain() { return new FakeAudioNode(); }
  createBiquadFilter() { return new FakeAudioNode(); }
  createOscillator() {
    this.oscillatorCount++;
    return new FakeAudioNode();
  }
  createBuffer(_ch: number, len: number) {
    this.bufferCount++;
    const data = new Float32Array(len);
    return { getChannelData: () => data };
  }
  createBufferSource() { return new FakeAudioNode(); }
}

describe('SleepAudioSynthesizer currentType 与闹钟试听隔离契约', () => {
  let lastCtx: FakeAudioContext | null = null;
  let origWindow: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    origWindow = (globalThis as any).window;
    class TrackingAudioContext extends FakeAudioContext {
      constructor() {
        super();
        lastCtx = this;
      }
    }
    (globalThis as any).window = {
      AudioContext: TrackingAudioContext,
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    };
  });

  afterEach(async () => {
    const { sleepAudio } = await import('../../src/features/intervention/utils/audioSynth');
    sleepAudio.stop();
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    if (origWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = origWindow;
  });

  it('startLayer 正确维护 currentType，stopAlarm 绝不打断正在播放的助眠音景', async () => {
    const { sleepAudio } = await import('../../src/features/intervention/utils/audioSynth');

    sleepAudio.startLayer('rain', 0.6);
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('rain');
    expect(sleepAudio.getActiveLayers()).toEqual(['rain']);

    // 卸载 AlarmManager 时调用 stopAlarm，不得停掉助眠雨声
    sleepAudio.stopAlarm();
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('rain');
    expect(sleepAudio.getActiveLayers()).toEqual(['rain']);

    // 叠加第二层并停掉后，currentType 准确回退到剩余活跃层
    sleepAudio.startLayer('ocean', 0.5);
    expect(sleepAudio.getCurrentType()).toBe('ocean');
    sleepAudio.stopLayer('ocean');
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('rain');

    sleepAudio.stopLayer('rain');
    expect(sleepAudio.getIsPlaying()).toBe(false);
    expect(sleepAudio.getCurrentType()).toBeNull();
  });

  it('play 单层切换与二次点击停播契约正确生效', async () => {
    const { sleepAudio } = await import('../../src/features/intervention/utils/audioSynth');

    sleepAudio.play('rain');
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('rain');

    // 再次点击同一音色应准确触发停止（历史 currentType 未赋值会导致永不停止）
    sleepAudio.play('rain');
    expect(sleepAudio.getIsPlaying()).toBe(false);
    expect(sleepAudio.getCurrentType()).toBeNull();
  });

  it('playAlarm → stopAllLayers 不破坏闹钟通道 → stopAlarm 立即停响并清零状态', async () => {
    const { sleepAudio } = await import('../../src/features/intervention/utils/audioSynth');

    sleepAudio.playAlarm('gentle_chime');
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('alarm');

    // stopAllLayers 声明不动闹钟通道
    sleepAudio.stopAllLayers(false);
    expect(sleepAudio.getIsPlaying()).toBe(true);
    expect(sleepAudio.getCurrentType()).toBe('alarm');

    // stopAlarm 同步停止闹钟通道
    sleepAudio.stopAlarm();
    expect(sleepAudio.getIsPlaying()).toBe(false);
    expect(sleepAudio.getCurrentType()).toBeNull();
  });

  it('stop() 与 stopLayer() 同步清理定时器，150ms 淡出窗口内不会再触发已停通道的定时器', async () => {
    const { sleepAudio } = await import('../../src/features/intervention/utils/audioSynth');

    // 场景 A：闹钟（600ms 拍点）在 550ms 时切入助眠雨声，600ms 时刻不得漏出旧闹钟音符
    sleepAudio.playAlarm('aurora_melody');
    vi.advanceTimersByTime(550);
    sleepAudio.startLayer('rain', 0.6);
    const oscBefore = lastCtx!.oscillatorCount;
    vi.advanceTimersByTime(100); // 跨过原 600ms 拍点，但在 150ms 淡出窗口内
    expect(lastCtx!.oscillatorCount).toBe(oscBefore);

    // 场景 B：停止 campfire（85ms 爆点定时器）但保留 rain（isPlaying 仍为 true），
    // 200ms 淡出窗口内不得再分配新的噼啪 AudioBuffer
    sleepAudio.startLayer('campfire', 0.5);
    sleepAudio.stopLayer('campfire');
    const bufBefore = lastCtx!.bufferCount;
    vi.advanceTimersByTime(180);
    expect(lastCtx!.bufferCount).toBe(bufBefore);
  });
});
