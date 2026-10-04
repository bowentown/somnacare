/**
 * 护栏：超时/取消必须覆盖到真正阻塞的那一段（第 30 轮）。
 *
 * 教训链：req.on('close') 误用（P0）→ done() 清得太早（P0b）→
 * fetchWithTimeout 只保护响应头、body 读取裸奔——同一个 bug 家族连犯三次。
 * 本护栏锁住修复后的两个不变量：
 *  1. fetchJsonWithTimeout 必须在保护区内消费 body（不得 return await fetch）
 *  2. 组件层不得再出现自制的"只包 fetch 不读 body"的超时包装
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 不变量 1：fetchJson.ts 必须在保护区内消费 body ──
{
  const src = read('../src/utils/fetchJson.ts');
  check('fetchJson.ts 存在 text() 消费（body 在保护区内）', src.includes('await res.text()'));
  check('fetchJson.ts 不得 return await fetch（那会让 body 脱离保护区）', !src.includes('return await fetch'));
  check('fetchJson.ts 不得吞掉 AbortError（中止必须向上抛给兜底）',
    !/\.catch\(\s*\(\)\s*=>\s*null\s*\)/.test(src));
}

// ── 不变量 2：组件层不得再自制"只包 fetch"的超时包装 ──
{
  const panel = read('../src/components/AIAdvicePanel.tsx');
  const settings = read('../src/components/CustomAISettingsModal.tsx');
  check('AIAdvicePanel 使用共享 fetchJsonWithTimeout', panel.includes('fetchJsonWithTimeout'));
  check('AIAdvicePanel 不再含自制的 fetchWithTimeout 定义', !panel.includes('const fetchWithTimeout'));
  check('CustomAISettingsModal 模型查询有超时保护', settings.includes('fetchJsonWithTimeout'));
}

// ── 反向自检：合成"坏实现"必须被识别 ──
{
  const badImpl = `async function f(url, o, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...o, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }`;
  check('反向自检：return await fetch 的坏实现被特征识别', badImpl.includes('return await fetch'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——超时覆盖面回归（body 阶段可能裸奔）`);
  process.exit(1);
}
console.log('\n✓ verify-timeout-coverage：超时/取消覆盖面不变量成立');
