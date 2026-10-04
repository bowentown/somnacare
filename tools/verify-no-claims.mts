/**
 * 护栏：禁止临床/因果声称（must-not-write 清单的执行形态）。
 *
 * 背景：这些红线此前只存在于设计文档里，没有护栏——文案会被改，
 * 护栏不会静默失效。本 App 的诚实边界：所有数字都是模型估算/统计量，
 * 不是医疗结论；规律性文献结论留在文档，不进 App 文案。
 *
 * 扫描范围：src/ 全部 ts/tsx（字面匹配，含注释——防止注释里的措辞
 * 被复制进文案）。
 *
 * 方法论约束：护栏必须能反向验证——往临时文件写禁语必须报红。
 */
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '');
// server.ts 同在扫描范围（第 31 轮 F2）：里面有 2000+ 字用户可见的问答文案，
// 曾在护栏盲区里出现"根据您的近期数据（深睡约90分钟）"式编造——
// 禁语清单对 server.ts 同样适用（当前无命中，纳入是防复发）
const SERVER = fileURLToPath(new URL('../server.ts', import.meta.url));

// 禁止出现的表述（精确短语；"临床睡眠医学顾问"这类身份词不在其列）
const FORBIDDEN = [
  '研究证明',
  '临床级',
  'AASM',
  'FDA',
  '降低死亡风险',
  '延长寿命',
  '治愈失眠',
  '治疗失眠',
  '符合医学标准',
  '监测到你的睡眠',   // 使用行为数据语境（P3）：行为性 ≠ 生理性
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

let failures = 0;
for (const f of [...listFiles(SRC), SERVER]) {
  const text = readFileSync(f, 'utf-8');
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase)) {
      failures++;
      const line = text.slice(0, text.indexOf(phrase)).split('\n').length;
      console.error(`✗ ${f.split('/').pop()}:${line} 出现禁止表述「${phrase}」`);
    }
  }
}

// 反向自检：写一个含禁语的临时文件必须被扫出
const probe = join(SRC, '__claims_probe__.ts');
try {
  writeFileSync(probe, 'export const x = "研究证明规律睡眠降低死亡风险";\n');
  const probeHits = listFiles(SRC)
    .map((f) => ({ f, t: readFileSync(f, 'utf-8') }))
    .filter(({ t }) => FORBIDDEN.some((p) => t.includes(p)));
  if (probeHits.length === 0) {
    console.error('✗ verify-no-claims：自检失败——构造的禁语未被检出，护栏已失效');
    failures++;
  }
} finally {
  try { unlinkSync(probe); } catch { /* ignore */ }
}

// 定向扫描：使用行为信号文件（P3）——"放下手机 ≠ 入睡"的红线，
// 这些文件里连注释都不允许出现入睡/醒来类生理措辞（防复制进文案）
{
  const usageFile = join(SRC, 'usageSignal.ts');
  try {
    const t = readFileSync(usageFile, 'utf-8');
    for (const phrase of ['入睡', '你夜间醒来', '睡眠监测']) {
      if (t.includes(phrase)) {
        failures++;
        const line = t.slice(0, t.indexOf(phrase)).split('\n').length;
        console.error(`✗ usageSignal.ts:${line} 使用行为文件出现生理性措辞「${phrase}」（放下手机 ≠ 入睡）`);
      }
    }
  } catch { /* 文件不存在时由 verify-wiring 报告 */ }
}

if (failures > 0) {
  console.error('   规则：数字是模型估算/统计量，不是医疗结论；文献结论不进 App 文案');
  process.exit(1);
}
console.log(`✓ verify-no-claims：src/ 与 server.ts 无临床/因果声称（禁语 ${FORBIDDEN.length} 条，含反向自检）`);
