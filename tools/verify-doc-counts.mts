/**
 * 护栏：README 里的"护栏条数 / e2e 条数"必须与实测一致。
 *
 * 背景（第 91 轮）：README 徽章写 37 条、正文三处写 38 条，实测 39 条；
 * e2e 写 53 条、实测 60 条。数字漂移是"承诺漂移"里最廉价、也最容易被
 * 忽视的一种——读者会据此高估或低估项目实际被覆盖的程度。数字既然
 * 可计算，就交给护栏，而不是靠人记得顺手改。
 *
 * 为什么不断言"断言条数"：本护栏本身在 verify 链内，跑 npm run verify
 * 会无限递归；而 ✓ 行数随每次增删检查项波动，钉死只会造成无谓红。
 * 该数字按实测手工维护（当前 580+，来自 verify 链 577 行 + verify:css 9 行）。
 *
 * 方法论约束：护栏必须能反向验证——把 README 里的数字改错必须报红。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const E2E_DIR = join(ROOT, 'tests', 'e2e');

const guardCount = readdirSync(join(ROOT, 'tools')).filter((f) => /^verify-[\w-]+\.mts$/.test(f)).length;
const e2eCount = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .reduce((n, f) => n + (readFileSync(join(E2E_DIR, f), 'utf8').match(/^test\(/gm)?.length ?? 0), 0);

/** 抽出 README 里所有"护栏 N 条 / N 条静态护栏 / N 条 … e2e"声明并逐个比对 */
function checkClaims(readme: string): string[] {
  const bad: string[] = [];
  const seen = { badge: 0, guards: 0, e2e: 0 };

  const badge = readme.match(/护栏-(\d+)%20条/);
  if (badge) {
    seen.badge++;
    if (Number(badge[1]) !== guardCount) bad.push(`徽章护栏条数：README 写 ${badge[1]}，实测 ${guardCount}`);
  }
  for (const m of readme.matchAll(/(\d+) 条静态护栏/g)) {
    seen.guards++;
    if (Number(m[1]) !== guardCount) bad.push(`静态护栏条数：README 写 ${m[1]}，实测 ${guardCount}`);
  }
  for (const m of readme.matchAll(/(\d+) 条 ?(?:Playwright|浏览器) e2e/g)) {
    seen.e2e++;
    if (Number(m[1]) !== e2eCount) bad.push(`e2e 条数：README 写 ${m[1]}，实测 ${e2eCount}`);
  }

  // 声明整体消失同样要报红：否则删掉徽章/正文就能让本护栏失明
  for (const [k, v] of Object.entries(seen)) {
    if (v === 0) bad.push(`${k} 类声明在 README 里一处都找不到（改了措辞？请同步本护栏）`);
  }
  return bad;
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const bad = checkClaims(readme);
if (bad.length > 0) {
  console.error('✗ verify-doc-counts：README 数字与实测不符：');
  for (const b of bad) console.error('   ' + b);
  console.error(`   （实测口径：tools/verify-*.mts = ${guardCount} 条；tests/e2e/*.spec.ts 的 test( = ${e2eCount} 条）`);
  process.exit(1);
}

// 反向自检：把三类数字各改错一处，必须全部被同一判定抓住
{
  const doctored = readme
    .replace(/护栏-\d+%20条/, '护栏-99%20条')
    .replace(/\d+ 条静态护栏/, '99 条静态护栏')
    .replace(/\d+ 条 ?Playwright e2e/, '99 条 Playwright e2e');
  const caught = checkClaims(doctored).length;
  if (caught < 3) {
    console.error(`✗ verify-doc-counts：自检失败——改错的三处数字只被抓到 ${caught}/3`);
    process.exit(1);
  }
}

console.log(`✓ verify-doc-counts：README 的护栏条数（${guardCount}）与 e2e 条数（${e2eCount}）与实测一致`);
