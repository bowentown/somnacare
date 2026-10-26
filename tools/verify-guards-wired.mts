/**
 * 元护栏：所有 tools/verify-*.mts 必须被 package.json 的 verify 链引用。
 *
 * 背景（第 20 轮）：verify-share-layout / verify-share-privacy 两条护栏
 * 写好了、手动跑全绿，但少了一行 && 接线，CI 里一次都没跑——
 * "护栏自己没被护栏管住"。本护栏扫 tools/verify-*.mts 与两条链
 * （verify 与 verify:css），逐个断言被引用；新增护栏忘了接线就在这里红。
 *
 * 方法论约束：护栏必须能反向验证——伪造一个未接线的护栏文件名必须报红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const wired = `${pkg.scripts.verify ?? ''} ${pkg.scripts['verify:css'] ?? ''}`;

const guardFiles = readdirSync(join(ROOT, 'tools'))
  .filter((f) => /^verify-[\w-]+\.mts$/.test(f))
  .sort();

const missing = guardFiles.filter((f) => !wired.includes(f));

if (missing.length > 0) {
  console.error('✗ verify-guards-wired：以下护栏未接入 package.json 的 verify/verify:css 链（CI 不会执行）：');
  for (const m of missing) console.error('   ' + m);
  console.error('   新护栏写完请追加到 scripts.verify（需要构建产物的加到 verify:css）。');
  process.exit(1);
}

// ── 吞错模式检测（第 86 轮外部审查变异实测：把接线改成 `|| true` 后
//    verify 链仍 exit 0——本元护栏只查文本出现，对"接了但失败被吞"失明）。
//    链里每个 tsx 调用之后只允许 && 或行尾；出现 || / ; / | 等旁路即红。
// 第 88 轮强化：整链括号包裹 + || true 可绕过逐命令检测——改为全链任何
// 位置的吞错模式一律禁止（verify 链中不存在合法的 || true / ; true 用法）
// 第 90 轮 N7：`; exit 0` / `|| exit 0` / `|| /usr/bin/true` / `|| echo` 也可绕过
const swallowPattern = /\|\|\s*(?:true|exit\s+0|\/usr\/bin\/true|echo)\b|\|\|\s*:|;\s*(?:true|exit\s+0)\b|\|\s*true\b/;
if (swallowPattern.test(wired)) {
  console.error('✗ verify-guards-wired：verify 链存在吞错旁路（|| / ; / 管道）——护栏失败会被静默吞掉：');
  console.error('   ' + wired.replace(swallowPattern, (m) => `【${m.trim()}】`));
  process.exit(1);
}
// 变异自检：注入 `|| true` 的副本必须被同一判定抓住（防检测器自身失效）
{
  const variants = [
    '(tsx tools/verify-wiring.mts || true)',
    'tsx tools/verify-wiring.mts; exit 0',
    'tsx tools/verify-wiring.mts || exit 0',
    'tsx tools/verify-wiring.mts || /usr/bin/true',
    'tsx tools/verify-wiring.mts || :',
  ];
  const missed = variants.filter((v) => !swallowPattern.test(wired.replace('tsx tools/verify-wiring.mts', v)));
  if (missed.length > 0) {
    console.error('✗ verify-guards-wired：吞错检测自检失败——以下旁路未被检出：');
    for (const m of missed) console.error('   ' + m);
    process.exit(1);
  }
}
console.log('✓ verify 链无吞错旁路（|| / ; / 管道旁路 + 变异自检）');

// 反向自检：伪造一个"未接线护栏"名单必须被检出
{
  const fake = [...guardFiles, 'verify-fake-guard.mts'];
  const bad = fake.filter((f) => !wired.includes(f));
  if (!(bad.length === 1 && bad[0] === 'verify-fake-guard.mts')) {
    console.error('✗ verify-guards-wired：自检失败——伪造的未接线护栏未被检出');
    process.exit(1);
  }
}

console.log(`✓ verify-guards-wired：${guardFiles.length} 条护栏全部接入 CI 执行链`);
