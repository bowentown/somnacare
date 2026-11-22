/**
 * 纯文本渲染出口的 markdown 清洗：本地规则引擎模板与 LLM 输出都可能带
 * ** 加粗 / 单星号记号，而界面一律按纯文本渲染，星号会原样露出来。
 * 在渲染处统一调用（而不是在每条产生文案的路径上各自处理）。
 */
export function stripMd(s: string): string {
  return s.replace(/\*\*/g, '').replace(/(?<![a-zA-Z])\*(?![a-zA-Z\s])/g, '');
}
