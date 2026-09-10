/**
 * The copy rules, applied where the copy actually is.
 *
 * `@hm/shared/copy-rules` was already imported by four suites — the state
 * catalog, the outcomes, the ledger's words and the personas the API serves —
 * and every one of those reads a table of strings. None of them reads a
 * screen. So the rules held perfectly over roughly 200 lines of data and not
 * at all over the ~2,900 lines of JSX a borrower is actually looking at, which
 * is where every one of these leaked: a signing panel titled "Authorisation to
 * verify" above a checkbox that said "Authorize", a field labelled "Postcode",
 * rent that "counts in your favour", a promise of email and SMS on a product
 * with neither, and an upload branch printing the requirements sheet's own
 * wording at the person being asked for a document.
 *
 * This reads source rather than a rendered DOM for the same reason
 * `design-system.test.ts` does: the failure is a string, the string is in the
 * file, and rendering every screen in every state to find it would test the
 * router instead of the words.
 *
 * Two things it deliberately does not do:
 *
 * - It does not read comments. The margins of this codebase argue in British
 *   spelling in a few places and quote the internal vocabulary on purpose, and
 *   a rule that made those failures would be a rule people turned off.
 * - It does not read `DebugPanel.tsx` or `BrandPage.tsx`. The debug panel is
 *   the surface that exists so the requirement ids have somewhere to live; the
 *   brand page is a token reference. Neither is borrower-facing, and both say
 *   so at the top of the file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID } from "@hm/shared";

const SRC = new URL("..", import.meta.url).pathname;

/** Surfaces that are ours, not the borrower's. Both say so in their header. */
const NOT_BORROWER_FACING = new Set(["components/DebugPanel.tsx", "pages/BrandPage.tsx"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return path.endsWith(".tsx") ? [path] : [];
  });
}

export interface Phrase {
  readonly text: string;
  readonly line: number;
}

/**
 * Blank every comment and the inside of every string literal, in place.
 *
 * Length and line breaks are preserved so an offset in the result still names
 * a line in the original. Walking the file a character at a time rather than
 * running a regex over it is not fussiness: a regex that pairs quotes will
 * pair the *closing* backtick of one template with the *opening* backtick of
 * the next as soon as one apostrophe or one `//` inside a URL throws the count
 * off, and it then reports the code in between as borrower copy. That is how
 * the first draft of this file decided `let cancelled = false` was a British
 * spelling on a screen.
 */
