/**
 * 护栏：就诊摘要主题化 + 桌宠避让（第 64 轮）。
 *
 * 用户反馈：摘要固定暖白纸面，在暗色主题里突兀；原生桌宠悬浮窗还会
 * 压在全屏弹窗上。本护栏钉住：
 *  - Canvas 从 theme.pageBg/cardBg/cardInnerBg/accentHex 取色；
 *  - 不再出现旧暖纸常量；
 *  - 弹窗打开/关闭时调用 petSetVisible 临时隐藏/恢复桌宠；
 *  - TS/Java 两侧桥接存在。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
};

const card = read('src/utils/clinicalSummaryCard.ts');
const modal = read('src/components/ClinicalSummaryModal.tsx');
const shareModal = read('src/components/ShareCardModal.tsx');
const petTs = read('src/utils/petOverlay.ts');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const petService = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/PetOverlayService.java');

ok('摘要卡：从主题解析页面/卡片/面板/强调色',
  card.includes('paletteFor(input.theme')
  && card.includes('theme?.pageBg')
  && card.includes('theme?.cardBg')
  && card.includes('theme?.cardInnerBg')
  && card.includes('theme?.accentHex'));
ok('摘要卡：不再使用固定暖白纸面',
  !card.includes('#F5F0E6')
  && !card.includes('#FFFDF8')
  && card.includes('const ACCENT = P.accent'));
ok('摘要卡：图表条/目标带使用主题强调色的浅色变体',
  card.includes('accentBar')
  && card.includes('accentSoft')
  && card.includes('mixHex')
  && card.includes('rgbaHex'));
ok('弹窗：把 theme 传入 Canvas，并在主题变化时重绘',
  modal.includes('renderClinicalSummary({ records, includeTimes, theme })')
  && modal.includes('}, [open, includeTimes, records, theme]);'));
ok('弹窗：打开时收起桌宠，关闭时恢复（摘要 + 分享卡）',
  modal.includes('setPetOverlayVisible(false)')
  && modal.includes('setPetOverlayVisible(true)')
  && shareModal.includes('setPetOverlayVisible(false)')
  && shareModal.includes('setPetOverlayVisible(true)'));
ok('弹窗：预览可放大，避免缩略图里字太小',
  modal.includes('放大查看就诊摘要')
  && modal.includes('就诊摘要大图')
  && modal.includes('w-[720px]'));
ok('桥接：TS petSetVisible + Java 插件 + 服务显隐',
  petTs.includes('setPetOverlayVisible')
  && petTs.includes('petSetVisible')
  && plugin.includes('public void petSetVisible')
  && petService.includes('static void setAppVisible'));

// 反向自检：删掉 theme.accentHex 后，主题取色判据必须失去
{
  const doctored = card.replace('theme?.accentHex', '');
  ok('反向自检：删除主题强调色后判据不再成立', !doctored.includes('theme?.accentHex'));
}

// ── 第 90 轮 M-1：作息带时间轴窗口（真行为护栏）──
// 面板标题与刻度此前写死 20:00–10:00 / 5 个钟点，而窗口已自适应（D6）：
// 白天作息（08:30→16:30）时标题骗人、刻度被画到轴外（负坐标溢出面板左侧）。
// 这里 import 真实模块跑数据——文本在场检查覆盖不到"窗口变了但刻度没跟着变"。
{
  const { axisWindow } = await import('../src/utils/clinicalSummaryCard');
  const night = [
    { bedtime: '23:30', wakeTime: '07:30' },
    { bedtime: '23:50', wakeTime: '07:10' },
    { bedtime: '23:10', wakeTime: '07:40' },
  ];
  const day = [
    { bedtime: '08:30', wakeTime: '16:30' },
    { bedtime: '08:50', wakeTime: '16:10' },
    { bedtime: '08:10', wakeTime: '16:40' },
  ];
  const avgBedOf = (rows: Array<{ bedtime: string }>): number => {
    const [h, m] = rows[0].bedtime.split(':').map(Number);
    return h * 60 + m;
  };
  const inWindow = (w: { rangeStart: number; rangeMin: number }, minute: number): boolean =>
    minute >= w.rangeStart && minute <= w.rangeStart + w.rangeMin;

  const wn = axisWindow(night, avgBedOf(night));
  const wd = axisWindow(day, avgBedOf(day));

  ok('时间轴：窗口内的刻度全部落在轴上（夜间作息）',
    wn.ticks.length >= 3 && wn.ticks.every((t) => inWindow(wn, t.minute)));
  ok('时间轴：窗口内的刻度全部落在轴上（白天作息）',
    wd.ticks.length >= 3 && wd.ticks.every((t) => inWindow(wd, t.minute)));
  const clockOf = (m: number): string => {
    const v = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  };
  ok('时间轴：标题由窗口生成而非写死 20:00–10:00',
    wn.label !== '20:00 — 10:00' && wd.label !== '20:00 — 10:00'
    && wn.label === `${clockOf(wn.rangeStart)} — ${clockOf(wn.rangeStart + wn.rangeMin)}`
    && wd.label === `${clockOf(wd.rangeStart)} — ${clockOf(wd.rangeStart + wd.rangeMin)}`);
  ok('时间轴：刻度标签与 minute 自洽（标签=钟点回写）',
    wd.ticks.every((t) => {
      const v = ((t.minute % 1440) + 1440) % 1440;
      return t.label === `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    }));
  // 窗口必须【贴合数据】——上面几条只验"刻度在轴内 + 标签自洽"，把窗口
  // 恒设成 24 小时也全都绿灯（第 96 轮变异实测：rangeMin 被钉成 1440 时
  // 护栏仍 exit 0）。作息跨度约 8 小时，留边距后应远小于一天。
  ok('时间轴：窗口贴合数据长度（两种作息都 < 16 小时，不退化成整天）',
    wn.rangeMin < 16 * 60 && wd.rangeMin < 16 * 60,
    `night=${wn.rangeMin}min day=${wd.rangeMin}min`);
  // 反向自检：旧写死刻度在白天窗口下必须大面积出轴（这正是 M-1 的现象）
  {
    const hardcoded = [20 * 60, 23 * 60, 26 * 60, 29 * 60, 32 * 60];
    const out = hardcoded.filter((m) => !inWindow(wd, m)).length;
    ok('反向自检：写死 20:00–08:00 刻度在白天窗口下 ≥4 个出轴', out >= 4);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——就诊摘要主题化护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-clinical-theme：主题取色 / 暗色报告 / 桌宠避让 / 作息轴窗口全部在位');
