/**
 * 护栏：分享卡的画布隐私（第 19 轮 §1.2 落地；第 93 轮补行为层）。
 *
 * 分享卡会发到微信群，因此绝不允许出现作息指纹/私密字段：具体就寝/起床
 * 时刻、梦境笔记、心情、习惯、精确日期。只允许消费聚合结果
 * （computeRegularity 的偏差分钟数 / 平均时长）。
 *
 * 两层：
 *  1. 源码扫描——sleepShareCard.ts 不得出现禁字段名，且必须走聚合通路；
 *  2. 【行为层，第 93 轮】桩一个记录型 2D 上下文，真跑 renderWeeklyCard，
 *     断言"画出来的每一串文字"都不含钟点。源码扫描只证明"没写 bedtime
 *     这个词"，证明不了成品图上没有钟点——经过格式化/拼接的泄漏它看不见
 *     （例如把就寝时刻 format 成字符串再画）。行为层直接验成品。
 *
 * 方法论约束：两层都必须能反向验证——注入 dreamNotes / 往输出里塞钟点，
 * 对应判据必须报红。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TARGET = fileURLToPath(new URL('../src/utils/sleepShareCard.ts', import.meta.url));

// 禁止出现的字段/短语（作息指纹与私密内容）
const FORBIDDEN = ['bedtime', 'wakeTime', 'dreamNotes', 'mood', 'coffee', 'habits', 'deepSleepMinutes'];
// 必须出现的聚合来源（证明走的是合规通路）
const REQUIRED = ['computeRegularity', '近 7 晚'];

const text = readFileSync(TARGET, 'utf-8');
let failures = 0;
const bad = (msg: string) => { failures++; console.error('✗ ' + msg); };

for (const f of FORBIDDEN) {
  if (text.includes(f)) {
    const line = text.slice(0, text.indexOf(f)).split('\n').length;
    bad(`sleepShareCard.ts:${line} 出现作息指纹/私密字段「${f}」——分享卡只允许聚合数字`);
  }
}
for (const r of REQUIRED) {
  if (!text.includes(r)) {
    bad(`sleepShareCard.ts 缺少聚合来源「${r}」——不允许直接消费单晚记录`);
  }
}

// 反向自检：注入 dreamNotes 必须被检出
const probeBackup = text;
try {
  writeFileSync(TARGET, text + '\n// __probe__ dreamNotes\n');
  if (!readFileSync(TARGET, 'utf-8').includes('dreamNotes')) {
    bad('verify-share-privacy：自检失败——注入的私密字段未被检出');
  }
} finally {
  writeFileSync(TARGET, probeBackup);
}

// ── 行为层：真跑绘制，验成品图上的文字 ──
{
  /** 判据（正反两面共用）：任一串画出来的文字含 HH:MM 即视为泄漏 */
  const leaksClock = (texts: string[]): boolean => texts.some((t) => /\d{1,2}:\d{2}/.test(t));

  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  // 解锁一张真实存在的明信片 → imgUrl 走 chosen.imageUrl，绕开
  // `${import.meta.env.BASE_URL}`（Node 下 import.meta.env 不存在）
  store.set('somnacare_travel_state', JSON.stringify({ unlockedCardIds: ['card-asia-01'] }));

  const drawn: string[] = [];
  const ctxStub: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return (s: unknown) => ({ width: String(s).length * 26 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} });
      if (prop === 'fillText') return (s: unknown) => { drawn.push(String(s)); };
      return () => {};   // save/restore/clip/fillRect/beginPath/arcTo/drawImage… 一律 no-op
    },
    set: () => true,     // fillStyle/font/textAlign/… 只赋值不读取
  });
  const canvasStub: any = {
    width: 0, height: 0,
    getContext: () => ctxStub,
    toBlob: (cb: (b: unknown) => void) => cb({ size: 1 }),
  };
  (globalThis as any).document = { createElement: () => canvasStub };
  (globalThis as any).FileReader = class {
    result: unknown = 'data:image/jpeg;base64,AA';
    onload: (() => void) | null = null;
    readAsDataURL() { this.onload?.(); }
  };
  // 同源 fetch → Blob → createImageBitmap（不给 createImageBitmap 会退到 Image 分支）
  (globalThis as any).fetch = async () => ({ blob: async () => ({ size: 1 }) });
  (globalThis as any).createImageBitmap = async () => ({ width: 1080, height: 1440 });

  const { renderWeeklyCard } = await import(new URL('../src/utils/sleepShareCard.ts', import.meta.url).href);

  const rec = (bedtime: string, wakeTime: string, i: number) => ({
    id: 'r' + i, date: `2026-10-0${i + 1}`, bedtime, wakeTime,
    durationMinutes: 470, deepSleepMinutes: 90, lightSleepMinutes: 300,
    remSleepMinutes: 70, awakeMinutes: 10, sleepScore: 86, sleepEfficiency: 91,
    latencyMinutes: 12, wakeCount: 1,
  });
  // 起卧时刻刻意取"不像整点"的值：一旦被格式化画上去，HH:MM 一定命中
  const BEDTIMES = ['23:47', '00:13', '23:58'];
  const WAKETIMES = ['07:31', '07:05', '07:44'];

  const result = await renderWeeklyCard({
    records: [rec('23:47', '07:31', 0), rec('00:13', '07:05', 1), rec('23:58', '07:44', 2)],
    accentHex: '#6366f1',
    pageBgHex: '#0B1026',
    showRegularity: true,
    showDuration: true,
  });

  const drewAggregate =
    drawn.some((t) => t.includes('作息规律度')) && drawn.some((t) => t.includes('平均睡眠时长'));

  if (!drewAggregate) {
    bad(`行为层未真正绘制（只捕获到 ${drawn.length} 串文字）——桩失效会让断言空跑`);
  }
  if (leaksClock(drawn)) {
    bad(`成品图出现钟点：${drawn.filter((t) => /\d{1,2}:\d{2}/.test(t)).join(' | ')}`);
  }
  const literal = [...BEDTIMES, ...WAKETIMES].filter((t) => drawn.some((d) => d.includes(t)));
  if (literal.length > 0) {
    bad(`成品图直接画出了记录的起卧时刻：${literal.join('、')}`);
  }
  // 聚合值仍在（隐私不等于把数据全删空）
  if (!(result.avgDurationMin === 470 && result.regularity !== null)) {
    bad(`聚合结果缺失（avgDurationMin=${result.avgDurationMin}, regularity=${result.regularity === null ? 'null' : 'ok'}）`);
  }
  // 反向自检：判据必须能识别"把钟点画上去"的输出
  if (!leaksClock([...drawn, '就寝 23:47'])) {
    bad('反向自检失败：判据无法识别含钟点的输出（断言可能恒真）');
  }
}

if (failures > 0) {
  console.error('   规则：分享卡只放聚合数字，作息指纹与私密内容禁止上画布');
  process.exit(1);
}
console.log(`✓ verify-share-privacy：分享卡无作息指纹（源码禁 ${FORBIDDEN.length} 项 + 成品图零钟点，含反向自检）`);
