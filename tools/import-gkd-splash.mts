/**
 * 从 GKD_subscription 的 dist/gkd.json5 提取“开屏广告”规则，生成
 * cap-gemma-llm 原生侧使用的安全子集规则表。
 *
 * 用法：
 *   npx tsx tools/import-gkd-splash.mts /path/to/GKD_subscription/dist/gkd.json5
 *
 * 说明（第 63 轮）：
 *  - 用户明确要求参考 GKD_subscription，并自行承担版权责任；
 *  - 这里只提取「开屏广告」组，不导入更新提示/青少年模式等其它规则；
 *  - GKD 选择器 DSL 被归一化为 JSON AST，原生侧不解析 DSL；
 *  - 关系型选择器（@ / > / + / - / <）只提取 @ 目标或最后一个可识别节点，
 *    并附加上下文关键词；执行时仍受“启动 15s 内 + 小尺寸 + 可点击”约束；
 *  - 纯结构选择器（无 text/desc/vid/name 谓词）直接跳过，避免误点。
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
type NumField = 'width' | 'height' | 'childCount' | 'top' | 'left' | 'right' | 'bottom';
type BoolField = 'clickable' | 'visibleToUser' | 'enabled' | 'focusable' | 'scrollable';
type Op = '=' | '!=' | '<' | '<=' | '>' | '>=';

type Predicate =
  | { k: 'eq' | 'contains' | 'starts' | 'ends' | 'regex'; f: Field; v: string }
  | { k: 'notEq' | 'notContains' | 'notStarts' | 'notEnds' | 'notRegex'; f: Field; v: string }
  | { k: 'len' | 'num'; f: Field | NumField; op: Op; v: number }
  | { k: 'bool'; f: BoolField; v: boolean }
  | { k: 'null'; f: Field; v: boolean }
  | { k: 'type'; v: string }
  | { k: 'all' | 'any'; p: Predicate[] }
  | { k: 'not'; p: Predicate };

interface Selector {
  expr: Predicate;
  ancestor?: boolean;
  ctx?: string[];
}

interface Profile {
  activityIds: string[];
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
  'text', 'desc', 'vid', 'id', 'name', 'className',
  'width', 'height', 'childCount', 'top', 'left', 'right', 'bottom',
  'index', 'depth',
  'clickable', 'visibleToUser', 'enabled', 'focusable', 'scrollable',
]);
const BOOL_FIELDS = new Set(['clickable', 'visibleToUser', 'enabled', 'focusable', 'scrollable']);
const NUM_FIELDS = new Set(['width', 'height', 'childCount', 'top', 'left', 'right', 'bottom']);
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
const REL = new Set(['@', '>', '<', '+', '-']);
const AD_WORDS = ['跳过', '跳過', '广告', '廣告', 'skip', 'close', '关闭', '關閉', 'jump', 'count', 'timer'];

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
    if (field === 'index' || field === 'depth') throw new Unsupported(`unsupported ${field}`);

    const dot = this.peek();
    if (dot?.t === 'punc' && dot.v === '.') {
      this.pos += 1;
      const attr = this.take();
      if (attr.t !== 'id' || attr.v !== 'length') throw new Unsupported('unsupported attribute');
      const op = this.take();
      const val = this.take();
      if (op.t !== 'op' || val.t !== 'num') throw new Unsupported('length value');
      return { k: 'len', f: field as Field, op: normalizeOp(op.v), v: Number(val.v) };
    }

    const next = this.peek();
    if (BOOL_FIELDS.has(field) && !(next?.t === 'op')) {
      return { k: 'bool', f: field as BoolField, v: true };
    }
    if (!next || next.t !== 'op') throw new Unsupported('operator expected');
    const op = this.take() as Token;
    const value = this.take();

    if (value.t === 'null') {
      return { k: 'null', f: field as Field, v: true };
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
function splitTopLevel(selector: string): { segments: string[]; relations: string[] } {
  const segments: string[] = [];
  const relations: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && REL.has(ch)) {
      segments.push(current.trim());
      current = '';
      relations.push(ch);
      i += 1;
      while (selector[i] === ' ') i += 1;
      if (selector[i] === '(') {
        let d = 0;
        do {
          if (selector[i] === '(') d += 1;
          if (selector[i] === ')') d -= 1;
          i += 1;
        } while (i < selector.length && d > 0);
      } else {
        while (i < selector.length && /[0-9n]/.test(selector[i])) i += 1;
      }
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current.trim());
  return { segments, relations };
}

function collectQuoted(selector: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{2,40})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(selector))) {
    const v = m[1];
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 8);
}

function collectContext(selector: string, targetHasIdentity: boolean): string[] {
  if (targetHasIdentity) return [];
  const quoted = collectQuoted(selector);
  const strong = quoted.filter((v) => AD_WORDS.some((w) => v.toLowerCase().includes(w.toLowerCase())));
  return (strong.length > 0 ? strong : quoted).slice(0, 8);
}

function hasIdentity(pred: Predicate): boolean {
  switch (pred.k) {
    // 只有“正向的文字/描述/控件 id”算可识别身份；类名和负向谓词太泛，
    // 不能单独用来点一个节点（否则 [name$="View"] 会命中任意小 View）
    case 'eq': case 'contains': case 'starts': case 'ends': case 'regex':
      return pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id';
    case 'all': case 'any':
      return pred.p.some(hasIdentity);
    case 'not':
      return false;
    default:
      return false;
  }
}

function hasStructuralConstraint(pred: Predicate): boolean {
  switch (pred.k) {
    case 'num':
      return pred.f === 'width' || pred.f === 'height' || pred.f === 'childCount';
    case 'all': case 'any':
      return pred.p.some(hasStructuralConstraint);
    default:
      return false;
  }
}

const STRONG_CONTEXT = [
  '跳过', '跳過', '广告', '廣告', 'skip', 'close', '关闭', '關閉',
  '互动广告', '摇一摇', '扭动', '第三方应用', '点击或上滑', '省钱好物',
  'splash', 'ksad', 'sdk_view', 'sdk',
];

function hasStrongContext(values: string[]): boolean {
  return values.some((v) => {
    const lower = v.toLowerCase();
    return STRONG_CONTEXT.some((w) => lower.includes(w.toLowerCase()));
  });
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

function parseSelectorExpr(raw: string, allowNoIdentity = false): Predicate | null {
  const text = raw.trim();
  if (!text) return null;
  if (splitTopLevel(text).relations.length > 0) return null;
  const tokens = selectorTokens(text);
  if (tokens.length === 0) return null;
  try {
    const expr = new SelectorExprParser(tokens).parse();
    if (!hasIdentity(expr) && !allowNoIdentity) {
      if (process.env.DEBUG_GKD) console.error('NO IDENTITY', text.slice(0, 160));
      return null;
    }
    if (isAdLabelOnly(expr)) {
      if (process.env.DEBUG_GKD) console.error('AD LABEL ONLY', text.slice(0, 160));
      return null;
    }
    return expr;
  } catch (e) {
    if (process.env.DEBUG_GKD) console.error('SELECTOR PARSE ERR', (e as Error).message, text.slice(0, 160));
    return null;
  }
}

function parseSelector(raw: string): Selector | null {
  const selector = raw.trim();
  if (!selector) return null;
  const { segments, relations } = splitTopLevel(selector);
  if (relations.length === 0) {
    const expr = parseSelectorExpr(selector);
    return expr ? { expr } : null;
  }
  const atIndex = relations.indexOf('@');
  let target: string | null = null;
  if (atIndex >= 0) {
    for (let i = atIndex + 1; i < segments.length; i += 1) {
      if (segments[i]) { target = segments[i]; break; }
    }
  }
  if (!target) {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (!segments[i]) continue;
      const candidate = parseSelectorExpr(segments[i]);
      if (candidate && hasIdentity(candidate)) { target = segments[i]; break; }
    }
  }
  if (!target) {
    if (process.env.DEBUG_GKD) console.error('NO TARGET', selector.slice(0, 180));
    return null;
  }
  const expr = parseSelectorExpr(target, true);
  if (!expr) {
    if (process.env.DEBUG_GKD) console.error('TARGET PARSE FAIL', target.slice(0, 180));
    return null;
  }
  const targetHasIdentity = hasIdentity(expr);
  const ctx = collectContext(selector, targetHasIdentity);
  if (!targetHasIdentity) {
    // 无文字/id 的目标必须是“小而具体”的节点：只有 clickable=true 的选择器
    // 可能在任意页面点到错误控件，一律丢弃；上下文也必须含广告/跳过强信号。
    if (!hasStructuralConstraint(expr)) {
      if (process.env.DEBUG_GKD) console.error('NO STRUCTURE', selector.slice(0, 180));
      return null;
    }
    if (ctx.length === 0 || !hasStrongContext(ctx)) {
      if (process.env.DEBUG_GKD) console.error('WEAK CONTEXT', selector.slice(0, 180));
      return null;
    }
  }
  return { expr, ancestor: true, ...(ctx.length > 0 ? { ctx } : {}) };
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

function main(): void {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('用法: npx tsx tools/import-gkd-splash.mts /path/to/GKD_subscription/dist/gkd.json5');
    process.exit(1);
  }
  const inputPath = resolve(inputArg);
  const dist = JSON5.parse(readFileSync(inputPath, 'utf-8')) as Json;

  const globalGroup = (dist.globalGroups ?? []).find((g: Json) => String(g?.name ?? '').includes('开屏'));
  if (!globalGroup) throw new Error('GKD 数据里找不到“开屏广告-全局”组');

  const globalSelectors: Selector[] = [];
  const globalExcludes: Selector[] = [];
  for (const rule of globalGroup.rules ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    for (const raw of [...textList(rule.matches), ...textList(rule.anyMatches)]) {
      const parsed = parseSelector(raw);
      if (parsed) globalSelectors.push(parsed);
      else if (process.env.DEBUG_GKD) console.error('GLOBAL SKIP', raw.slice(0, 220));
    }
    for (const raw of textList(rule.excludeMatches)) {
      const parsed = parseSelector(raw);
      if (parsed) globalExcludes.push(parsed);
      else if (process.env.DEBUG_GKD) console.error('GLOBAL EXCLUDE SKIP', raw.slice(0, 220));
    }
  }

  const apps: Record<string, AppRules> = {};
  let importedApps = 0;
  let skippedGroups = 0;
  for (const app of dist.apps ?? []) {
    const pkg = typeof app?.id === 'string' ? app.id : '';
    if (!pkg) continue;
    const profiles: Profile[] = [];
    for (const group of app.groups ?? []) {
      if (!String(group?.name ?? '').includes('开屏')) continue;
      if (group.enable === false) continue;
      const baseActivities = normalizeActivities(group.activityIds);
      const matchTime = Math.min(15000, Math.max(8000, Number(group.matchTime) || 10000));
      const actionMaximum = Math.min(3, Math.max(1, Number(group.actionMaximum) || 2));

      // 每个 activity 组合一个 profile；规则级 activityIds 优先于组级
      const byActivity = new Map<string, Profile>();
      const profileFor = (activities: string[]): Profile => {
        const key = activities.join('|');
        let profile = byActivity.get(key);
        if (!profile) {
          profile = { activityIds: activities, matchTime, actionMaximum, selectors: [], excludes: [] };
          byActivity.set(key, profile);
        }
        return profile;
      };

      for (const rule of group.rules ?? []) {
        if (!rule || typeof rule !== 'object' || rule.enable === false) continue;
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
    schema: 1,
    source: {
      repo: 'Lin-arm/GKD_subscription',
      version: dist.version ?? null,
      importedAt: new Date().toISOString(),
      note: 'Derived from 开屏广告 groups; selectors normalized to a safe subset.',
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
      ],
    },
    apps,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  const selectors = Object.values(apps).reduce((n, a) => n + a.profiles.reduce((m, p) => m + p.selectors.length, 0), 0);
  console.log(`✓ 导入 ${importedApps} 个应用 / ${selectors} 条应用级选择器 / ${output.global.selectors.length} 条全局选择器`);
  console.log(`  跳过 ${skippedGroups} 个无法安全解析的开屏组`);
  console.log(`  → ${OUTPUT}`);
}

main();
