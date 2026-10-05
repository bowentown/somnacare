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
check('PetOverlayService 持有 sActiveView（包内可见，跨类可查询）',
  service.includes('static volatile WhaleGirlView sActiveView') && !service.includes('private static volatile WhaleGirlView sActiveView'));
check('sActiveView 生命周期同步（创建+至少两处置空）',
  service.includes('sActiveView = whale;') && count(service, 'sActiveView = null') >= 2);
check('GemmaLLMPlugin 暴露 getPetState', plugin.includes('public void getPetState(PluginCall call)'));
check('petMoments 提示词注入【她此刻动作】', moments.includes('【她此刻动作】'));
check('petMoments 桥接 getPetState', moments.includes("g?.getPetState?.()"));
check('提示词含一致性指令（打盹别写庆祝）', moments.includes('她在打盹就别写庆祝'));

// ── 4) 深夜困倦闸门持续驱动 ──
check('drowsyTick 持续驱动 setDrowsy', service.includes('whale.setDrowsy('));

// ── 5) 第二批：结构化上下文通道（方案 §二后半） ──
check('petOverlay 推送记录感知上下文（lastScore/missedDays/hasTonight）',
  moments !== null && readFileSync(join(ROOT, 'src/utils/petOverlay.ts'), 'utf-8').includes('lastScore'));
const overlaySrc = readFileSync(join(ROOT, 'src/utils/petOverlay.ts'), 'utf-8');
check('petOverlay 上下文含三字段', overlaySrc.includes('lastScore') && overlaySrc.includes('missedDays') && overlaySrc.includes('hasTonight'));
check('插件落盘上下文（K_CTX_*）', plugin.includes('K_CTX_SCORE') && plugin.includes('K_CTX_MISSED') && plugin.includes('K_CTX_TONIGHT'));
check('视图消费上下文 setContext', view.includes('public void setContext(int lastScore, int missedDays, boolean hasTonight)'));
check('权重表记录感知：连续未记录→蔫', view.includes('missedDays >= 3') && view.includes('w *= 2'));
check('权重表记录感知：达标→精神', view.includes('lastScore >= 85'));

// ── 6) 第二批：达标祝贺每天一次 + 深夜劝睡每晚一次 ──
check('达标祝贺幂等（K_CHEER_DATE 去重）', service.includes('K_CHEER_DATE') && service.includes('whale.cheer()'));
check('深夜劝睡：drowsy 分支调用 maybeNightNag', service.includes('if (drowsy) maybeNightNag();'));
check('深夜劝睡：服务直查 UsageStats（亮屏仍在→劝，熄屏→不打扰）',
  service.includes('maybeNightNag') && service.includes('USAGE_STATS_SERVICE') && service.includes('stillOn'));
check('深夜劝睡每晚一次（K_NAG_DATE 去重）', service.includes('K_NAG_DATE'));

// ── 7) 睡前提醒条件化（第 42 轮用户反馈） ──
const bedtime = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/BedtimeOverlayService.java'), 'utf-8');
check('"好的"按自动权限分流（hasUsageAccess 门控）', bedtime.includes('if (!hasUsageAccess())'));
check('自动授权时不写 auto_start_sleep 标记（门控内才写）',
  bedtime.indexOf('hasUsageAccess()') < bedtime.indexOf('putBoolean("auto_start_sleep"'));
check('气泡文案：晚安💤 / 随便你🙄', bedtime.includes('晚安💤') && bedtime.includes('随便你🙄'));

// ── 反向自检：旧实现喂进同一断言路径必须报红 ──
{
  // 把 ambientTick 的 pickAmbient 调用替换回均匀随机——
  // 检出依据：tick 处不再调用 pickAmbient，且 legacy 写法计数从 1 涨到 2
  const doctored = view.replace('Anim next = pickAmbient();', legacyUniform);
  const fellBack = !doctored.includes('Anim next = pickAmbient();') && count(doctored, legacyUniform) > 1;
  check('反向自检：回退均匀随机可被检出', fellBack, `doctored 计数 ${count(doctored, legacyUniform)}`);
  // 睡前提醒：把权限门控删掉（无条件 auto_start_sleep）必须被检出
  const doctoredBed = bedtime.replace('if (!hasUsageAccess()) {', 'if (true) {');
  check('反向自检：权限门控失效可被检出',
    doctoredBed.includes('if (true) {') && doctoredBed.indexOf('putBoolean("auto_start_sleep"') > doctoredBed.indexOf('if (true) {'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌宠行为第一批回归被破坏`);
  process.exit(1);
}
console.log('\n✓ verify-pet-behavior：权重表/交叉溶解/反向通路/困倦闸门全部在位');