function blank(source: string): { masked: string; literals: Phrase[] } {
  const out = source.split("");
  const literals: Phrase[] = [];
  const erase = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      erase(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      erase(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i += 1;
      let text = "";
      let depth = 0;
      let closed = false;
      while (i < source.length) {
        const ch = source[i];
        // Only a template literal may hold a newline. An apostrophe in JSX
        // text — "don't" — opens nothing, and treating it as a quote would
        // swallow every line down to the next one.
        if (ch === "\n" && c !== "`") break;
        if (ch === "\\") {
          text += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (depth > 0) {
          // Inside `${…}`. Track braces so a nested object literal does not
          // end the expression early; the expression itself is code.
          if (ch === "{") depth += 1;
          if (ch === "}") depth -= 1;
          i += 1;
          continue;
        }
        if (c === "`" && ch === "$" && source[i + 1] === "{") {
          text += " ";
          depth = 1;
          i += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          break;
        }
        text += ch === "\n" ? " " : ch;
        i += 1;
      }
      if (!closed) {
        // Not a string after all. Leave the character where it is and read on
        // from just past it, so the run it sits in is still read as prose.
        i = start + 1;
        continue;
      }
      erase(start + 1, i);
      i += 1;
      if (/[A-Za-z]/.test(text)) literals.push({ text, line: lineAt(start) });
      continue;
    }
    i += 1;
  }
  return { masked: out.join(""), literals };
}

/** `&rsquo;` and friends are the only semicolons that belong in prose. */
const ENTITIES = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;

/**
 * Every string a screen can put in front of a person: the literals, plus the
 * JSX text between the tags.
 *
 * A text node is read as the run between a `>` or a `}` and the next `<` or
 * `{`, because a sentence with a figure in the middle of it is two runs and
 * the half that carries the leak is usually the second one — "We will use
 * {email} for everything in writing." A run that still holds a `;` or an `=`
 * after the entities are resolved is code that happened to sit between two
 * braces, and is dropped.
 */
export function phrases(source: string): Phrase[] {
  const { masked, literals } = blank(source);
  const out = [...literals];
  for (const match of masked.matchAll(/[>}]([^<>{}]+)[<{]/g)) {
    const text = (match[1] ?? "").replace(ENTITIES, "'");
    if (!/[A-Za-z]/.test(text) || /[;=]/.test(text)) continue;
    out.push({ text, line: masked.slice(0, match.index).split("\n").length });
  }
  return out;
}

const FILES = sourceFiles(SRC)
  .map((path) => ({
    name: path.slice(SRC.length),
    phrases: phrases(readFileSync(path, "utf8")),
  }))
  .filter((f) => !NOT_BORROWER_FACING.has(f.name));

const offenders = (rule: RegExp, keep: (p: Phrase) => boolean = () => true) =>
  FILES.flatMap((f) =>
    f.phrases
      .filter((p) => keep(p) && rule.test(p.text))
      .map((p) => `${f.name}:${p.line} ${JSON.stringify(p.text.trim().slice(0, 90))}`),
  );

describe("the screens keep the rules the catalog keeps", () => {
  it("promises no channel this product has", () => {
    expect(offenders(PROMISES)).toEqual([]);
  });

  it("promises no date nothing schedules", () => {
    expect(offenders(DELIVERY_TIME)).toEqual([]);
  });

  it("is written in American English", () => {
    expect(offenders(BRITISH)).toEqual([]);
  });

  it("writes the month before the day", () => {
    expect(offenders(DAY_FIRST)).toEqual([]);
  });

  /**
   * `"INC-008"` on its own is a key this code compares an id against — the
   * upload branch picks which document to open with it. What the rule is
   * about is an id reaching a sentence, so a phrase that is nothing but an id
   * is not one.
   */
  it("puts no requirement id in a sentence", () => {
    expect(offenders(REQ_ID, (p) => !/^[A-Z]{3}-\d{3}$/.test(p.text.trim()))).toEqual([]);
  });
});

/**
 * The other half of the same rule, which no regex over strings can see.
 *
 * `statement` and `appliesBecause` come off the requirements registry, which
 * is `data/v1-build.csv` in the sheet's own voice: "4506-C executed", and, as
 * a reason to send us a document, "Universal". They render through an
 * interpolation, so the words never appear in this repo's JSX at all and the
 * copy rules above cannot reach them. The one place that did this was the
 * upload branch, and it was the single exception to CLAUDE.md's "nothing in
 * the borrower flow renders a req_id".
 */
describe("no borrower screen renders the requirements sheet's own wording", () => {
  const REGISTRY_WORDING = /\.(statement|appliesBecause|conditionProse|waitingFor|rootCauses)\b/;

  for (const file of FILES) {
    it(`${file.name} names no registry copy field`, () => {
      const text = readFileSync(join(SRC, file.name), "utf8");
      const { masked } = blank(text);
      const hits = masked
        .split("\n")
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter((l) => REGISTRY_WORDING.test(l.text))
        .map((l) => `line ${l.line}: ${l.text.trim()}`);
      expect(hits).toEqual([]);
    });
  }
});

/**
 * A rule nothing trips is a rule nobody can tell is broken. Each of these is a
 * line that was in the product before this suite existed.
 */
describe("the rules catch what they were written for", () => {
  const of = (source: string) => phrases(source).map((p) => p.text);

  it("reads a sentence that a figure interrupts", () => {
    const jsx = `<p>We will use {email} for everything in writing.</p>`;
    expect(of(jsx).some((t) => PROMISES.test(t))).toBe(true);
  });

  it("reads a string literal", () => {
    expect(of(`setError("We need your authorisation first.")`).some((t) => BRITISH.test(t))).toBe(
      true,
    );
  });

  it("catches the leaks this suite was written for", () => {
    expect("Authorisation to verify").toMatch(BRITISH);
    expect("That counts in your favour").toMatch(BRITISH);
    expect("Postcode").toMatch(BRITISH);
    expect("We will read these and come back to you.").toMatch(PROMISES);
    expect("Text me updates about my application").toMatch(PROMISES);
    expect("We will use you@example.com for everything in writing.").toMatch(PROMISES);
  });

  it("does not read a comment, so the margins may argue in British", () => {
    const source = `// The important behaviour here is the SECOND landing.\nconst n = 1;\n`;
    expect(of(source).some((t) => BRITISH.test(t))).toBe(false);
  });

  it("does not mistake code between two braces for prose", () => {
    const source = `{items.map((f) => {\n  if (cancelled) return null;\n  return <p>ok</p>;\n})}`;
    expect(of(source).some((t) => BRITISH.test(t))).toBe(false);
  });

  it("does not pair one template literal's backtick with the next one's", () => {
    const source = "const a = `/f/${id}/bank`;\nlet cancelled = false;\nconst b = `/f/${id}/irs`;";
    expect(of(source).some((t) => BRITISH.test(t))).toBe(false);
  });

  it("does not read an apostrophe in prose as the start of a string", () => {
    const source = "<p>Your bank didn't connect.</p>\nlet cancelled = false;\n<p>ok</p>";
    expect(of(source)).toContain("Your bank didn't connect.");
    expect(of(source).some((t) => BRITISH.test(t))).toBe(false);
  });
});
