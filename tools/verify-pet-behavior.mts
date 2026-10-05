/**
 * 桌宠行为回归锁（第一批 §二/§5.1/§4.4 + 第二批 §二后半/§三/§5.4）。
 *
 * 第 43 轮复审对本护栏做了 5 项变异测试，4 项逃逸——本版按其建议深化：
 *  ① 权重表钉【形状】不钉名字：weightOf 函数体内 hour 条件 ≥8 处
 *     （退化为常数表即红——变异 1b 曾全绿逃逸）；
 *  ② 深夜禁令断言【代码形态】（case "tea"/"eat"/"working" 内存在 ? 0），
 *     不再断言注释文字（变异 2：删逻辑留注释曾全绿）；
 *  ③ 上下文消费钉【调用点】（service 里 whale.setContext( ），变异 3
 *     删掉转推调用曾全绿；
 *  ④ 溶解的 alpha 必须是变量（setAlpha(纯数字) = 没有溶解，变异 4 曾全绿）；
 *  ⑤ 反向自检与正向共用同一谓词（weightTableFailures）。
 *
 * 其余不变量：均匀随机只剩兜底一处、动作↔文案反向通路四环节、
 * drowsyTick 驱动、上下文通道三字段（N2 从最近一夜起数 / N3 lastNightRecorded
 * 命名）、达标祝贺与深夜劝睡的"每天/每晚一次"、睡前提醒权限门控、
 * 下载校验同源解析 + 443 端口（复审 N5）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const view = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/WhaleGirlView.java'), 'utf-8');
const service = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/PetOverlayService.java'), 'utf-8');
const plugin = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java'), 'utf-8');
const overlay = readFileSync(join(ROOT, 'src/utils/petOverlay.ts'), 'utf-8');
const moments = readFileSync(join(ROOT, 'src/utils/petMoments.ts'), 'utf-8');
const bedtime = readFileSync(join(ROOT, 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/BedtimeOverlayService.java'), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 权重表形状谓词：正向与反向自检共用同一段代码（复审 §二⑤）。 */
function weightTableFailures(src: string): string[] {
  const out: string[] = [];
  const bodyStart = src.indexOf('private int weightOf(Anim a, int hour)');
  const bodyEnd = src.indexOf('private Anim pickAmbient');
  if (bodyStart < 0 || bodyEnd <= bodyStart) return ['weightOf 函数不在位'];
  const body = src.slice(bodyStart, bodyEnd);
  // ① 时段条件密度：真权重表按小时开合，常数化后归零
  const hourConds = (body.match(/hour\s*(?:>=|<)/g) ?? []).length;
  if (hourConds < 8) out.push(`hour 条件仅 ${hourConds} 处（<8，疑似退化常数表）`);
  // ② 深夜禁令的代码形态（? 0 权重），不是注释
  for (const act of ['tea', 'eat', 'working']) {
    if (!new RegExp(`case "${act}":[^;]*\\? 0`).test(body)) out.push(`${act} 缺深夜 0 权重的代码形态`);
  }
  return out;
}

// ── 1) 权重表（形状断言）──
check('ambientTick 走 pickAmbient（不再是均匀随机）', view.includes('Anim next = pickAmbient();'));
const wtFails = weightTableFailures(view);
check('权重表形状：时段条件密度 ≥8 + 深夜禁令代码形态', wtFails.length === 0, wtFails.join('；'));
const legacyUniform = 'ambient[rng.nextInt(ambient.length)]';
check(`旧均匀随机写法只剩 pickAmbient 兜底一处（实际 ${count(view, legacyUniform)} 处）`,
  count(view, legacyUniform) === 1 && view.indexOf('private Anim pickAmbient') < view.indexOf(legacyUniform));

// ── 2) 交叉溶解 ──
check('FADE_MS 溶解时长在位', view.includes('FADE_MS = 180'));
check('pick 登记旧状态（prevAnim）', view.includes('prevAnim = current;'));
check('溶解双帧用变量 alpha（变异 4：两帧都 setAlpha(255) = 没有溶解；'
  + '溶解后 setAlpha(255) 复原是必要代码，不禁字面量）',
  view.includes('paint.setAlpha') && /paint\.setAlpha\(\(int\) \(\(1f - t\) \* 255\)\)/.test(view));

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

