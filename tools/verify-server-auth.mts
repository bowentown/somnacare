/**
 * 服务端鉴权护栏（安全审计 A3 根治的回归锚）：
 *
 * 鉴权中间件曾被注册在限流中间件的【回调体】里——每个请求都向 Express
 * 栈尾追加一个新 layer（无界内存增长），而 /api/sleep/analyze、/api/sleep/chat
 * 路由注册在栈中部，请求按栈序匹配永远到不了栈尾的鉴权层 → 401 从未真正
 * 拦截（最小 Express 复现实证：无 token 返回 200，20 次请求栈长 7→17）。
 *
 * 本护栏钉住三条结构不变量：
 *  1. requireSleepAuth 必须以顶层语句 app.use('/api/sleep/', requireSleepAuth)
 *     注册【恰好一次】，且位于两个 /api/sleep 路由之前；
 *  2. SOMNA_API_TOKEN 常量必须声明在 requireSleepAuth 定义之前
 *     （引用点在声明点之后是明确的坏味道）；
 *  3. server.ts 不允许出现任何缩进的（嵌套在回调体内的）app.use('/api/…')——
 *     "API 中间件注册在另一个中间件回调里"这个 bug 类别的形态特征
 *     （setupServer() 里的 vite/static 注册是合法的一次性顶层函数调用，不在此列）；
 *  4. /api/sleep/ 前缀的 app.use 必须恰好 2 处：限流 + 鉴权。
 *
 * 方法论约束：反向自检——把伪造的坏结构喂进同一断言路径必须报红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(join(ROOT, 'server.ts'), 'utf-8');
const lines = src.split('\n');

function fail(msg: string): never {
  console.error('✗ verify-server-auth：' + msg);
  process.exit(1);
}
function lineOf(pred: (l: string) => boolean): number {
  return lines.findIndex(pred);
}

// 1) 顶层注册恰好一次，且在路由之前
const regLine = lineOf((l) => l.startsWith("app.use('/api/sleep/', requireSleepAuth);"));
if (regLine < 0) fail("requireSleepAuth 未以顶层语句注册（app.use('/api/sleep/', requireSleepAuth);）");
const regCount = lines.filter((l) => l.includes('requireSleepAuth);')).length;
if (regCount !== 1) fail(`requireSleepAuth 注册不恰好一次（实际 ${regCount} 处）`);

const analyzeLine = lineOf((l) => l.includes("app.post('/api/sleep/analyze'"));
const chatLine = lineOf((l) => l.includes("app.post('/api/sleep/chat'"));
if (analyzeLine < 0 || chatLine < 0) fail('未找到 /api/sleep/analyze 或 /api/sleep/chat 路由');
if (!(regLine < analyzeLine && regLine < chatLine))
  fail('鉴权注册必须位于所有 /api/sleep/* 路由之前（Express 按栈序匹配）');

// 2) 常量声明在中间件定义之前
const tokenLine = lineOf((l) => l.startsWith('const SOMNA_API_TOKEN ='));
const defLine = lineOf((l) => l.startsWith('const requireSleepAuth'));
if (tokenLine < 0 || defLine < 0 || !(tokenLine < defLine))
  fail('SOMNA_API_TOKEN 必须声明在 requireSleepAuth 定义之前');

// 3) 禁止嵌套注册 /api/ 中间件（回调体内 app.use('/api/…') = A3 bug 形态）
const nested = lines.findIndex((l) => /^[ \t]{2,}app\.use\(['"]\/api\//.test(l));
if (nested >= 0)
  fail(`第 ${nested + 1} 行出现嵌套注册的 /api/ 中间件——这正是 A3 的 bug 形态`);

// 4) /api/sleep/ 前缀的 app.use 恰好 2 处：限流 + 鉴权
const sleepUseCount = lines.filter((l) => l.includes("app.use('/api/sleep/'")).length;
if (sleepUseCount !== 2) fail(`/api/sleep/ 的 app.use 必须恰好 2 处（限流+鉴权），实际 ${sleepUseCount} 处`);

// 反向自检：伪造坏结构必须被 3) 检出
{
  const bad = [...lines, "    app.use('/api/sleep/', (req, res, next) => { next(); });"];
  const badNested = bad.findIndex((l) => /^[ \t]{2,}app\.use\(['"]\/api\//.test(l));
  if (badNested < 0) fail('反向自检失败：伪造的嵌套 app.use 未被检出');
}

console.log('✓ verify-server-auth：鉴权顶层唯一注册、先于路由、常量前置、无嵌套 app.use');
