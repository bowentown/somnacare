/**
 * 从 GKD_subscription 的 dist/gkd.json5 提取广告规则，生成
 * cap-gemma-llm 原生侧使用的安全子集规则表。
 *
 * 用法：
 *   npx tsx tools/import-gkd-splash.mts /path/to/GKD_subscription/dist/gkd.json5 [selector-library.json]
 *
 * 说明（第 63/66 轮）：
 *  - 用户明确要求参考 GKD_subscription，并自行承担版权责任；
 *  - 应用组导入「开屏广告」（启动窗口内）与「全屏广告」「局部广告」
 *    （应用内弹窗/卡片广告，前台期间持续生效）；分段广告是多步交互流
 *    （点 X → 选理由），单次点击走不完，不导入；
 *  - 第二个参数可选：dist/gkd-667-selector-library.json（全局选择器库），
 *    其中开屏类作为全局开屏规则，SDK 卡片关闭规则（字节/腾讯/京东/快手）
 *    作为全局常驻规则（when=always，任何前台应用的小关闭按钮）；
 *  - GKD 选择器 DSL 被归一化为 JSON AST，原生侧不解析 DSL；
 *  - 关系型选择器（@ / > / + / - / <）只提取 @ 目标或最后一个可识别节点，
 *    并附加上下文关键词；执行时仍受“小尺寸 + 可点击 + 冷却/上限”约束；
 *  - 纯结构选择器（无 text/desc/vid/name 谓词）必须带广告强上下文才保留。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(
  ROOT,
  'plugins/cap-gemma-llm/android/src/main/assets/ad_skip_rules.json',
);

type Json = any;
type Field = 'text' | 'desc' | 'vid' | 'id' | 'name';
type NumField = 'width' | 'height' | 'childCount' | 'top' | 'left' | 'right' | 'bottom' | 'index' | 'parentChildCount';
type BoolField = 'clickable' | 'visibleToUser' | 'enabled' | 'focusable' | 'scrollable';
type Op = '=' | '!=' | '<' | '<=' | '>' | '>=';

type Predicate =
  | { k: 'eq' | 'contains' | 'starts' | 'ends' | 'regex'; f: Field; v: string }
  | { k: 'notEq' | 'notContains' | 'notStarts' | 'notEnds' | 'notRegex'; f: Field; v: string }
  | { k: 'len' | 'num'; f: Field | NumField; op: Op; v: number }
  | { k: 'bool'; f: BoolField; v: boolean }
  | { k: 'null'; f: Field; v: boolean }
  | { k: 'type'; v: string }
  | { k: 'true' }
  | { k: 'indexFromEnd'; v: number }
  | { k: 'all' | 'any'; p: Predicate[] }
  | { k: 'not'; p: Predicate };

/** 链上单个节点：rel 描述本节点相对前一节点的关系，d 是关系距离范围 */
interface ChainStep {
  rel: 'self' | 'parent' | 'child' | 'next' | 'prev';
  d: [number, number];
  pred: Predicate;
}

interface Selector {
  chain: { steps: ChainStep[]; target: number };
  /** 全局规则生效期：splash=启动窗口内；always=前台常驻（SDK 卡片关闭规则） */
  when?: 'splash' | 'always';
}

interface Profile {
  activityIds: string[];
  /** splash=应用启动窗口内执行；inApp=该应用前台期间持续执行（应用内广告） */
  when: 'splash' | 'inApp';
  matchTime: number;
  actionMaximum: number;
  selectors: Selector[];
  excludes: Selector[];
}

interface AppRules {
  name: string;
  profiles: Profile[];
}

const FIELD_NAMES = new Set([
  'text', 'desc', 'vid', 'id', 'name', 'className', 'parent',
  'width', 'height', 'childCount', 'top', 'left', 'right', 'bottom',
  'index', 'depth',
  'clickable', 'visibleToUser', 'enabled', 'focusable', 'scrollable',
]);
const BOOL_FIELDS = new Set(['clickable', 'visibleToUser', 'enabled', 'focusable', 'scrollable']);
const NUM_FIELDS = new Set(['width', 'height', 'childCount', 'top', 'left', 'right', 'bottom', 'index', 'parentChildCount']);
const STRING_OPS: Record<string, Predicate['k']> = {
  '=': 'eq',
  '*=': 'contains',
  '^=': 'starts',
  '$=': 'ends',
  '~=': 'regex',
  '!=': 'notEq',
  '!*=': 'notContains',
  '!^=': 'notStarts',
  '!$=': 'notEnds',
  '!~=': 'notRegex',
};
class Unsupported extends Error {}