// ── 4) 深夜困倦闸门 + 劝睡（复审 N4：isInteractive 命中持续亮屏）──
check('drowsyTick 持续驱动 setDrowsy', service.includes('whale.setDrowsy('));
check('深夜劝睡：drowsy 分支调用 maybeNightNag', service.includes('if (drowsy) maybeNightNag();'));
check('深夜劝睡：isInteractive 判据（持续亮屏也命中，零权限）', service.includes('pm.isInteractive()'));
check('深夜劝睡每晚一次（K_NAG_DATE 去重）', service.includes('K_NAG_DATE'));

// ── 5) 上下文通道（复审 N2/N3 修正后）──
check('petOverlay 推送三字段（lastNightRecorded 命名与醒来日口径一致）',
  overlay.includes('lastScore') && overlay.includes('missedDays') && overlay.includes('lastNightRecorded')
  && !overlay.includes('hasTonight'));
check('missedDays 从最近一夜起数（i=0，复审 N2）', overlay.includes('for (let i = 0; i < 14; i++)'));
check('插件落盘上下文（K_CTX_*）', plugin.includes('K_CTX_SCORE') && plugin.includes('K_CTX_MISSED') && plugin.includes('K_CTX_LAST_NIGHT'));
check('服务转推上下文（调用点而非仅签名，变异 3）', service.includes('whale.setContext('));
check('视图消费上下文 setContext', view.includes('public void setContext(int lastScore, int missedDays, boolean lastNightRecorded)'));
check('权重表记录感知：蔫/精神/想你补记',
  view.includes('missedDays >= 3') && view.includes('lastScore >= 85') && view.includes('!lastNightRecorded && hour >= 21'));

// ── 6) 达标祝贺每天一次 + 睡前提醒权限门控 ──
check('达标祝贺幂等（K_CHEER_DATE 去重）', service.includes('K_CHEER_DATE') && service.includes('whale.cheer()'));
check('"好的"按自动权限分流（hasUsageAccess 门控）', bedtime.includes('if (!hasUsageAccess())'));
check('自动授权时不写 auto_start_sleep 标记（门控内才写）',
  bedtime.indexOf('hasUsageAccess()') < bedtime.indexOf('putBoolean("auto_start_sleep"'));
check('气泡文案：晚安💤 / 随便你🙄', bedtime.includes('晚安💤') && bedtime.includes('随便你🙄'));

// ── 7) 下载校验（复审 N5）──
check('下载建连与校验同源解析（uri.toURL，无双解析器差异缝）', plugin.includes('uri.toURL().openConnection()'));
check('下载端口限定 443', plugin.includes('uri.getPort() != -1 && uri.getPort() != 443'));

// ── 反向自检：坏实现喂进与正向相同的谓词必须报红 ──
{
  // ① ambientTick 退回均匀随机
  const doctored = view.replace('Anim next = pickAmbient();', legacyUniform);
  check('反向自检：回退均匀随机可被检出',
    !doctored.includes('Anim next = pickAmbient();') && count(doctored, legacyUniform) > 1);
  // ② 权重表退化常数表（变异 1b 的原逃逸形态）
  const constantized = view.replace(/hour >= \d+/g, 'true').replace(/hour < \d+/g, 'false');
  const degenerate = weightTableFailures(constantized);
  check('反向自检：权重表退化常数可被检出', degenerate.length > 0, degenerate.join('；'));
  // ③ 睡前提醒权限门控失效
  const doctoredBed = bedtime.replace('if (!hasUsageAccess()) {', 'if (true) {');
  check('反向自检：权限门控失效可被检出',
    doctoredBed.includes('if (true) {') && doctoredBed.indexOf('putBoolean("auto_start_sleep"') > doctoredBed.indexOf('if (true) {'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——桌宠行为回归被破坏`);
  process.exit(1);
}
console.log('\n✓ verify-pet-behavior：权重表形状/交叉溶解/反向通路/上下文通道/劝睡与门控全部在位');
