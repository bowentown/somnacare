/**
 * 护栏：评估提示词不得携带用户凭据（第 92 轮）。
 *
 * 背景：aiConfig 里有 deepseekApiKey / customApiKey，序列化 userProfile 时
 * 极易把密钥写进提示词发给模型服务方——自建端点场景即泄露给第三方。
 * 第 33 轮在服务端修过一次，但当时没有护栏；第 91 轮把提示词抽成共用构造器
 * 后，直连云端与服务端代理走同一条路径：一处漏剥就是两条路都漏。
 *
 * 为什么是行为断言：文本在场检查看不出"剥了没剥"——`safeProfile` 这个名字
 * 还在，密钥却已经在串里了。这里 import 真实构造器、喂带密钥的档案，
 * 直接断言输出内容。
 *
 * 结构性边界：剥离是【单字段黑名单】（只摘 aiConfig）。UserProfile 目前也
 * 只有 aiConfig 一个凭据字段（HF token 存独立 storage 键，不在档案里），
 * 所以成立——但若日后给 UserProfile 加了别的密钥字段，黑名单不会自动跟上。
 * 下面按类型定义做一条漂移断言，把它变成必须处理的红。
 *
 * 方法论约束：护栏必须能反向验证——去掉剥离逻辑必须报红
 * （已登记在 tools/mutate-guards.mts 的变异表里，可重复验证）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { buildAnalysisPrompts } = await import(
  new URL('../src/utils/clinicalAnalysisPrompt.ts', import.meta.url).href
);

const DEEPSEEK_KEY = 'sk-SECRET-deepseek';
const CUSTOM_KEY = 'ck-SECRET-custom';

const profile = {
  name: '鱼片',
  age: 30,
  targetDurationHours: 8,
  aiConfig: {
    provider: 'deepseek',
    deepseekApiKey: DEEPSEEK_KEY,
    customApiKey: CUSTOM_KEY,
    customBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-flash',
  },
};
const logs = [{ date: '2026-10-20', bedtime: '23:30', wakeTime: '07:30', durationMinutes: 480 }];

const { systemPrompt, userPrompt } = buildAnalysisPrompts(logs, profile);
const blob = systemPrompt + '\n' + userPrompt;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const CREDENTIAL = /token|secret|apikey|credential/i;
const leaks = (text: string): boolean =>
  [DEEPSEEK_KEY, CUSTOM_KEY].some((s) => text.includes(s)) || text.includes('aiConfig');

check('提示词不含 DeepSeek 密钥', !blob.includes(DEEPSEEK_KEY));
check('提示词不含自建 API 密钥', !blob.includes(CUSTOM_KEY));
check('提示词不含 aiConfig 容器（整块不进提示词）', !blob.includes('aiConfig'));
check('健康字段仍在（不是把整个档案都丢了）',
  blob.includes('"age":30') && blob.includes('"targetDurationHours":8'));
check('真实记录仍进提示词（评估需要数据，不能因剥离而空转）',
  blob.includes('2026-10-20') && blob.includes('23:30'));
check('评估契约仍在（system 段完整，不是被截断的空串）',
  systemPrompt.length > 1000 && systemPrompt.includes('JSON'));

// ── 结构性：UserProfile 的凭据字段只有 aiConfig（黑名单不会自动跟上新字段）──
{
  const typesSrc = readFileSync(join(ROOT, 'src/types/sleep.ts'), 'utf-8');
  const start = typesSrc.indexOf('export interface UserProfile');
  const body = typesSrc.slice(typesSrc.indexOf('{', start), typesSrc.indexOf('\n}', start));
  const fields = [...body.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1]);
  const suspicious = fields.filter((f) => CREDENTIAL.test(f));
  check(`UserProfile 无 aiConfig 之外的凭据字段（共 ${fields.length} 项）`,
    fields.length > 0 && suspicious.length === 0, suspicious.join('、') || '无');
  // 反向自检：往字段表里塞一个凭据字段必须被同一判据检出
  check('反向自检：新增凭据字段可被检出',
    ['name', ...fields, 'hfToken'].filter((f) => CREDENTIAL.test(f)).length === 1);
}

// 反向自检：判据必须能识别泄漏样本（否则"没报红"可能只是判据恒真）
check('反向自检：判据能识别泄漏样本、且放行真实输出',
  leaks(JSON.stringify(profile)) && !leaks(blob));

if (failures > 0) {
  console.error(`\n${failures} 项失败——提示词凭据剥离不符`);
  process.exit(1);
}
console.log('\n✓ verify-llm-privacy：评估提示词零凭据（含反向自检）');
