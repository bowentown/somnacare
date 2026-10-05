/**
 * 护栏：超时/取消必须覆盖到真正阻塞的那一段（第 30 轮；第 31 轮强化）。
 *
 * 教训链：req.on('close') 误用（P0）→ done() 清得太早（P0b）→
 * fetchWithTimeout 只保护响应头、body 读取裸奔——同一个 bug 家族连犯三次。
 *
 * 两个不变量：
 *  1. fetchJsonWithTimeout 必须在保护区内消费 body（不得 return await fetch）
 *  2. AbortController 的出现点受白名单+计数约束——任何文件新增/删除
 *     AbortController 都必须显式更新本清单，防止"换名字的自制包装"逃逸
 *     （第 31 轮变异 D 实测：按名字检查会被改名绕过）
 *
 * 反向自检用【同一个判定函数】，不写同义反复的字面量断言。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join as j2, relative as r2 } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

/** 判定函数（反向自检与真实检查共用）：body 是否脱管。
 *  适用范围：假定被测文件直接消费 fetch 的 body——对 body 全走 fetchJson
 *  的文件会误报，只应用于 fetchJson.ts（第 31 轮 §五）。
 *  - 出现 return await fetch（头到即 resolve 并交出控制权）→ 脱管
 *  - 完全没有 body 消费 → 脱管
 *  - 先 clearTimeout 再读 body → 脱管（最危险变体；变量名无关——第 32 轮
 *    勘误：旧判定把变量名写死为 res，3/7 用例错判，含该变体漏报） */
export function hasUnprotectedFetch(src: string): boolean {
  if (/return\s+await\s+fetch\b/.test(src)) return true;
  const bodyIdx = src.search(/\bawait\s+\w+\.(text|json|arrayBuffer|blob)\(/);
  if (bodyIdx < 0) return true;
  const clearIdx = src.indexOf('clearTimeout');
  if (clearIdx >= 0 && clearIdx < bodyIdx) return true;
  return false;
}

const SRC = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p2 = j2(d, n);
    return statSync(p2).isDirectory() ? walk(p2) : (/\.(ts|tsx)$/.test(n) ? [p2] : []);
  });

// ── 不变量 1：fetchJson.ts 的 body 消费与中止语义 ──
{
  const src = readFileSync(new URL('../src/utils/fetchJson.ts', import.meta.url), 'utf8');
  check('fetchJsonWithTimeout 的 body 在保护区内消费（无脱管 fetch）', !hasUnprotectedFetch(src));
  check('fetchJson.ts 不吞 AbortError（中止必须向上抛给本地兜底）',
    !/\.catch\(\s*\(\)\s*=>\s*null\s*\)/.test(src));
}

// ── 不变量 2：AbortController 白名单 + 计数（防换名逃逸）──
const AC_ALLOW: Record<string, number> = {
  'src/utils/fetchJson.ts': 1,            // fetchJsonWithTimeout 的超时中止
  'src/utils/petMoments.ts': 1,           // callLlm 25s 保护
  'src/components/AIAdvicePanel.tsx': 1,  // 端侧模型生成中止（非 fetch 包装）
  'src/components/CustomAISettingsModal.tsx': 1, // 模型下载取消
  'src/utils/localLlmEngine.ts': 1,       // 下载停滞看门狗（45 轮 D4：30s 无数据中止重试）
  'src/utils/sleepShareCard.ts': 1,       // 分享卡图源 10s 超时（45 轮 D4）
  'server.ts': 1,                         // 服务端上游 40s 保护
};
{
  const counts: Record<string, number> = {};
  for (const f of walk(SRC)) {
    const rel = 'src/' + r2(SRC, f).split('\\').join('/');
    const n = (readFileSync(f, 'utf-8').match(/new AbortController\(\)/g) || []).length;
    if (n > 0) counts[rel] = n;
  }
  const serverSrc = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const sN = (serverSrc.match(/new AbortController\(\)/g) || []).length;
  if (sN > 0) counts['server.ts'] = sN;

  const problems: string[] = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = AC_ALLOW[file];
    if (allowed === undefined) problems.push(`${file} 新增 ${n} 个 AbortController，未登记白名单`);
    else if (allowed !== n) problems.push(`${file} AbortController 数量 ${n} ≠ 白名单 ${allowed}`);
  }
  for (const file of Object.keys(AC_ALLOW)) {
    if (!(file in counts)) problems.push(`${file} 白名单登记了 ${AC_ALLOW[file]} 个，实际已消失`);
  }
  check('AbortController 白名单与计数一致（新增/改名/删除都会报红）', problems.length === 0,
    problems.join('; ') || Object.entries(counts).map(([f, n]) => `${f}:${n}`).join(' '));
}

// ── 不变量 3：组件层不得出现 return await fetch（超时包装不允许交出控制权）──
// 注意不能用整个 hasUnprotectedFetch 判定无直接 fetch 的组件文件——
// 它们没有 body 消费属正常（body 全部走 fetchJson）
{
  const panel = readFileSync(new URL('../src/components/AIAdvicePanel.tsx', import.meta.url), 'utf8');
  check('AIAdvicePanel 无 return await fetch（超时包装不允许交出控制权）',
    !/return\s+await\s+fetch/.test(panel));
}

// ── 反向自检：坏实现必须被【同一个判定函数】识别 ──
{
  const badImpl = `async function f(url, o, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try { return await fetch(url, { ...o, signal: c.signal }); }
    finally { clearTimeout(t); }
  }`;
  check('反向自检：return await fetch 的坏实现被 hasUnprotectedFetch 抓住',
    hasUnprotectedFetch(badImpl));
  const badImpl2 = `async function f(url, o, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url, { ...o, signal: c.signal }); return r; }
    finally { clearTimeout(t); }
  }`;
  check('反向自检：fetch 后直接交出的变体也被抓住', hasUnprotectedFetch(badImpl2));
  const goodImpl = readFileSync(new URL('../src/utils/fetchJson.ts', import.meta.url), 'utf8');
  check('反向自检：正确的 fetchJson.ts 不被误报', !hasUnprotectedFetch(goodImpl));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——超时覆盖面回归（body 阶段可能裸奔）`);
  process.exit(1);
}
console.log('\n✓ verify-timeout-coverage：超时/取消覆盖面不变量成立');
