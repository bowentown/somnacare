/**
 * AI 预设文案语料护栏（第 42 轮：用户抓到"心远地自偏，问君何能尔"诗序颠倒）。
 *
 * 语料 = 旅行明信片（travelPostcards.ts）+ 桌宠播报词库（petOverlay.ts）
 * + 本地评论池（petMoments.ts）。它们是"AI 人设"的骨架——模型生成内容
 * 每天在变，这些预设文案错一个字就是每天都在错。
 *
 * 四条不变量：
 *  1. 经典诗文引用必须与原文一致（学究人设"爱引经据典"——引错原句是
 *     双重人设破坏：既暴露 AI 痕迹又对不起 persona）；
 *  2. 地理/物种事实（越南会安≠淮河、阿拉斯加驼鹿≠麋鹿、坦桑尼亚卡片
 *     不挂肯尼亚公园名安博塞利）；
 *  3. 人设纪律：好友评论绝不盗用大肥鱼的自称"本鱼"；
 *  4. 数据纪律：播报词库不得主张应用没测过的数据（"翻了那么多次身"
 *     ——翻身从未被测量）。
 *
 * 方法论约束：反向自检——把坏文案喂进同一断言路径必须报红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const postcards = readFileSync(join(ROOT, 'src', 'data', 'travelPostcards.ts'), 'utf-8');
const petOverlay = readFileSync(join(ROOT, 'src', 'utils', 'petOverlay.ts'), 'utf-8');
const petMoments = readFileSync(join(ROOT, 'src', 'utils', 'petMoments.ts'), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1) 引用诗文以正确顺序存在 ──
const quotes: Array<[string, string]> = [
  ['问君何能尔，心远地自偏', '陶渊明《饮酒·其五》——曾是反向的'],
  ['曲径通幽处，禅房花木深', '常建《题破山寺后禅院》'],
  ['晚来天欲雪，能饮一杯无', '白居易《问刘十九》'],
  ['星汉灿烂，若出其里', '曹操《观沧海》'],
  ['天地有大美而不言', '庄子《知北游》'],
  ['念天地之悠悠，独怆然而涕下', '陈子昂《登幽州台歌》——曾是压缩变体'],
  ['醉后不知天在水，满船清梦压星河', '唐珙《题龙阳县青草湖》——替换查无出处的拼凑句'],
];
for (const [q, src] of quotes) {
  check(`引用正确：${q}（${src}）`, postcards.includes(q));
}
const badForms = [
  '心远地自偏，问君何能尔',   // 诗序颠倒（用户抓到的原始 bug）
  '漫漫平沙走白日',            // 查无出处的拼凑"诗句"
  '光影倒悬若神虚',
  '天地悠悠，独怆然而涕下',    // 与原文不符的压缩变体
];
for (const b of badForms) {
  check(`坏形态不回归：${b}`, !postcards.includes(b));
}

// ── 2) 地理/物种事实 ──
check('越南会安印章不写中国河流（淮河→会安）', !postcards.includes('淮河夜月') && postcards.includes('会安夜月丝灯印'));
check('阿拉斯加是驼鹿不是麋鹿', !postcards.includes('麋鹿') && postcards.includes('驼鹿'));
check('坦桑尼亚卡片不挂肯尼亚公园名（安博塞利）', !postcards.includes('安博塞利'));

// ── 3) 人设纪律：好友评论绝不自称"本鱼" ──
const friendComments = [...postcards.matchAll(/"friend":\s*"([^"]+)",\s*"text":\s*"([^"]+)"/g)];
const selfAddressed = friendComments.filter(([, , text]) => text.includes('本鱼'));
check(`明信片好友评论不盗用"本鱼"（扫描 ${friendComments.length} 条）`, selfAddressed.length === 0,
  selfAddressed.map((m) => m[1]).join('、'));
const AI_FRIENDS = ['楼下Claude', '美国豆包Gemini', '被压榨的Qwen', '被蒸馏的Kimi', '意难平的豆包姐姐'];
const unknownFriends = friendComments.filter(([, f]) => !AI_FRIENDS.includes(f));
check(`好友都在花名册内（${AI_FRIENDS.length} 人）`, unknownFriends.length === 0, unknownFriends.map((m) => m[1]).join('、'));
// 本地兜底评论池同纪律：截取 LOCAL_COMMENTS 块检查
const lcStart = petMoments.indexOf('const LOCAL_COMMENTS');
const lcEnd = petMoments.indexOf('const friends =', lcStart);
const localPool = lcStart >= 0 && lcEnd > lcStart ? petMoments.slice(lcStart, lcEnd) : '';
check('本地评论池不盗用"本鱼"', localPool.length > 0 && !localPool.includes('本鱼'));

// ── 4) 播报词库数据纪律 ──
check('播报词库无未测量的"翻身"主张', !petOverlay.includes('翻了那么多次身'));
// 混排顺序：时间性问候（首行按当前时段实时生成）必须置顶——
// 缓存 LLM 语录排最前会把时段问候挤到十几次点击之后
check('混排顺序：时段问候置顶，LLM 语录紧随', /localLines\[0\], \.\.\.cached, \.\.\.localLines\.slice\(1, 3\)/.test(petOverlay));

// ── 5) 桌宠语录时间纪律（用户实测："23:30 到了"在 23:24 被播出）──
// LLM 语录缓存 20h 全天轮播——写死钟点的台词只在一天的几分钟里成立。
// 三层防线：生成提示词禁止钟点 / 生成层过滤 / 显示层过滤（对旧缓存立即生效）
const petMomentsSrc = readFileSync(join(ROOT, 'src', 'utils', 'petMoments.ts'), 'utf-8');
check('LLM 语录：生成提示词禁止写死钟点', petMomentsSrc.includes('禁止写死具体钟点'));
const clockFilterSites = petMomentsSrc.split('[:：]\\d{2}').length - 1;
check('LLM 语录：钟点台词在生成层与显示层各有过滤（≥2 处）', clockFilterSites >= 2, `实际 ${clockFilterSites} 处`);

// ── 反向自检：坏文案喂进同一断言路径必须报红 ──
{
  const doctored = postcards.replace('问君何能尔，心远地自偏', '心远地自偏，问君何能尔');
  if (!badForms.some((b) => doctored.includes(b))) {
    check('反向自检：诗序颠倒被检出', false);
  } else {
    check('反向自检：诗序颠倒可被检出', true);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——预设文案语料违反人设/事实纪律`);
  process.exit(1);
}
console.log('\n✓ verify-pet-copy：诗文引用/地理物种/人设自称/数据纪律全部符合');
