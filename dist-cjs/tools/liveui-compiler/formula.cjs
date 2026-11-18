const { LIVEUI_BUDGETS, LIVEUI_OPERATORS } = require("../liveui-registry/operators.cjs");

const BUDGET = LIVEUI_BUDGETS;
const OPERATORS                                      = new Map(LIVEUI_OPERATORS.map((op) => [op.name, op]));
const ROOT_KEYS = new Set(["state", "data", "sel", "prev", "ref"]);

const PREFIX_ROOTS = new Set(["sel", "data", "prev", "state"]);

const LIVEUI_GUARDED_SEGMENTS                      = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_NAMES = new Set(["true", "false", "null", "sel", "data", "prev", "state", "ref"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMER_READINGS                                                                         = {
  countdown: { main: "remaining", readings: ["remaining", "status"] },
  elapsed: { main: "elapsed", readings: ["elapsed", "status"] },
};

const MAX_TOKENS = 1024;
const MAX_NESTING = 64;

class FormulaFailure extends Error {
  code                         ;
  failedName                    ;
  constructor(code                         , detail        , failedName         ) {
    super(detail);
    this.code = code;
    this.failedName = failedName;
  }
}

function liveUiNameProblem(name        )                {
  if (typeof name !== "string" || !NAME_RE.test(name)) return `${JSON.stringify(name)} is not a name`;
  if (LIVEUI_GUARDED_SEGMENTS.has(name)) return `${name} is a guarded name`;
  if (RESERVED_NAMES.has(name)) return `${name} is a reserved word`;
  return null;
}

function columnNameProblem(name        )                {
  return ROOT_KEYS.has(name) ? null : liveUiNameProblem(name);
}

const VALUE_TYPES                      = new Set(["number", "text", "bool", "null", "any"]);

function typedNames(input                            )                               {
  const out = new Map                         ();
  const entries                           = Array.isArray(input)
    ? input.map((name        )                    => [name, "any"])
    : Object.entries(input ?? {});
  for (const [name, type] of entries) {
    if (liveUiNameProblem(name) !== null) continue;
    out.set(name, typeof type === "string" && VALUE_TYPES.has(type) ? (type                   ) : "any");
  }
  return out;
}

function indexNames(names                    )            {
  const timers = new Map                         ();
  for (const [id, mode] of Object.entries(names.timers ?? {})) {
    if (liveUiNameProblem(id) === null && (mode === "countdown" || mode === "elapsed")) timers.set(id, mode);
  }
  const cols = new Set        ();
  for (const col of names.cols ?? []) if (columnNameProblem(col) === null) cols.add(col);
  const lists = new Map                           ();
  for (const [id, listCols] of Object.entries(names.lists ?? {})) {
    if (liveUiNameProblem(id) === null && Array.isArray(listCols)) lists.set(id, listCols);
  }
  const inputs = new Set        ();
  for (const key of names.inputs ?? []) if (liveUiNameProblem(key) === null) inputs.add(key);
  return { lets: typedNames(names.lets), steppers: typedNames(names.steppers), timers, cols, lists, inputs };
}

function lookupName(name        , index           )            {
  const hits            = [];
  const dot = name.indexOf(".");
  if (dot < 0) {
    if (index.lets.has(name)) hits.push({ kind: "let", node: { ref: name }, type: index.lets.get(name) ?? "any" });
    if (index.steppers.has(name)) {
      hits.push({ kind: "stepper", node: { state: `/${name}` }, type: index.steppers.get(name) ?? "any" });
    }
    const mode = index.timers.get(name);
    if (mode) hits.push({ kind: "timer", node: { ref: `${name}.${TIMER_READINGS[mode].main}` }, type: "number" });
    if (index.cols.has(name)) hits.push({ kind: "col", node: { sel: name }, type: "any" });
    if (index.lists.has(name)) hits.push({ kind: "list", node: { ref: name }, type: "list" });
    return hits;
  }
  const id = name.slice(0, dot);
  const reading = name.slice(dot + 1);
  const mode = index.timers.get(id);
  if (mode && TIMER_READINGS[mode].readings.includes(reading)) {
    hits.push({ kind: "timer", node: { ref: name }, type: reading === "status" ? "text" : "number" });
  }
  return hits;
}

function inputHit(name        )          {
  return { kind: "root", node: { data: `/${name}` }, type: "any" };
}

function describeKinds(hits           )         {
  const words                           = { let: "let", stepper: "stepper", timer: "timer", col: "column", list: "list", root: "root" };
  return hits.map((hit) => words[hit.kind]).join(", ");
}

function resolveInfixName(name        , index                  )          {
  const dot = name.indexOf(".");
  const head = dot < 0 ? name : name.slice(0, dot);
  if (dot > 0 && PREFIX_ROOTS.has(head)) {
    const segments = name.slice(dot + 1).split(".");
    if (head === "sel" || head === "state") {
      if (segments.length !== 1) {
        throw new FormulaFailure("undeclared_name", `${head} takes one name, not ${segments.join(".")}`, name);
      }
      return head === "sel"
        ? { kind: "col", node: { sel: segments[0] }, type: "any" }
        : { kind: "stepper", node: { state: `/${segments[0]}` }, type: "any" };
    }
    return { kind: "root", node: { [head]: `/${segments.join("/")}` }, type: "any" };
  }
  const hits = index ? lookupName(name, index) : [];
  if (hits.length === 0 && index && index.inputs.has(name)) return inputHit(name);
  if (hits.length === 0) throw new FormulaFailure("undeclared_name", `undeclared name ${name}`, name);
  if (hits.length > 1) {
    throw new FormulaFailure("ambiguous_name", `ambiguous name ${name} (${describeKinds(hits)})`, name);
  }
  return hits[0];
}

function stateKeyName(path        )                {
  const key = path.startsWith("/") ? path.slice(1) : path;
  return NAME_RE.test(key) ? key : null;
}

function resolveTreeRoot(
  root        ,
  path        ,
  index                  ,
  repairs                           ,
)                                                                     {
  const asWritten = { node: { [root]: path }, type: "any"                   , kind: "root"             };
  if (!index || root === "data" || root === "prev") return asWritten;
  const ownKinds             = root === "ref" ? ["let", "timer", "list"] : root === "state" ? ["stepper"] : ["col"];
  const name = root === "state" ? stateKeyName(path) : path;
  const hits = name === null ? [] : lookupName(name, index);
  const own = hits.filter((hit) => ownKinds.includes(hit.kind));
  const pick = own.length > 0 ? own : hits;
  if (pick.length === 1) {
    const hit = pick[0];
    if (JSON.stringify(hit.node) !== JSON.stringify(asWritten.node)) repairs.push("root_repaired");
    return hit;
  }
  if (pick.length > 1 && (own.length > 0 || root === "ref")) {
    throw new FormulaFailure("ambiguous_name", `ambiguous name ${name} (${describeKinds(pick)})`, name ?? path);
  }
  if (root === "ref" && name !== null && index.inputs.has(name)) {
    repairs.push("root_repaired");
    return inputHit(name);
  }
  if (root === "ref") throw new FormulaFailure("undeclared_name", `undeclared name ${path}`, path);
  return asWritten;
}

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
const ONE_CHAR_OPS = new Set(["+", "-", "*", "/", "<", ">", "(", ")", ","]);
const COMPARE                         = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };

function tokenize(text        , repairs                           )          {
  const tokens          = [];
  let i = 0;
  while (i < text.length) {
    if (tokens.length > MAX_TOKENS) throw new FormulaFailure("too_many_nodes", "formula text is too long");
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    const num = /^[0-9]+(?:\.[0-9]+)?/.exec(rest);
    if (num) {
      const value = Number(num[0]);
      if (!Number.isFinite(value)) throw new FormulaFailure("parse", `number ${num[0].slice(0, 12)}… is too large`);
      tokens.push({ t: "num", v: value, at: i });
      i += num[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) throw new FormulaFailure("parse", `text at ${i} is not closed`);
      tokens.push({ t: "text", v: text.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest);
    if (name) {
      tokens.push({ t: "name", v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ t: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if (two === "&&" || two === "||") {
      repairs.push("formula_operator_repaired");
      tokens.push({ t: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if (ch === "=") {
      repairs.push("formula_operator_repaired");
      tokens.push({ t: "op", v: "==", at: i });
      i++;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ t: "op", v: ch, at: i });
      i++;
      continue;
    }
    throw new FormulaFailure("parse", `unexpected ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

class NameRef {
  name        ;
  constructor(name        ) {
    this.name = name;
  }
}

function describeToken(token                   )         {
  if (!token) return "the end";
  if (token.t === "text") return `text at ${token.at}`;
  return `${JSON.stringify(String(token.v))} at ${token.at}`;
}

function parseInfix(text        , repairs                           )          {
  const tokens = tokenize(text, repairs);
  if (tokens.length === 0) throw new FormulaFailure("parse", "empty formula");
  let p = 0;
  let nesting = 0;
  const peek = ()                    => tokens[p];
  const isOp = (token                   , v        )          => token?.t === "op" && token.v === v;
  const expect = (v        )       => {
    const token = tokens[p];
    if (!isOp(token, v)) throw new FormulaFailure("parse", `expected ${JSON.stringify(v)}, found ${describeToken(token)}`);
    p++;
  };
  const enter = ()       => {
    if (++nesting > MAX_NESTING) throw new FormulaFailure("too_deep", `nested more than ${MAX_NESTING} levels`);
  };

  function or()          {
    let left = and();
    while (isOp(peek(), "||")) {
      p++;
      left = { or: [left, and()] };
    }
    return left;
  }
  function and()          {
    let left = compare();
    while (isOp(peek(), "&&")) {
      p++;
      left = { and: [left, compare()] };
    }
    return left;
  }
  function compare()          {
    const left = sum();
    const token = peek();
    if (token?.t !== "op" || !COMPARE[token.v]) return left;
    p++;
    const node = { [COMPARE[token.v]]: [left, sum()] };
    const after = peek();
    if (after?.t === "op" && COMPARE[after.v]) {
      throw new FormulaFailure("parse", `comparisons do not chain (${describeToken(after)})`);
    }
    return node;
  }
  function sum()          {
    let left = product();
    for (let token = peek(); isOp(token, "+") || isOp(token, "-"); token = peek()) {
      p++;
      left = { [token?.v === "+" ? "add" : "sub"]: [left, product()] };
    }
    return left;
  }
  function product()          {
    let left = unary();
    for (let token = peek(); isOp(token, "*") || isOp(token, "/"); token = peek()) {
      p++;
      left = { [token?.v === "*" ? "mul" : "div"]: [left, unary()] };
    }
    return left;
  }
  function unary()          {
    if (isOp(peek(), "-")) {
      p++;
      enter();
      const node = { neg: [unary()] };
      nesting--;
      return node;
    }
    return primary();
  }
  function primary()          {
    const token = tokens[p++];
    if (!token) throw new FormulaFailure("parse", "unexpected end");
    if (token.t === "num" || token.t === "text") return token.v;
    if (isOp(token, "(")) {
      enter();
      const inner = or();
      expect(")");
      nesting--;
      return inner;
    }
    if (token.t === "name") {
      if (isOp(peek(), "(")) {
        if (!OPERATORS.has(token.v)) throw new FormulaFailure("unknown_operator", `unknown operator ${token.v}`);
        p++;
        enter();
        const args            = [];
        if (!isOp(peek(), ")")) {
          args.push(or());
          while (isOp(peek(), ",")) {
            p++;
            args.push(or());
          }
        }
        expect(")");
        nesting--;
        return { [token.v]: args };
      }
      if (token.v === "true") return true;
      if (token.v === "false") return false;
      if (token.v === "null") return null;
      return new NameRef(token.v);
    }
    throw new FormulaFailure("parse", `unexpected ${describeToken(token)}`);
  }

  const tree = or();
  if (p < tokens.length) throw new FormulaFailure("parse", `unexpected ${describeToken(tokens[p])}`);
  return tree;
}

const isPlainObject = (v         )                               =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof NameRef);
const isLiteral = (v         )                                        =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

function checkShape(node         , depth        , seen                   )       {
  if (depth > MAX_TOKENS) throw new FormulaFailure("too_deep", `nested more than ${MAX_TOKENS} levels`);
  if (++seen.nodes > MAX_TOKENS) throw new FormulaFailure("too_many_nodes", `more than ${MAX_TOKENS} nodes`);
  if (isLiteral(node) || node instanceof NameRef) return;
  if (!isPlainObject(node)) throw new FormulaFailure("bad_root", "not a literal or a node");
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new FormulaFailure("bad_root", `a node with ${keys.length} keys`);
  const [key] = keys;
  const value = node[key];
  if (ROOT_KEYS.has(key)) {
    if (typeof value !== "string") throw new FormulaFailure("bad_root", `${key} needs a text path`);
    return;
  }
  if (!Array.isArray(value)) throw new FormulaFailure("bad_root", `${key} needs an argument list`);
  for (const arg of value) checkShape(arg, depth + 1, seen);
}

function operatorNode(node         )                             {
  if (!isPlainObject(node)) return null;
  const [key] = Object.keys(node);
  return ROOT_KEYS.has(key) ? null : [key, node[key]             ];
}

function eachOperator(node         , visit                                         )       {
  const op = operatorNode(node);
  if (!op) return;
  visit(op[0], op[1]);
  for (const arg of op[1]) eachOperator(arg, visit);
}

function measure(node         )                                                  {
  const op = operatorNode(node);
  if (!op) return { nodes: 1, depth: 1, steps: 1 };
  let nodes = 1;
  let depth = 0;
  let steps = OPERATORS.get(op[0])?.cost ?? 1;
  for (const arg of op[1]) {
    const m = measure(arg);
    nodes += m.nodes;
    depth = Math.max(depth, m.depth);
    steps += m.steps;
  }
  return { nodes, depth: depth + 1, steps };
}

function literalType(v                                  )                  {
  if (v === null) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "text";
  return "bool";
}

const fits = (want                 , got                 )          =>
  want === "list" || got === "list" ? want === got : want === "any" || got === "any" || got === "null" || want === got;

const AGGREGATE_FILTERS                      = new Set(["ticked"]);

function normalizeAggregates(node         , index                  )          {
  const op = operatorNode(node);
  if (!op) return node;
  const [name, rawArgs] = op;
  let args = rawArgs.map((arg) => normalizeAggregates(arg, index));
  if (name === "sum" && index) {
    const [first, second] = args;
    if (first instanceof NameRef && first.name.includes(".")) {
      const dot = first.name.indexOf(".");
      const id = first.name.slice(0, dot);
      const col = first.name.slice(dot + 1);
      if (index.lists.get(id)?.includes(col)) args = [new NameRef(id), col, ...args.slice(1)];
    } else if (first instanceof NameRef && second instanceof NameRef && index.lists.get(first.name)?.includes(second.name)) {
      args = [first, second.name, ...args.slice(2)];
    }
  }
  return { [name]: args };
}

function aggregateList(name        , raw         , index                  , repairs                           )         {
  const wrong = ()                 => new FormulaFailure("type", `${name} argument 1 is not a list id`);
  let hit                                                    ;
  if (raw instanceof NameRef) {
    hit = resolveInfixName(raw.name, index);
  } else if (isPlainObject(raw) && !operatorNode(raw)) {
    const [root] = Object.keys(raw);
    const path = raw[root];
    if (typeof path !== "string") throw wrong();

    if (!index) {
      if (root !== "ref") throw wrong();
      return path;
    }
    hit = resolveTreeRoot(root, path, index, repairs);
  } else {
    throw wrong();
  }
  const ref = isPlainObject(hit.node) ? (hit.node                           ).ref : undefined;
  if (hit.type !== "list" || typeof ref !== "string") throw wrong();
  return ref;
}

function resolveAggregate(
  name        ,
  rawArgs           ,
  index                  ,
  repairs                           ,
  lets             ,
)        {
  const list = aggregateList(name, rawArgs[0], index, repairs);
  const cols = index?.lists.get(list);
  const args                      = [{ ref: list }];
  const textArg = (raw         , i        , check                        )       => {
    if (typeof raw === "string") {
      check(raw);
      args.push(raw);
      return;
    }
    const typed = resolveAndType(raw, index, repairs, lets);
    if (!fits("text", typed.type)) throw new FormulaFailure("type", `${name} argument ${i + 1} is ${typed.type}, wants text`);
    args.push(typed.tree);
  };
  let i = 1;
  if (name === "sum") {
    textArg(rawArgs[i], i, (col) => {
      if (cols && !cols.includes(col)) throw new FormulaFailure("undeclared_name", `${list} has no column ${col}`, `${list}.${col}`);
    });
    i += 1;
  }
  if (i < rawArgs.length) {
    textArg(rawArgs[i], i, (filter) => {
      if (!AGGREGATE_FILTERS.has(filter)) throw new FormulaFailure("type", `${name} argument ${i + 1} is '${filter}', wants 'ticked'`);
    });
  }
  return { tree: { [name]: args }, type: "number" };
}

function resolveAndType(
  node         ,
  index                  ,
  repairs                           ,
  lets             ,
)        {
  if (node instanceof NameRef) {
    const hit = resolveInfixName(node.name, index);
    if (hit.kind === "let") lets.add(node.name);
    return { tree: hit.node, type: hit.type };
  }
  if (isLiteral(node)) return { tree: node, type: literalType(node) };
  const op = operatorNode(node);
  if (!op) {
    const [root] = Object.keys(node          );
    const path = (node                          )[root];
    const resolved = resolveTreeRoot(root, path, index, repairs);
    const ref = (resolved.node                           ).ref;
    if (typeof ref === "string" && (index ? resolved.kind === "let" : !ref.includes("."))) lets.add(ref);
    return { tree: resolved.node, type: resolved.type };
  }
  const [name, rawArgs] = op;
  const sig = OPERATORS.get(name)                  ;
  if (sig.group === "aggregate") return resolveAggregate(name, rawArgs, index, repairs, lets);
  let args = rawArgs.map((arg) => resolveAndType(arg, index, repairs, lets));
  if (name === "concat" && args.some((arg) => arg.type === "number")) {

    args = args.map((arg) => (arg.type === "number" ? { tree: { fmt: [arg.tree, "num"] }, type: "text" } : arg));
    repairs.push("fmt_inserted");
  }
  args.forEach((arg, i) => {
    const want = i < sig.params.length ? sig.params[i] : sig.rest ?? "any";
    if (!fits(want, arg.type)) {
      throw new FormulaFailure("type", `${name} argument ${i + 1} is ${arg.type}, wants ${want}`);
    }
  });
  let type                 ;
  if (sig.result !== "same") {
    type = sig.result;
  } else {
    const from = sig.resultFrom ?? [];
    const picked = args
      .filter((_, i) => from.includes(i) || (from.includes("rest") && i >= sig.params.length))
      .map((arg) => arg.type)
      .filter((t) => t !== "null");
    const known = [...new Set(picked)];
    type = known.length === 1 ? known[0] : "any";
  }
  return { tree: { [name]: args.map((arg) => arg.tree) }, type };
}

function checkTree(
  raw         ,
  index                  ,
  repairs                           ,
  options                      ,
)                        {
  checkShape(raw, 1, { nodes: 0 });
  eachOperator(raw, (name) => {
    if (!OPERATORS.has(name)) throw new FormulaFailure("unknown_operator", `unknown operator ${name}`);
  });
  raw = normalizeAggregates(raw, index);
  eachOperator(raw, (name, args) => {
    const { minArgs, maxArgs } = OPERATORS.get(name)                  ;
    if (args.length < minArgs || (maxArgs !== null && args.length > maxArgs)) {
      const want = maxArgs === null ? `${minArgs} or more` : minArgs === maxArgs ? `${minArgs}` : `${minArgs}-${maxArgs}`;
      const noun = want === "1" ? "argument" : "arguments";
      throw new FormulaFailure("arity", `${name} takes ${want} ${noun}, got ${args.length}`);
    }
  });
  const budget = (node         )                             => {
    const m = measure(node);
    if (m.nodes > BUDGET.nodesPerFormula) {
      throw new FormulaFailure("too_many_nodes", `${m.nodes} nodes, budget ${BUDGET.nodesPerFormula}`);
    }
    if (m.depth > BUDGET.formulaDepth) throw new FormulaFailure("too_deep", `depth ${m.depth}, budget ${BUDGET.formulaDepth}`);
    return m;
  };
  let m = budget(raw);
  const lets = new Set        ();
  const typed = resolveAndType(raw, index, repairs, lets);
  if (repairs.includes("fmt_inserted")) m = budget(typed.tree           );
  if (typed.type === "list") throw new FormulaFailure("type", "a list is not a value; count or sum it");
  const type = typed.type;
  const want = options.expect;
  if (want && !fits(want, type)) throw new FormulaFailure("type", `the field wants ${want}, the formula gives ${type}`);
  const binding = isPlainObject(typed.tree) && ROOT_KEYS.has(Object.keys(typed.tree)[0]);
  return {
    ok: true,
    tree: typed.tree,
    type,
    nodes: m.nodes,
    depth: m.depth,
    steps: m.steps,
    lets: [...lets],
    binding,
    repairs: [...new Set(repairs)],
  };
}

function compileLiveUiFormula(
  source         ,
  names                     ,
  options                       = {},
)                      {
  const repairs                            = [];
  try {
    const index = names ? indexNames(names) : null;
    let raw         ;
    if (typeof source === "string") {
      let text = source.trim();
      if (text.startsWith("=") && !text.startsWith("==")) text = text.slice(1).trim();
      if (text.startsWith("{")) {
        try {
          raw = JSON.parse(text)           ;
        } catch {
          throw new FormulaFailure("parse", "the tree is not valid JSON");
        }
      } else {
        raw = parseInfix(text, repairs);
      }
    } else {
      raw = source           ;
    }
    return checkTree(raw, index, repairs, options);
  } catch (err) {
    if (err instanceof FormulaFailure) {
      return {
        ok: false,
        code: err.code,
        detail: err.message,
        ...(err.failedName !== undefined ? { name: err.failedName } : {}),
        repairs: [...new Set(repairs)],
      };
    }
    if (err instanceof RangeError) {
      return { ok: false, code: "too_deep", detail: "the formula nests too deeply", repairs: [...new Set(repairs)] };
    }
    throw err;
  }
}

module.exports = { LIVEUI_GUARDED_SEGMENTS, liveUiNameProblem, compileLiveUiFormula };
