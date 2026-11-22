/**
 * Real Web Audio API synthesizer for sleep sounds
 * Supports Rain, Ocean Surf, Night Forest/Crickets, Deep Pink Noise, and Tibetan Singing Bowl
 */

type LayerKey = 'rain' | 'ocean' | 'forest' | 'whitenoise' | 'bowl' | 'thunder' | 'campfire' | 'wind' | 'brown';

class SleepAudioSynthesizer {
  private ctx: AudioContext | null = null;
  private isPlaying: boolean = false;
  private currentType: string | null = null;
  private masterGain: GainNode | null = null;
  private activeNodes: (AudioNode | number)[] = [];
  private sessionEpoch = 0;
  // 多层混音：每个音效一层独立增益（BetterSleep 式叠加）
  private layers = new Map<LayerKey, { gain: GainNode; nodes: (AudioNode | number)[] }>();
  private volume: number = 0.5;

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
      // 播放中被打断后的自动恢复（第 51 轮审计 P1）：睡眠 App 的核心场景
      // 就是锁屏/来电/后台——此前 resume 只在用户再点一次播放时发生，
      // 回前台后 UI 显示"播放中"却永远静音。statechange 挂在 context 上，
      // 仅 isPlaying 时 resume；resume 本身可能被自动播放策略拒绝，须 catch
      this.ctx.addEventListener('statechange', () => {
        if (this.ctx && this.ctx.state === 'suspended' && this.isPlaying) {
          this.ctx.resume().catch(() => { /* 保持静默，下次交互再试 */ });
        }
      });
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* ignore */ });
    }
  }

  public setVolume(val: number) {
    // Hearing health safety limit (WHO long-term sleep exposure cap: < 70 dBA equivalent)
    const SAFE_MAX_VOLUME = 0.72;
    this.volume = Math.max(0, Math.min(SAFE_MAX_VOLUME, val));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getCurrentType(): string | null {
    return this.currentType;
  }

  public stop() {
    // 竞态防护：清理只针对本次会话捕获的节点。此前清理延迟 150ms 且直接操作共享的
    // activeNodes/masterGain，150ms 内快速切换音色时会误杀新会话的节点——
    // 表现为"已经静音但 UI 仍显示正在播放"。
    this.stopAllLayers(true);
    this.sessionEpoch++;
    const epoch = this.sessionEpoch;
    const nodes = this.activeNodes;
    const master = this.masterGain;
    this.activeNodes = [];
    this.masterGain = null;
    if (master && this.ctx) {
      master.gain.setTargetAtTime(0.001, this.ctx.currentTime, 0.1);
    }
    setTimeout(() => {
      for (const item of nodes) {
        if (typeof item === 'number') {
          window.clearInterval(item);
        } else {
          try {
            if ('stop' in item && typeof (item as any).stop === 'function') {
              (item as any).stop();
            }
            item.disconnect();
          } catch {
            // ignore
          }
        }
      }
      try {
        master?.disconnect();
      } catch {
        // ignore
      }
      if (epoch === this.sessionEpoch) {
        this.isPlaying = false;
        this.currentType = null;
      }
    }, 150);
  }

  public play(type: LayerKey) {
    this.initContext();
    if (!this.ctx) return;

    if (this.isPlaying && this.currentType === type) {
      this.stop();
      return;
    }

    this.stop();

    // 单层播放：停掉所有层后以满层增益启动（保持旧响度语义）
    this.stopAllLayers(true);
    const master = this.ensureMaster();
    master.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    this.startLayer(type, 1);
  }

  /** 确保主增益节点存在（initContext 之后调用） */
  private ensureMaster(): GainNode {
    if (!this.masterGain) {
      const master = this.ctx!.createGain();
      master.gain.value = this.volume;
      master.connect(this.ctx!.destination);
      this.masterGain = master;
    }
    return this.masterGain;
  }

  /** 启动一层音效（独立增益，不影响其他层） */
  public startLayer(type: LayerKey, vol = 0.6) {
    this.initContext();
    if (!this.ctx) return;
    if (this.layers.has(type)) return;
    // 新会话推进纪元：同 playAlarm，作废 stop() 的 150ms 延迟回调——
    // 否则 150ms 内快速开播的层会被回调判死，随机事件层全部静默
    this.sessionEpoch++;
    const master = this.ensureMaster();
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime + 0.35);
    gain.connect(master);
    const nodes: (AudioNode | number)[] = [];
    switch (type) {
      case 'rain': this.startRain(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'ocean': this.startOcean(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'forest': this.startForest(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'whitenoise': this.startPinkNoise(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'bowl': this.startTibetanBowl(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'thunder': this.startThunder(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'campfire': this.startCampfire(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'wind': this.startWind(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
      case 'brown': this.startBrown(gain, (...ns) => ns.forEach((n) => nodes.push(n))); break;
    }
    this.layers.set(type, { gain, nodes });
    this.isPlaying = true;
  }

  /** 停止一层 */
  public stopLayer(type: LayerKey) {
    const layer = this.layers.get(type);
    if (!layer) return;
    this.layers.delete(type);
    if (this.ctx) {
      layer.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.08);
    }
    window.setTimeout(() => {
      for (const item of layer.nodes) {
        if (typeof item === 'number') {
          window.clearInterval(item);
        } else {
          try {
            if ('stop' in item && typeof (item as any).stop === 'function') {
              (item as any).stop();
            }
            item.disconnect();
          } catch { /* ignore */ }
        }
      }
      try { layer.gain.disconnect(); } catch { /* ignore */ }
    }, 200);
    if (this.layers.size === 0) {
      this.isPlaying = false;
      this.currentType = null;
    }
  }

  /** 停止所有音效层（不动闹钟铃声通道） */
  public stopAllLayers(immediate = false) {
    for (const type of [...this.layers.keys()]) {
      if (immediate) {
        const layer = this.layers.get(type)!;
        this.layers.delete(type);
        for (const item of layer.nodes) {
          if (typeof item === 'number') {
            window.clearInterval(item);
          } else {
            try {
              if ('stop' in item && typeof (item as any).stop === 'function') {
                (item as any).stop();
              }
              item.disconnect();
            } catch { /* ignore */ }
          }
          try { layer.gain.disconnect(); } catch { /* ignore */ }
        }
      } else {
        this.stopLayer(type);
      }
    }
    if (this.layers.size === 0) {
      this.isPlaying = false;
      this.currentType = null;
    }
  }

  /** 当前活跃层 */
  public getActiveLayers(): string[] {
    return [...this.layers.keys()];
  }

  /** 调整某层音量 */
  public setLayerVolume(type: LayerKey, vol: number) {
    const layer = this.layers.get(type);
    if (!layer || !this.ctx) return;
    layer.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime, 0.05);
  }

  // 6. 雷雨敲窗：闷雨底 + 稀疏雨滴 + 随机远雷（低频滚雷包络）
  private startThunder(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + 0.02 * white) / 1.02;
      lastOut = output[i];
      output[i] *= 2.2;
    }
    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const bedGain = this.ctx.createGain();
    bedGain.gain.value = 0.5;
    whiteNoise.connect(hp); hp.connect(lp); lp.connect(bedGain); bedGain.connect(dest);
    whiteNoise.start();
    collect(whiteNoise, hp, lp, bedGain);

    const drops = window.setInterval(() => {
      if (!this.ctx || !this.isPlaying) return;
      const osc = this.ctx.createOscillator();
      const dropGain = this.ctx.createGain();
      const freq = 900 + Math.random() * 1500;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.4, this.ctx.currentTime + 0.05);
      dropGain.gain.setValueAtTime(0.03 * (0.5 + Math.random() * 0.5), this.ctx.currentTime);
      dropGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.06);
      osc.connect(dropGain); dropGain.connect(dest);
      osc.start(); osc.stop(this.ctx.currentTime + 0.07);
    }, 300);
    collect(drops);

    const thunder = () => {
      if (!this.ctx || !this.isPlaying) return;
      const dur = 2.2 + Math.random() * 2.2;
      const rumbleBuf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
      const rumble = rumbleBuf.getChannelData(0);
      let v = 0;
      for (let i = 0; i < rumble.length; i++) {
        v += (Math.random() * 2 - 1) * 0.03;
        v *= 0.996;
        rumble[i] = v * 2.8;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = rumbleBuf;
      const lp2 = this.ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 110 + Math.random() * 160;
      const g = this.ctx.createGain();
      const t = this.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55 + Math.random() * 0.35, t + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(lp2); lp2.connect(g); g.connect(dest);
      src.start(t);
      // 一次性事件链：用 onended 自清，不进 layer.nodes——此前每个滚雷的
      // 422-845KB AudioBuffer 被永久持有（约 107-215MB/小时）
      src.onended = () => { try { src.disconnect(); lp2.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    };
    const thunderTimer = window.setInterval(() => {
      if (Math.random() < 0.6) thunder();
    }, 8500);
    collect(thunderTimer);
  }

  // 7. 篝火余温：棕噪暖场底 + 随机高频噼啪爆点
  private startCampfire(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const bed = this.ctx.createBufferSource();
    bed.buffer = buf;
    bed.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const bedGain = this.ctx.createGain();
    bedGain.gain.value = 0.16;
    bed.connect(lp); lp.connect(bedGain); bedGain.connect(dest);
    bed.start();
    collect(bed, lp, bedGain);

    const crackle = () => {
      if (!this.ctx || !this.isPlaying) return;
      const dur = 0.015 + Math.random() * 0.06;
      const cb = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * dur)), this.ctx.sampleRate);
      const cd = cb.getChannelData(0);
      for (let i = 0; i < cd.length; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / cd.length);
      const src = this.ctx.createBufferSource();
      src.buffer = cb;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400 + Math.random() * 2600;
      const g = this.ctx.createGain();
      const t = this.ctx.currentTime;
      g.gain.setValueAtTime(0.05 + Math.random() * 0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(hp); hp.connect(g); g.connect(dest);
      src.start(t);
      // 同上：篝火噼啪每次约 8.6KB × 约 36000 次/小时 ≈ 311MB/小时
      src.onended = () => { try { src.disconnect(); hp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    };
    const crackleTimer = window.setInterval(() => {
      if (Math.random() < 0.85) crackle();
    }, 85);
    collect(crackleTimer);
  }

  // 8. 山谷夜风：带通噪声 + 双 LFO 缓慢阵风
  private startWind(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 320;
    bp.Q.value = 0.9;
    const gust = this.ctx.createGain();
    gust.gain.value = 0.32;
    const lfo1 = this.ctx.createOscillator();
    lfo1.frequency.value = 0.06;
    const lfo1G = this.ctx.createGain();
    lfo1G.gain.value = 170;
    lfo1.connect(lfo1G); lfo1G.connect(bp.frequency);
    const lfo2 = this.ctx.createOscillator();
    lfo2.frequency.value = 0.043;
    const lfo2G = this.ctx.createGain();
    lfo2G.gain.value = 0.14;
    lfo2.connect(lfo2G); lfo2G.connect(gust.gain);
    noise.connect(bp); bp.connect(gust); gust.connect(dest);
    noise.start(); lfo1.start(); lfo2.start();
    collect(noise, bp, gust, lfo1, lfo1G, lfo2, lfo2G);
  }

  // 9. 深棕噪音：积分白噪（比粉噪更低沉），低通护眠
  private startBrown(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    const g = this.ctx.createGain();
    g.gain.value = 0.42;
    noise.connect(lp); lp.connect(g); g.connect(dest);
    noise.start();
    collect(noise, lp, g);
  }

  // Ringing alarm tone for custom wakeup alarms
  public playAlarm(tone: 'gentle_chime' | 'aurora_melody' | 'radar_beep' = 'gentle_chime') {
    this.initContext();
    if (!this.ctx) return;
    this.stop();
    // 新会话推进纪元：作废 stop() 留下的 150ms 延迟回调。否则该回调把刚开播
    // 会话的 isPlaying 改回 false——Web 闹钟只响 2.6 秒、试听铃声只响一下
    // 的根因（所有音符都过 `if (!this.isPlaying) return` 这道门）
    this.sessionEpoch++;

    const master = this.ctx.createGain();
    master.gain.setValueAtTime(0.001, this.ctx.currentTime);
    master.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 0.2);
    master.connect(this.ctx.destination);
    this.masterGain = master;
    this.isPlaying = true;
    this.currentType = 'alarm';

    if (tone === 'gentle_chime') {
      // Harmonic singing chime every 2.8s (528Hz Solfeggio series)
      const playChimeNote = () => {
        if (!this.ctx || !this.isPlaying) return;
        const notes = [528, 660, 792, 1056];
        notes.forEach((freq, i) => {
          if (!this.ctx) return;
          const osc = this.ctx.createOscillator();
          const noteGain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const noteTime = this.ctx.currentTime + i * 0.22;
          noteGain.gain.setValueAtTime(0.001, noteTime);
          noteGain.gain.linearRampToValueAtTime(0.18 / (i + 1), noteTime + 0.05);
          noteGain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 1.8);
          osc.connect(noteGain);
          noteGain.connect(master);
          osc.start(noteTime);
          osc.stop(noteTime + 2.0);
        });
      };
      playChimeNote();
      const interval = window.setInterval(playChimeNote, 2800);
      this.activeNodes.push(interval);
    } else if (tone === 'aurora_melody') {
      // Calming ascending pentatonic melody
      const notes = [392, 440, 523.25, 587.33, 659.25, 783.99];
      let step = 0;
      const playStep = () => {
        if (!this.ctx || !this.isPlaying) return;
        const freq = notes[step % notes.length];
        step++;
        const osc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const noteTime = this.ctx.currentTime;
        noteGain.gain.setValueAtTime(0.001, noteTime);
        noteGain.gain.linearRampToValueAtTime(0.15, noteTime + 0.04);
        noteGain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 0.9);
        osc.connect(noteGain);
        noteGain.connect(master);
        osc.start(noteTime);
        osc.stop(noteTime + 1.0);
      };
      playStep();
      const interval = window.setInterval(playStep, 600);
      this.activeNodes.push(interval);
    } else {
      // Classic rhythmic soft alert
      const playBeep = () => {
        if (!this.ctx || !this.isPlaying) return;
        const osc = this.ctx.createOscillator();
        const noteGain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        const now = this.ctx.currentTime;
        noteGain.gain.setValueAtTime(0.15, now);
        noteGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(noteGain);
        noteGain.connect(master);
        osc.start(now);
        osc.stop(now + 0.25);
      };
      playBeep();
      const interval = window.setInterval(playBeep, 1000);
      this.activeNodes.push(interval);
    }
  }

  // 1. Rain Sound Synthesis
  private startRain(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + 0.02 * white) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5;
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    // Filter to sound like soft rainfall against window
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;

    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 250;

    whiteNoise.connect(highpass);
    highpass.connect(filter);
    filter.connect(dest);
    whiteNoise.start();

    collect(whiteNoise, filter, highpass);

    // Random raindrops
    const dropInterval = window.setInterval(() => {
      if (!this.ctx || !this.isPlaying) return;
      const osc = this.ctx.createOscillator();
      const dropGain = this.ctx.createGain();
      const freq = 1200 + Math.random() * 1800;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.4, this.ctx.currentTime + 0.05);

      dropGain.gain.setValueAtTime(0.04 * (0.5 + Math.random() * 0.5), this.ctx.currentTime);
      dropGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.06);

      osc.connect(dropGain);
      dropGain.connect(dest);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.07);
    }, 180);

    collect(dropInterval);
  }

  // 2. Ocean Waves Synthesis
  private startOcean(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      output[i] *= 0.11;
      b6 = white * 0.115926;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;

    // LFO for surf wave surging rhythm (approx 0.12 Hz = 8 seconds per wave)
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.12;

    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 350;

    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    const waveGain = this.ctx.createGain();
    const lfoAmp = this.ctx.createOscillator();
    lfoAmp.frequency.value = 0.12;
    const lfoAmpGain = this.ctx.createGain();
    lfoAmpGain.gain.value = 0.35;
    waveGain.gain.value = 0.6;
    lfoAmp.connect(lfoAmpGain);
    lfoAmpGain.connect(waveGain.gain);

    noise.connect(filter);
    filter.connect(waveGain);
    waveGain.connect(dest);

    noise.start();
    lfo.start();
    lfoAmp.start();

    collect(noise, filter, lfo, lfoGain, waveGain, lfoAmp, lfoAmpGain);
  }

  // 3. Night Forest & Subtle Crickets
  private startForest(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;

    // Gentle night wind floor
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.04;
    }
    const wind = this.ctx.createBufferSource();
    wind.buffer = noiseBuffer;
    wind.loop = true;

    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 350;
    windFilter.Q.value = 1.2;

    wind.connect(windFilter);
    windFilter.connect(dest);
    wind.start();
    collect(wind, windFilter);

    // Cricket chirps generator
    const chirpTimer = window.setInterval(() => {
      if (!this.ctx || !this.isPlaying) return;
      if (Math.random() > 0.65) return;

      const osc = this.ctx.createOscillator();
      const chirpGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(4500 + Math.random() * 400, this.ctx.currentTime);

      chirpGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      chirpGain.gain.linearRampToValueAtTime(0.015, this.ctx.currentTime + 0.03);
      chirpGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.08);

      osc.connect(chirpGain);
      chirpGain.connect(dest);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.09);
    }, 320);

    collect(chirpTimer);
  }

  // 4. Pink / Deep White Noise
  private startPinkNoise(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      output[i] *= 0.15;
      b6 = white * 0.115926;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1600;

    noise.connect(filter);
    filter.connect(dest);
    noise.start();

    collect(noise, filter);
  }

  // 5. Tibetan Singing Bowl / Binaural Alpha Waves
  private startTibetanBowl(dest: AudioNode, collect: (...n: (AudioNode | number)[]) => void) {
    if (!this.ctx) return;

    // Resonant fundamental + harmonics
    const freqs = [216, 432, 648]; // warm harmonic series
    freqs.forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = freq + (idx === 1 ? 4 : 0); // 4Hz theta wave beating

      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.08;
      const lfoG = this.ctx.createGain();
      lfoG.gain.value = 0.05 / (idx + 1);

      lfo.connect(lfoG);
      lfoG.connect(gain.gain);

      gain.gain.value = 0.12 / (idx + 1);

      osc.connect(gain);
      gain.connect(dest);

      osc.start();
      lfo.start();
      collect(osc, gain, lfo, lfoG);
    });
  }
}

export const sleepAudio = new SleepAudioSynthesizer();
