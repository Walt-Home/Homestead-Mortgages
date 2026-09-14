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
 * The connector rule joined them later and is the reason this header now names
 * a second kind of failure. `VENDOR_CLAIM` is not a leak that can be fixed by
 * rewording: "A soft pull. This does not affect your score." is correct copy
 * on a deployment with a credit reseller behind it and a fabrication on one
 * answering out of the fixtures, so the rule is that a screen may not carry
 * such a sentence AT ALL. It belongs in `lib/disclosures.ts`, where it is a
 * function of `capabilities.mode`, and `disclosures.test.ts` holds the shape
 * of every one of them. A screen that writes one inline has put a claim
 * somewhere the deployment cannot reach it.
 *
 * That rule is why this reads `.ts` as well as `.tsx`. It first did not, and
 * the exemption was written up as "disclosures.ts is a `.ts` file, which is
 * the point" — but the file extension is not a permission, and half the copy
 * in this app is `.ts`: the outcomes, the endings, the ledger's words, the
 * home page, the state catalog. A vendor claim written into any of them passed
 * every rule here. `disclosures.ts` is now the one named exemption, because it
 * is the module whose whole job is to carry those sentences, and
 * `disclosures.test.ts` is stricter about them than this file could be — it
 * can call each one at all three modes.
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
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID, VENDOR_CLAIM } from "@hm/shared";

const SRC = new URL("..", import.meta.url).pathname;

/**
 * Surfaces that are ours, not the borrower's, plus two modules whose own suite
 * is the stricter reader.
 *
 * The debug panel and the brand page say what they are in their own headers.
 * `lib/disclosures.ts` is the module whose whole job is to hold the sentences
 * `VENDOR_CLAIM` matches, and `disclosures.test.ts` calls every export at all
 * three modes rather than reading it as text. `lib/states.ts` is the design
 * gallery's catalogue — it says in its own header that its figures are
 * illustrative — and `states.test.ts` holds it to four of the five rules,
 * deliberately not to `DELIVERY_TIME`: the thirty-day clock in its
 * adverse-action copy is a statutory one, not something this repo schedules.
 */
const NOT_BORROWER_FACING = new Set([
  "components/DebugPanel.tsx",
  "pages/BrandPage.tsx",
  "lib/disclosures.ts",
  "lib/states.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : [];
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
  .map((path) => {
    const text = readFileSync(path, "utf8");
    return { name: path.slice(SRC.length), lines: text.split("\n"), phrases: phrases(text) };
  })
  .filter((f) => !NOT_BORROWER_FACING.has(f.name));

type SourceFile = (typeof FILES)[number];

/**
 * An import specifier or a class name, not a sentence.
 *
 * `"../lib/plaid.js"` names a vendor and `"plaid/return"` is half a route.
 * Only the connector rule needs this: the other four match words no path
 * contains, and a filter they do not need is a filter that could hide one of
 * their leaks.
 */
const isPath = (p: Phrase) => !/\s/.test(p.text.trim()) && /[/.]/.test(p.text);

/**
 * `new Error("plaid failed")` is a rejection a catch block reads, not a
 * sentence. It names a vendor because that is what did not load, and the
 * borrower is shown whatever the catch chooses to say instead.
 *
 * Only the connector rule takes this exemption. A thrown message is still held
 * to the other four — "authorisation failed" in a log is the same house-style
 * failure it is on a screen.
 */
const isThrown = (p: Phrase, f: SourceFile) => /new Error\(/.test(f.lines[p.line - 1] ?? "");

const offenders = (rule: RegExp, keep: (p: Phrase, f: SourceFile) => boolean = () => true) =>
  FILES.flatMap((f) =>
    f.phrases
      .filter((p) => keep(p, f) && rule.test(p.text))
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
   * The connector rule, and the only one of the five whose fix is a move
   * rather than a rewrite. Every sentence it matches is true of some
   * deployment, so none of them can be settled where it is written: the
   * screens and the copy catalogs read `lib/disclosures.ts`, which is the one
   * name in `NOT_BORROWER_FACING` that is not a surface but an exemption.
   */
  it("makes no claim a screen cannot know is true", () => {
    expect(offenders(VENDOR_CLAIM, (p, f) => !isPath(p) && !isThrown(p, f))).toEqual([]);
  });

  /**
   * The exemption is one file and not a file extension. A `.ts` copy catalog
   * with a vendor sentence in it is the failure this was widened for, so the
   * widening is asserted rather than assumed — a `sourceFiles()` that quietly
   * went back to `.tsx` would leave every rule above passing over half the
   * copy in the app.
   */
  it("reads the copy catalogs, which are not components", () => {
    const names = FILES.map((f) => f.name);
    for (const catalog of [
      "lib/outcomes.ts",
      "lib/home-copy.ts",
      "lib/ledger.ts",
      "lib/declarations.ts",
      "lib/endings.ts",
      "lib/figures.ts",
    ]) {
      expect(names, catalog).toContain(catalog);
    }
    for (const exempt of ["lib/disclosures.ts", "lib/states.ts"]) {
      expect(names, exempt).not.toContain(exempt);
    }
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

  it("catches a vendor claim a screen wrote out for itself", () => {
    const jsx = `<p>Your bank is open in a secure window.</p>`;
    expect(of(jsx).some((t) => VENDOR_CLAIM.test(t))).toBe(true);
    expect(
      of(`import { readAttempt } from "../lib/plaid.js";`).filter((t) => !/\s/.test(t)),
    ).toEqual(["../lib/plaid.js"]);
  });

  it("catches the leaks this suite was written for", () => {
    expect("Authorisation to verify").toMatch(BRITISH);
    expect("That counts in your favour").toMatch(BRITISH);
    expect("Postcode").toMatch(BRITISH);
    expect("We will read these and come back to you.").toMatch(PROMISES);
    expect("Text me updates about my application").toMatch(PROMISES);
    expect("We will use you@example.com for everything in writing.").toMatch(PROMISES);
    // The property screen's two: a correction nobody reads, and an address
    // nothing revisits. Both named a person, neither named a channel, and the
    // first draft of the rule saw only the one that said "someone".
    expect("Tell us what is off. We will check it — you do not need to wait.").toMatch(PROMISES);
    expect("It does not stop your application — we will just confirm the details later.").toMatch(
      PROMISES,
    );
    // The bank promise the income label was corrected for, said on two screens.
    expect("We read your transactions once, to verify what you have and what you earn.").toMatch(
      VENDOR_CLAIM,
    );
    expect("A rough number is enough — we verify the real one from your bank later.").toMatch(
      VENDOR_CLAIM,
    );
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
