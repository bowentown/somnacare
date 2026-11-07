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
  '正在拉低',
  '会推迟夜间睡眠压力',
  // 第 135 轮补充（审查 P1-1 实测在 server.ts 命中的机制声称/伪测量措辞）：
  '床品摩擦',
  '周期性包络',
  '脑脊液',
  '淀粉样蛋白',
  '临床推荐健康值',
  '残余昏睡感',
  '医学研究表明',
  '声波的微小周期性起伏',
];

// 语义族（第 135 轮）：精确短语挡不住"换个说法"，共现形态才稳定——
// 声音/麦克风 与 分期判断 共现、脑科学机制因果 共现，都是本产品口径的红线
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/(麦克风|声级|声音|声波|音频)[^\n]{0,40}(N1|N2|N3|深睡|浅睡|REM|分期|睡眠阶段)/, '声音手段 × 分期判断共现'],
  [/声[^\n]{0,20}(提供|判断|识别|推断)[^\n]{0,20}(特征|分期|阶段|深睡)/, '声学推断分期'],
  [/(冲洗|清除|排出)[^\n]{0,20}(代谢废物|毒素|淀粉样)/, '脑代谢冲洗机制因果'],
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
  for (const [re, label] of FORBIDDEN_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // 否定豁免（第 135 轮）："不足以判断分期"是诚实边界声明，不是声称——
    // 命中行含否定标记时放行。代价是"先否定后肯定"的长句可能漏报，
    // 换取诚实否定句不被误杀（两害相权取其轻，注释在案）。
    const lineText = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
    if (/不足|无法|不能|听不出|看不出|并非|而非|不用于|不推断|不作为/.test(lineText)) continue;
    failures++;
    const line = text.slice(0, m.index).split('\n').length;
    console.error(`✗ ${f.split('/').pop()}:${line} 命中语义族「${label}」`);
  }
}

// 反向自检：写一个含禁语的临时文件必须被扫出
const probe = join(SRC, '__claims_probe__.ts');
try {
  writeFileSync(probe, 'export const x = "研究证明规律睡眠降低死亡风险";\nexport const y = "麦克风监测到深睡分期";\n');
  const probeHits = listFiles(SRC)
    .map((f) => ({ f, t: readFileSync(f, 'utf-8') }))
    .filter(({ t }) => FORBIDDEN.some((p) => t.includes(p)) || FORBIDDEN_PATTERNS.some(([re]) => re.test(t)));
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
console.log(`✓ verify-no-claims：src/ 与 server.ts 无临床/因果声称（禁语 ${FORBIDDEN.length} 条 + 语义族 ${FORBIDDEN_PATTERNS.length} 组，含反向自检）`);