interface Token {
  t: 'id' | 'str' | 'num' | 'bool' | 'null' | 'op' | 'punc';
  v: string;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const three = input.slice(i, i + 3);
    const two = input.slice(i, i + 2);
    if (three === '!*=' || three === '!^=' || three === '!$=' || three === '!~=') {
      out.push({ t: 'op', v: three }); i += 3; continue;
    }
    if (two === '&&' || two === '||' || two === '*=' || two === '^=' || two === '$=' || two === '~=' || two === '!=' || two === '<=' || two === '>=') {
      out.push({ t: 'op', v: two }); i += 2; continue;
    }
    if (ch === '=' || ch === '<' || ch === '>') {
      out.push({ t: 'op', v: ch }); i += 1; continue;
    }
    if (ch === '!' || ch === '(' || ch === ')' || ch === '.') {
      out.push({ t: 'punc', v: ch }); i += 1; continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let raw = '';
      while (j < input.length) {
        if (input[j] === '\\') { raw += input[j] + (input[j + 1] ?? ''); j += 2; continue; }
        if (input[j] === quote) break;
        raw += input[j]; j += 1;
      }
      if (j >= input.length) throw new Unsupported('unterminated string');
      let value: string;
      try {
        value = quote === '"' ? JSON.parse(`"${raw}"`) : raw;
      } catch {
        value = raw;
      }
      out.push({ t: 'str', v: value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < input.length && /[0-9.]/.test(input[j])) j += 1;
      out.push({ t: 'num', v: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      // 属性名不含 $；`$=` 必须留给操作符，否则 id$/text$ 会被吞成字段名
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      const word = input.slice(i, j);
      if (word === 'true' || word === 'false') out.push({ t: 'bool', v: word });
      else if (word === 'null') out.push({ t: 'null', v: word });
      else out.push({ t: 'id', v: word });
      i = j;
      continue;
    }
    throw new Unsupported(`unexpected ${ch}`);
  }
  return out;
}

class ExpressionParser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Predicate {
    const expr = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Unsupported('trailing tokens');
    return expr;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private take(): Token { const t = this.tokens[this.pos]; if (!t) throw new Unsupported('eof'); this.pos += 1; return t; }
  private matchOp(value: string): boolean {
    const t = this.peek();
    if (t?.t === 'op' && t.v === value) { this.pos += 1; return true; }
    return false;
  }
  private expectPunc(value: string): void {
    const t = this.take();
    if (t.t !== 'punc' || t.v !== value) throw new Unsupported(`expected ${value}`);
  }

  private parseOr(): Predicate {
    const parts = [this.parseAnd()];
    while (this.matchOp('||')) parts.push(this.parseAnd());
    return parts.length === 1 ? parts[0] : { k: 'any', p: parts };
  }

  private parseAnd(): Predicate {
    const parts = [this.parseUnary()];
    while (this.matchOp('&&')) parts.push(this.parseUnary());
    return parts.length === 1 ? parts[0] : { k: 'all', p: parts };
  }

  private parseUnary(): Predicate {
    const t = this.peek();
    if (t?.t === 'punc' && t.v === '!') { this.pos += 1; return { k: 'not', p: this.parseUnary() }; }
    if (t?.t === 'punc' && t.v === '(') {
      this.pos += 1;
      const expr = this.parseOr();
      this.expectPunc(')');
      return expr;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Predicate {
    const fieldTok = this.take();
    if (fieldTok.t !== 'id') throw new Unsupported('field expected');
    const field = fieldTok.v;
    if (!FIELD_NAMES.has(field)) throw new Unsupported(`field ${field}`);
    if (field === 'depth') throw new Unsupported(`unsupported ${field}`);

    const dot = this.peek();
    if (dot?.t === 'punc' && dot.v === '.') {
      this.pos += 1;
      const attr = this.take();
      if (attr.t === 'id' && attr.v === 'length') {
        const op = this.take();
        const val = this.take();
        if (op.t !== 'op' || val.t !== 'num') throw new Unsupported('length value');
        return { k: 'len', f: field as Field, op: normalizeOp(op.v), v: Number(val.v) };
      }
      // parent.childCount.minus(N) —— 常见于 index=parent.childCount.minus(1)（倒数第 N 个子节点）
      if (field === 'parent' && attr.t === 'id' && attr.v === 'childCount') {
        const after = this.peek();
        if (after?.t === 'punc' && after.v === '.') {
          this.pos += 1;
          const minus = this.take();
          if (minus.t !== 'id' || minus.v !== 'minus') throw new Unsupported('parent attr');
          this.expectPunc('(');
          const n = this.take();
          if (n.t !== 'num') throw new Unsupported('minus value');
          this.expectPunc(')');
          return { k: 'indexFromEnd', v: Number(n.v) };
        }
        const op = this.take();
        const val = this.take();
        if (op.t !== 'op' || val.t !== 'num') throw new Unsupported('parent childCount value');
        return { k: 'num', f: 'parentChildCount', op: normalizeOp(op.v), v: Number(val.v) };
      }
      throw new Unsupported('unsupported attribute');
    }

    const next = this.peek();
    if (BOOL_FIELDS.has(field) && !(next?.t === 'op')) {
      return { k: 'bool', f: field as BoolField, v: true };
    }
    if (!next || next.t !== 'op') throw new Unsupported('operator expected');
    const op = this.take() as Token;
    const value = this.take();

    if (value.t === 'null') {
      // id=null 与 id!=null 语义相反：op 必须参与（此前被忽略，两者同义——反转 bug）
      return { k: 'null', f: field as Field, v: op.v !== '!=' };
    }
    // index = parent.childCount.minus(N)：倒数第 N 个子节点
    if (value.t === 'id' && value.v === 'parent' && field === 'index') {
      this.expectPunc('.');
      const attr = this.take();
      if (attr.t !== 'id' || attr.v !== 'childCount') throw new Unsupported('parent attr');
      this.expectPunc('.');
      const minus = this.take();
      if (minus.t !== 'id' || minus.v !== 'minus') throw new Unsupported('parent attr');
      this.expectPunc('(');
      const n = this.take();
      if (n.t !== 'num') throw new Unsupported('minus value');
      this.expectPunc(')');
      return { k: 'indexFromEnd', v: Number(n.v) };
    }
    if (value.t === 'bool') {
      if (!BOOL_FIELDS.has(field)) throw new Unsupported('bool field');
      return { k: 'bool', f: field as BoolField, v: value.v === 'true' };
    }
    if (value.t === 'num') {
      if (!NUM_FIELDS.has(field)) throw new Unsupported('num field');
      return { k: 'num', f: field as NumField, op: normalizeOp(op.v), v: Number(value.v) };
    }
    if (value.t === 'str') {
      if (!['text', 'desc', 'vid', 'id', 'name'].includes(field)) throw new Unsupported('string field');
      const kind = STRING_OPS[op.v];
      if (!kind) throw new Unsupported('string op');
      return { k: kind, f: field as Field, v: value.v } as Predicate;
    }
    throw new Unsupported('value');
  }
}

function normalizeOp(op: string): Op {
  if (op === '=' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') return op;
  throw new Unsupported(`op ${op}`);
}

/** 在括号深度 0 处切分关系符；跳过关系符后的计数（2 / n / (n+6) / (1,2)）。 */
const REL_CHAR: Record<string, 'child' | 'parent' | 'next' | 'prev'> = {
  '>': 'child', '<': 'parent', '+': 'next', '-': 'prev',
};

/** 关系符后的距离：`2` / `n` / `(1,2)` / `(n+6)` → [min,max]（n 视为任意层，上限 64） */
function parseDistance(input: string, start: number): { d: [number, number]; next: number } {
  const ch = input[start];
  if (ch === '(') {
    let depth = 0;
    let j = start;
    do {
      if (input[j] === '(') depth += 1;
      if (input[j] === ')') depth -= 1;
      j += 1;
    } while (j < input.length && depth > 0);
    const inner = input.slice(start + 1, j - 1).trim();
    if (inner === 'n') return { d: [1, 64], next: j };
    let m = /^(\d+)\s*,\s*(\d+)$/.exec(inner);
    if (m) return { d: [Number(m[1]), Number(m[2])], next: j };
    m = /^n\s*\+\s*(\d+)$/.exec(inner);
    if (m) return { d: [Number(m[1]) + 1, 64], next: j };
    return { d: [1, 64], next: j };
  }
  if (ch === 'n' && !/[A-Za-z0-9_(]/.test(input[start + 1] ?? '')) {
    return { d: [1, 64], next: start + 1 };
  }
  if (/[0-9]/.test(ch)) {
    let j = start;
    while (j < input.length && /[0-9]/.test(input[j])) j += 1;
    if (!/[A-Za-z0-9_(]/.test(input[j] ?? '')) {
      const k = Number(input.slice(start, j));
      return { d: [k, k], next: j };
    }
  }
  return { d: [1, 1], next: start };
}

interface ChainPart {
  text: string;
  rel: ChainStep['rel'];
  d: [number, number];
  isTarget: boolean;
}

/** `<<` 后的距离：`n`/无 → 任意层；`K` → 至少 K 层 */
function parseAncestorDistance(input: string, start: number): { d: [number, number]; next: number } {
  const ch = input[start];
  if (ch === 'n' && !/[A-Za-z0-9_(]/.test(input[start + 1] ?? '')) {
    return { d: [1, 64], next: start + 1 };
  }
  if (/[0-9]/.test(ch)) {
    let j = start;
    while (j < input.length && /[0-9]/.test(input[j])) j += 1;
    if (!/[A-Za-z0-9_(]/.test(input[j] ?? '')) {
      return { d: [Number(input.slice(start, j)), 64], next: j };
    }
  }
  return { d: [1, 64], next: start };
}

/**
 * 把 GKD 选择器切成“节点 + 关系”链：`@A[x] <2 B[y] +(1,2) C` →
 * [{A,self}, {B,parent,[2,2]}, {C,next,[1,2]}]，@ 标记的节点是点击目标。
 * 括号深度 0 之外的关系符才是链关系；方括号/表达式括号内的运算符不动。
 * 这是精度的来源：不再把关系链降级成“目标 + 窗口任意位置的关键词”。
 */
function parseChainRaw(selector: string): { parts: ChainPart[]; target: number } | null {
  const parts: ChainPart[] = [];
  let current = '';
  let pendingRel: ChainStep['rel'] = 'self';
  let pendingD: [number, number] = [1, 1];
  let markTarget = false;
  let depth = 0;
  let i = 0;
  const flush = (): void => {
    parts.push({ text: current.trim(), rel: pendingRel, d: pendingD, isTarget: markTarget });
    current = '';
    markTarget = false;
  };
  while (i < selector.length) {
    const ch = selector[i];
    if (depth === 0 && ch === '@') {
      markTarget = true;
      i += 1;
      continue;
    }
    if (depth === 0 && REL_CHAR[ch]) {
      flush();
      // `<<n` / `<<4`：任意层/至少 K 层祖先（GKD 祖先语法）；`>>` 对称表示后代
      if ((ch === '<' && selector[i + 1] === '<') || (ch === '>' && selector[i + 1] === '>')) {
        pendingRel = ch === '<' ? 'parent' : 'child';
        i += 2;
        while (selector[i] === ' ') i += 1;
        const dist = parseAncestorDistance(selector, i);
        pendingD = dist.d;
        i = dist.next;
        continue;
      }
      pendingRel = REL_CHAR[ch];
      i += 1;
      while (selector[i] === ' ') i += 1;
      const dist = parseDistance(selector, i);
      pendingD = dist.d;
      i = dist.next;
      continue;
    }
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    current += ch;
    i += 1;
  }
  flush();
  if (parts.length === 0 || parts.some((p) => !p.text)) return null;
  if (parts[0].rel !== 'self') return null;
  let target = parts.findIndex((p) => p.isTarget);
  if (target < 0) target = parts.length - 1;
  return { parts, target };
}

/** 链上任意节点带“正向文字/描述/控件 id”谓词且值非空（text="" 不算锚） */
function hasAnchor(pred: Predicate): boolean {
  switch (pred.k) {
    case 'eq': case 'contains': case 'starts': case 'ends': case 'regex':
      return (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')
        && pred.v.length > 0 && pred.v !== '.*';
    case 'all': case 'any':
      return pred.p.some(hasAnchor);
    default:
      return false;
  }
}

/** 弱身份信号计分：非空正向文字/id 谓词 2 分；id!=null / text!=null（“有值”）1 分。
 *  应用级规则允许“无强锚但 ≥2 分”（链上结构约束足够定位）；全局常驻仍要求强锚+词门槛。 */
function identityPoints(pred: Predicate): number {
  switch (pred.k) {
    case 'eq': case 'contains': case 'starts': case 'ends': case 'regex':
      if ((pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')
        && pred.v.length > 0 && pred.v !== '.*') return 2;
      return 0;
    case 'null':
      if (pred.v === false && (pred.f === 'id' || pred.f === 'text' || pred.f === 'desc')) return 1;
      return 0;
    case 'all': case 'any':
      return pred.p.reduce((n, c) => n + identityPoints(c), 0);
    default:
      return 0;
  }
}

function chainAnchorOk(steps: ChainStep[]): boolean {
  if (steps.some((s) => hasAnchor(s.pred))) return true;
  return steps.reduce((n, s) => n + identityPoints(s.pred), 0) >= 2;
}

function positiveStringValues(pred: Predicate, out: string[] = []): string[] {
  switch (pred.k) {
    case 'eq': case 'contains': case 'starts': case 'ends': case 'regex':
      if (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id') out.push(pred.v);
      break;
    case 'all': case 'any':
      for (const p of pred.p) positiveStringValues(p, out);
      break;
    default:
      break;
  }
  return out;
}

/** 常驻（always）全局规则的额外门槛：锚点须含广告语义词，或链上 ≥2 个正向文字谓词。
 *  常驻规则在任何前台应用生效，宁可少几条也不能多点。 */
const AD_ANCHOR_WORDS = [
  '广告', '廣告', '跳过', '跳過', 'skip', '关闭', '關閉', 'close', '反馈', 'dislike',
  '立即', '详情', '詳情', '下载', '下載', '逛逛', '微信', '优惠', '優惠', '小程序',
  '了解', '第三方', '扭动', '扭動', '省钱', '省錢', '点击或上滑', 'ksad', 'tt_', 'sdk',
];
function anchorWordsOk(steps: ChainStep[]): boolean {
  const anchors = steps.flatMap((s) => positiveStringValues(s.pred));
  if (anchors.some((a) => AD_ANCHOR_WORDS.some((w) => a.toLowerCase().includes(w)))) return true;
  return anchors.length >= 2;
}

function textValues(pred: Predicate, out: string[] = []): string[] {
  switch (pred.k) {
    case 'eq': case 'contains': case 'starts': case 'ends': case 'regex':
    case 'notEq': case 'notContains': case 'notStarts': case 'notEnds': case 'notRegex':
      if (pred.f === 'text' || pred.f === 'desc') out.push(pred.v);
      break;
    case 'all': case 'any':
      for (const p of pred.p) textValues(p, out);
      break;
    case 'not':
      textValues(pred.p, out);
      break;
    default:
      break;
  }
  return out;
}

function isAdLabelOnly(pred: Predicate): boolean {
  const values = textValues(pred).map((v) => v.trim());
  if (values.length === 0) return false;
  const labels = new Set(['广告', '廣告', '广告素材', '广告信息', '广告推广']);
  return values.every((v) => labels.has(v));
}

type SelectorToken =
  | { t: 'pred'; p: Predicate }
  | { t: 'op'; v: '&&' | '||' | '!' | '(' | ')' };

/** 把选择器文本（可含括号/||/&&）拆成“谓词 + 逻辑符”序列。 */
function selectorTokens(raw: string): SelectorToken[] {
  const out: SelectorToken[] = [];
  let i = 0;
  let operand = false;
  const pushOp = (v: '&&' | '||' | '!' | '(' | ')') => {
    out.push({ t: 'op', v });
    operand = v === ')';
  };
  const pushPred = (p: Predicate) => {
    if (operand) pushOp('&&');
    out.push({ t: 'pred', p });
    operand = true;
  };

  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '@') { i += 1; continue; }
    if (ch === '[') {
      let j = i + 1;
      let depth = 0;
      while (j < raw.length) {
        if (raw[j] === '[') depth += 1;
        else if (raw[j] === ']') {
          if (depth === 0) break;
          depth -= 1;
        }
        j += 1;
      }
      if (j >= raw.length) return [];
      try {
        pushPred(new ExpressionParser(tokenize(raw.slice(i + 1, j))).parse());
      } catch (e) {
        if (process.env.DEBUG_GKD) {
          console.error('GROUP PARSE ERR', (e as Error).message, raw.slice(i + 1, Math.min(j, i + 160)));
        }
        return [];
      }
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_$.]/.test(raw[j])) j += 1;
      const type = raw.slice(i, j);
      let k = j;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] !== '[') return [];
      if (type !== '*') {
        if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(type)) return [];
        pushPred({ k: 'type', v: type });
      }
      i = k;
      continue;
    }
    if (raw.startsWith('&&', i)) { pushOp('&&'); i += 2; continue; }
    if (raw.startsWith('||', i)) { pushOp('||'); i += 2; continue; }
    if (ch === '!' || ch === '(' || ch === ')') { pushOp(ch); i += 1; continue; }
    return [];
  }
  return out;
}

class SelectorExprParser {
  private pos = 0;
  constructor(private readonly tokens: SelectorToken[]) {}

  parse(): Predicate {
    const expr = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Unsupported('selector trailing tokens');
    return expr;
  }

  private peekOp(value: string): boolean {
    const token = this.tokens[this.pos];
    return token?.t === 'op' && token.v === value;
  }

  private parseOr(): Predicate {
    const parts = [this.parseAnd()];
    while (this.peekOp('||')) {
      this.pos += 1;
      parts.push(this.parseAnd());
    }
    return parts.length === 1 ? parts[0] : { k: 'any', p: parts };
  }

  private parseAnd(): Predicate {
    const parts = [this.parseUnary()];
    while (this.peekOp('&&')) {
      this.pos += 1;
      parts.push(this.parseUnary());
    }
    return parts.length === 1 ? parts[0] : { k: 'all', p: parts };
  }

  private parseUnary(): Predicate {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Unsupported('selector eof');
    if (tok.t === 'op' && tok.v === '!') {
      this.pos += 1;
      return { k: 'not', p: this.parseUnary() };
    }
    if (tok.t === 'op' && tok.v === '(') {
      this.pos += 1;
      const expr = this.parseOr();
      const close = this.tokens[this.pos];
      if (!close || close.t !== 'op' || close.v !== ')') throw new Unsupported('selector )');
      this.pos += 1;
      return expr;
    }
    if (tok.t === 'pred') {
      this.pos += 1;
      return tok.p;
    }
    throw new Unsupported('selector operand');
  }
}

/**
 * 解析一条完整 GKD 选择器为关系链。精度的来源就在这里：
 * `@A[x] < B[y] > C[z]` 不再被降级成“A + 窗口关键词”，而是整链逐节点校验。
 * 丢弃条件：任一节点解析失败 / 目标只是“广告”标签 / 全链无锚点。
 */
function parseSelector(raw: string): Selector | null {
  const selector = raw.trim();
  if (!selector) return null;
  const parsed = parseChainRaw(selector);
  if (!parsed) {
    if (process.env.DEBUG_GKD) console.error('CHAIN SPLIT FAIL', selector.slice(0, 180));
    return null;
  }
  const steps: ChainStep[] = [];
  for (const part of parsed.parts) {
    if (part.text === '*') {
      steps.push({ rel: part.rel, d: part.d, pred: { k: 'true' } });
      continue;
    }
    const tokens = selectorTokens(part.text);
    if (tokens.length === 0) return null;
    try {
      steps.push({ rel: part.rel, d: part.d, pred: new SelectorExprParser(tokens).parse() });
    } catch (e) {
      if (process.env.DEBUG_GKD) console.error('NODE PARSE ERR', (e as Error).message, part.text.slice(0, 140));
      return null;
    }
  }
  if (steps.length === 0) return null;
  const target = steps[parsed.target];
  if (isAdLabelOnly(target.pred)) {
    if (process.env.DEBUG_GKD) console.error('AD LABEL TARGET', selector.slice(0, 180));
    return null;
  }
  if (!chainAnchorOk(steps)) {
    if (process.env.DEBUG_GKD) console.error('NO ANCHOR', selector.slice(0, 180));
    return null;
  }
  return { chain: { steps, target: parsed.target } };
}

function textList(value: Json): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function normalizeActivities(value: Json): string[] {
  return textList(value).map((v) => v.trim()).filter(Boolean);
}

function uniqSelectors(list: Selector[]): Selector[] {
  const seen = new Set<string>();
  const out: Selector[] = [];
  for (const s of list) {
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** GKD 组名前缀 → 生效期；不在表内的组不导入（更新/评价/权限/分段等非单步点击流） */
const APP_CATEGORIES: Array<{ prefix: string; when: 'splash' | 'inApp' }> = [
  { prefix: '开屏广告', when: 'splash' },
  { prefix: '全屏广告', when: 'inApp' },
  { prefix: '局部广告', when: 'inApp' },
];

/** 全局选择器库里点名导入的前缀（库里还有更新提示/青少年模式，不导入） */
const GLOBAL_LIBRARY_PREFIXES = [
  '开屏广告', '字节开屏', '互动开屏', '字节SDK', '腾讯SDK', '京东SDK',
  '快手SDK', '卡片', 'dislike', '字节卡片',
];

/** 只执行点击类动作；longClick / back 等动作风险高，丢弃 */
function isClickAction(rule: Json): boolean {
  const action = typeof rule?.action === 'string' ? rule.action : 'click';
  return action === 'click' || action === 'clickNode' || action === 'clickCenter';
}

function main(): void {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('用法: npx tsx tools/import-gkd-splash.mts /path/to/GKD_subscription/dist/gkd.json5 [selector-library.json]');
    process.exit(1);
  }
  const dist = JSON5.parse(readFileSync(resolve(inputArg), 'utf-8')) as Json;

  // ── 全局开屏组（dist.globalGroups） ──
  const globalGroup = (dist.globalGroups ?? []).find((g: Json) => String(g?.name ?? '').includes('开屏'));
  if (!globalGroup) throw new Error('GKD 数据里找不到“开屏广告-全局”组');

  const globalSelectors: Selector[] = [];
  const globalExcludes: Selector[] = [];
  for (const rule of globalGroup.rules ?? []) {
    if (!rule || typeof rule !== 'object' || !isClickAction(rule)) continue;
    for (const raw of [...textList(rule.matches), ...textList(rule.anyMatches)]) {
      const parsed = parseSelector(raw);
      if (parsed) globalSelectors.push({ ...parsed, when: 'splash' });
      else if (process.env.DEBUG_GKD) console.error('GLOBAL SKIP', raw.slice(0, 220));
    }
    for (const raw of textList(rule.excludeMatches)) {
      const parsed = parseSelector(raw);
      if (parsed) globalExcludes.push(parsed);
      else if (process.env.DEBUG_GKD) console.error('GLOBAL EXCLUDE SKIP', raw.slice(0, 220));
    }
  }

  // ── 全局选择器库（可选；v667 起的 SDK 级卡片关闭规则） ──
  const libraryArg = process.argv[3];
  let librarySplash = 0;
  let libraryAlways = 0;
  if (libraryArg) {
    const lib = JSON.parse(readFileSync(resolve(libraryArg), 'utf-8')) as Json;
    for (const item of lib.items ?? []) {
      if (!item || typeof item !== 'object' || item.scope !== 'global') continue;
      const name = String(item.name ?? '');
      const selector = typeof item.selector === 'string' ? item.selector : '';
      if (!selector) continue;
      if (name.startsWith('开屏排除')) {
        const parsed = parseSelector(selector);
        if (parsed) globalExcludes.push(parsed);
        continue;
      }
      if (!GLOBAL_LIBRARY_PREFIXES.some((p) => name.startsWith(p))) continue;
      const parsed = parseSelector(selector);
      if (!parsed) {
        if (process.env.DEBUG_GKD) console.error('LIBRARY SKIP', name, selector.slice(0, 160));
        continue;
      }
      const isSplash = name.startsWith('开屏广告') || name.startsWith('字节开屏') || name.startsWith('互动开屏');
      if (isSplash) {
        globalSelectors.push({ ...parsed, when: 'splash' });
        librarySplash += 1;
      } else {
        // 常驻规则在任何前台应用生效：必须过广告词锚点门槛，宁缺毋滥
        if (!anchorWordsOk(parsed.chain.steps)) {
          if (process.env.DEBUG_GKD) console.error('LIBRARY ALWAYS GATE', name, selector.slice(0, 160));
          continue;
        }
        globalSelectors.push({ ...parsed, when: 'always' });
        libraryAlways += 1;
      }
    }
  }

  // ── 应用级规则 ──
  const apps: Record<string, AppRules> = {};
  let importedApps = 0;
  let skippedGroups = 0;
  for (const app of dist.apps ?? []) {
    const pkg = typeof app?.id === 'string' ? app.id : '';
    if (!pkg) continue;
    const profiles: Profile[] = [];
    for (const group of app.groups ?? []) {
      const category = APP_CATEGORIES.find((c) => String(group?.name ?? '').startsWith(c.prefix));
      if (!category) continue;
      if (group.enable === false) continue;
      const when = category.when;
      const baseActivities = normalizeActivities(group.activityIds);
      const matchTime = when === 'splash'
        ? Math.min(15000, Math.max(8000, Number(group.matchTime) || 10000))
        : 15000;
      const actionMaximum = Math.min(3, Math.max(1, Number(group.actionMaximum) || 2));

      // 每个 activity 组合一个 profile；规则级 activityIds 优先于组级
      const byActivity = new Map<string, Profile>();
      const profileFor = (activities: string[]): Profile => {
        const key = activities.join('|');
        let profile = byActivity.get(key);
        if (!profile) {
          profile = { activityIds: activities, when, matchTime, actionMaximum, selectors: [], excludes: [] };
          byActivity.set(key, profile);
        }
        return profile;
      };

      for (const rule of (Array.isArray(group.rules) ? group.rules : [])) {
        if (!rule || typeof rule !== 'object' || rule.enable === false || !isClickAction(rule)) continue;
        const activities = normalizeActivities(rule.activityIds);
        const profile = profileFor(activities.length > 0 ? activities : baseActivities);
        for (const raw of [...textList(rule.matches), ...textList(rule.anyMatches)]) {
          const parsed = parseSelector(raw);
          if (parsed) profile.selectors.push(parsed);
        }
        for (const raw of textList(rule.excludeMatches)) {
          const parsed = parseSelector(raw);
          if (parsed) profile.excludes.push(parsed);
        }
      }

      let added = 0;
      for (const profile of byActivity.values()) {
        if (profile.selectors.length === 0) continue;
        added += profile.selectors.length;
        profiles.push({
          activityIds: profile.activityIds,
          when,
          matchTime,
          actionMaximum,
          selectors: uniqSelectors(profile.selectors),
          excludes: uniqSelectors(profile.excludes),
        });
      }
      if (added === 0) skippedGroups += 1;
    }
    if (profiles.length > 0) {
      apps[pkg] = { name: typeof app.name === 'string' ? app.name : pkg, profiles };
      importedApps += 1;
    }
  }

  const output = {
    schema: 3,
    source: {
      repo: 'Lin-arm/GKD_subscription',
      version: dist.version ?? null,
      importedAt: new Date().toISOString(),
      note: 'Derived from 开屏/全屏/局部广告 groups and the global selector library; selectors normalized to a safe subset.',
    },
    global: {
      matchTime: 12000,
      actionMaximum: 3,
      selectors: uniqSelectors(globalSelectors),
      excludes: uniqSelectors(globalExcludes),
      excludedApps: [
        'com.somnacare.sleep', 'com.android.systemui', 'com.android.settings',
        'com.tencent.mm', 'com.eg.android.AlipayGphone', 'com.tencent.wetype',
        'com.github.android', 'org.telegram.messenger', 'org.telegram.messenger.web',
        'org.telegram.plus', 'com.twitter.android', 'moe.shizuku.privileged.api',
        'li.songe.gkd', 'li.songe.gkd.debug', 'com.rosan.dhizuku',
        // 常驻规则上线后把常见桌面也排除：误点代价最高的地方（第 67 轮）
        'com.android.launcher3', 'com.miui.home', 'com.huawei.android.launcher',
        'com.sec.android.app.launcher', 'com.google.android.apps.nexuslauncher',
      ],
    },
    apps,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  // 紧凑序列化：美化打印白吃 ~40% 体积（1.27MB → ~0.8MB），规则表由
  // verify-ad-skip 做结构审计，不依赖缩进
  writeFileSync(OUTPUT, JSON.stringify(output), 'utf-8');
  const selectors = Object.values(apps).reduce((n, a) => n + a.profiles.reduce((m, p) => m + p.selectors.length, 0), 0);
  const inAppSelectors = Object.values(apps).reduce((n, a) => n + a.profiles.reduce((m, p) => m + (p.when === 'inApp' ? p.selectors.length : 0), 0), 0);
  console.log(`✓ 导入 ${importedApps} 个应用 / ${selectors} 条应用级选择器（其中应用内广告 ${inAppSelectors} 条）/ ${output.global.selectors.length} 条全局选择器`);
  console.log(`  全局库：开屏 ${librarySplash} 条 / 常驻卡片关闭 ${libraryAlways} 条`);
  console.log(`  跳过 ${skippedGroups} 个无法安全解析的组`);
  console.log(`  → ${OUTPUT}`);
}

main();
