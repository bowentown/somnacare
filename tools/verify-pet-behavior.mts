/**
 * 桌宠行为第一批回归锁（第 42 轮，行为方案 §二/§5.1/§4.4 落地）：
 *
 *  1. 环境动作不再均匀随机——ambientTick 走 pickAmbient()（时段权重表）；
 *     权重全 0 的兜底路径允许出现一次，旧写法全文件只许这一处。
 *  2. 状态切换有交叉溶解（FADE_MS / prevAnim / setAlpha 双帧）——
 *     硬切是"贴图换位"，溶解才是"角色在动"。
 *  3. 动作↔文案反向通路：currentAnimName → sActiveView → getPetState
 *     → petMoments 提示词【她此刻动作】。
 *  4. drowsyTick 持续驱动 setDrowsy（深夜 23-06 关停小动作的闸门）。
 *
 * 方法论约束：反向自检——伪造旧实现喂进同一断言路径必须报红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const view = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/WhaleGirlView.java'), 'utf-8');
const service = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/PetOverlayService.java'), 'utf-8');
const plugin = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java'), 'utf-8');
const moments = readFileSync(join(ROOT, 'src/utils/petMoments.ts'), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

// ── 1) 权重表 ──
check('ambientTick 走 pickAmbient（不再是均匀随机）', view.includes('Anim next = pickAmbient();'));
check('weightOf 权重表在位', view.includes('private int weightOf(Anim a, int hour)'));
check('权重表含深夜禁令（深夜不喝茶/吃饭/上班）', view.includes('深夜不喝茶'));
const legacyUniform = 'ambient[rng.nextInt(ambient.length)]';
check(`旧均匀随机写法只剩 pickAmbient 兜底一处（实际 ${count(view, legacyUniform)} 处）`,
  count(view, legacyUniform) === 1 && view.indexOf('private Anim pickAmbient') < view.indexOf(legacyUniform));

// ── 2) 交叉溶解 ──
check('FADE_MS 溶解时长在位', view.includes('FADE_MS = 180'));
check('pick 登记旧状态（prevAnim）', view.includes('prevAnim = current;'));
check('溶解双帧绘制（setAlpha）', view.includes('paint.setAlpha'));

// ── 3) 动作↔文案反向通路 ──
check('WhaleGirlView 暴露 currentAnimName', view.includes('public String currentAnimName()'));
check('PetOverlayService 持有 sActiveView', service.includes('private static volatile WhaleGirlView sActiveView'));
check('sActiveView 生命周期同步（创建+至少两处置空）',
  service.includes('sActiveView = whale;') && count(service, 'sActiveView = null') >= 2);
check('GemmaLLMPlugin 暴露 getPetState', plugin.includes('public void getPetState(PluginCall call)'));
check('petMoments 提示词注入【她此刻动作】', moments.includes('【她此刻动作】'));
check('petMoments 桥接 getPetState', moments.includes("g?.getPetState?.()"));
check('提示词含一致性指令（打盹别写庆祝）', moments.includes('她在打盹就别写庆祝'));

// ── 4) 深夜困倦闸门持续驱动 ──
check('drowsyTick 持续驱动 setDrowsy', service.includes('whale.setDrowsy('));

// ── 反向自检：旧实现喂进同一断言路径必须报红 ──
{
  // 把 ambientTick 的 pickAmbient 调用替换回均匀随机——
  // 检出依据：tick 处不再调用 pickAmbient，且 legacy 写法计数从 1 涨到 2
  const doctored = view.replace('Anim next = pickAmbient();', legacyUniform);
  const fellBack = !doctored.includes('Anim next = pickAmbient();') && count(doctored, legacyUniform) > 1;
  check('反向自检：回退均匀随机可被检出', fellBack, `doctored 计数 ${count(doctored, legacyUniform)}`);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌宠行为第一批回归被破坏`);
  process.exit(1);
}
console.log('\n✓ verify-pet-behavior：权重表/交叉溶解/反向通路/困倦闸门全部在位');
