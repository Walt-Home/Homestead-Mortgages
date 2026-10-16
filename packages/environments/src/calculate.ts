/**
 * The calculator a model is given: exact decimal arithmetic and nothing else.
 *
 * A small parser over the kernel's `Decimal`, never `eval`: numbers, the four
 * operators, parentheses, and six functions. Sums and products are exact;
 * a quotient is exact to 30 decimal places. Rounding happens only where the
 * expression asks for it, so a model that rounds where the rulebook says
 * gets the engine's figure and one that rounds early does not.
 */

import { Decimal } from "@hm/kernel/money";

const MAX_LENGTH = 500;
const MAX_DEPTH = 40;

type Token =
  | { readonly kind: "num"; readonly text: string }
  | { readonly kind: "id"; readonly text: string }
  | { readonly kind: "op"; readonly text: "+" | "-" | "*" | "/" | "(" | ")" | "," };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
      if (!m) throw new SyntaxError(`a malformed number at ${i}`);
      out.push({ kind: "num", text: m[0].startsWith(".") ? `0${m[0]}` : m[0] });
      i += m[0].length;
    } else if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_]+/i.exec(src.slice(i)) as RegExpExecArray;
      out.push({ kind: "id", text: m[0].toLowerCase() });
      i += m[0].length;
    } else if ("+-*/(),".includes(c)) {
      out.push({ kind: "op", text: c as "+" });
      i += 1;
    } else if (c === "×") {
      out.push({ kind: "op", text: "*" });
      i += 1;
    } else if (c === "÷") {
      out.push({ kind: "op", text: "/" });
      i += 1;
    } else if (c === "−") {
      out.push({ kind: "op", text: "-" });
      i += 1;
    } else {
      throw new SyntaxError(`unexpected character ${JSON.stringify(c)} at ${i}`);
    }
  }
  return out;
}

const integerOf = (d: Decimal, what: string): number => {
  const s = d.toString();
  if (!/^-?\d+$/.test(s)) throw new RangeError(`${what} must be a whole number, got ${s}`);
  const n = Number(s);
  if (n < 0 || n > 30) throw new RangeError(`${what} must be between 0 and 30, got ${s}`);
  return n;
};

const FUNCTIONS: ReadonlyMap<string, (args: Decimal[]) => Decimal> = new Map(
  Object.entries({
    round: (a) => {
      const [x, places] = a;
      if (!x || a.length > 2) throw new TypeError("round(x) or round(x, places)");
      const p = places ? integerOf(places, "places") : 0;
      return Decimal.parse(x.toFixed(p, "HALF_UP"));
    },
    floor: (a) => {
      if (a.length !== 1) throw new TypeError("floor(x)");
      return Decimal.fromBigInt((a[0] as Decimal).toScaledInt(0, "FLOOR"));
    },
    ceil: (a) => {
      if (a.length !== 1) throw new TypeError("ceil(x)");
      return Decimal.fromBigInt((a[0] as Decimal).toScaledInt(0, "CEIL"));
    },
    abs: (a) => {
      if (a.length !== 1) throw new TypeError("abs(x)");
      return (a[0] as Decimal).abs();
    },
    max: (a) => {
      if (a.length < 2) throw new TypeError("max(a, b, ...)");
      return a.reduce((m, x) => (x.cmp(m) > 0 ? x : m));
    },
    min: (a) => {
      if (a.length < 2) throw new TypeError("min(a, b, ...)");
      return a.reduce((m, x) => (x.cmp(m) < 0 ? x : m));
    },
  } satisfies Record<string, (args: Decimal[]) => Decimal>),
);

/** Evaluate an expression; the result is the exact decimal, trailing zeros dropped. */
export function calculate(expression: string): string {
  if (expression.length > MAX_LENGTH) throw new RangeError(`longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(expression);
  let pos = 0;
  let depth = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (t: Token | undefined, op: string) => t?.kind === "op" && t.text === op;
  const expect = (op: string) => {
    if (!isOp(peek(), op)) throw new SyntaxError(`expected "${op}" at token ${pos}`);
    pos += 1;
  };

  function sum(): Decimal {
    let v = product();
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const op = (peek() as Token).text;
      pos += 1;
      const r = product();
      v = op === "+" ? v.add(r) : v.sub(r);
    }
    return v;
  }
  function product(): Decimal {
    let v = unary();
    while (isOp(peek(), "*") || isOp(peek(), "/")) {
      const op = (peek() as Token).text;
      pos += 1;
      const r = unary();
      if (op === "*") v = v.mul(r);
      else {
        if (r.isZero()) throw new RangeError("division by zero");
        v = v.div(r);
      }
    }
    return v;
  }
  function unary(): Decimal {
    if (isOp(peek(), "-")) {
      pos += 1;
      return unary().neg();
    }
    if (isOp(peek(), "+")) {
      pos += 1;
      return unary();
    }
    return atom();
  }
  function atom(): Decimal {
    depth += 1;
    if (depth > MAX_DEPTH) throw new RangeError("nested too deeply");
    try {
      const t = peek();
      if (!t) throw new SyntaxError("the expression ends early");
      if (t.kind === "num") {
        pos += 1;
        return Decimal.parse(t.text);
      }
      if (t.kind === "id") {
        // A Map, not an object: `constructor` and `__proto__` are names, not functions.
        const fn = FUNCTIONS.get(t.text);
        if (!fn) {
          throw new SyntaxError(
            `unknown function ${t.text}; the functions are ${[...FUNCTIONS.keys()].join(", ")}`,
          );
        }
        pos += 1;
        expect("(");
        const args = [sum()];
        while (isOp(peek(), ",")) {
          pos += 1;
          args.push(sum());
        }
        expect(")");
        return fn(args);
      }
      if (isOp(t, "(")) {
        pos += 1;
        const v = sum();
        expect(")");
        return v;
      }
      throw new SyntaxError(`unexpected "${t.text}" at token ${pos}`);
    } finally {
      depth -= 1;
    }
  }

  const value = sum();
  if (pos !== tokens.length)
    throw new SyntaxError(`unexpected "${tokens[pos]?.text}" at token ${pos}`);
  return value.toString();
}
