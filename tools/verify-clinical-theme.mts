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
const ok = (name: string, condition: boolean): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}`);
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

if (failures > 0) {
  console.error(`\n${failures} 项失败——就诊摘要主题化护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-clinical-theme：主题取色 / 暗色报告 / 桌宠避让全部在位');
