/**
 * The design system, enforced.
 *
 * `packages/brand` makes a re-theme a one-file edit — but only for as long as
 * every component actually names a token. One `text-[13px]` or `bg-[#111]`
 * reintroduces a value that no token edit can reach, and nothing about it
 * looks wrong in review. Worse, Tailwind's palette is replaced rather than
 * extended, so a stray `text-gray-500` is not a compile error and not a
 * runtime error: it generates no CSS at all and the text silently inherits.
 *
 * So the rules are a test. It reads the source rather than the DOM because
 * the failure it guards against is a class that never becomes CSS.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return path.endsWith(".tsx") ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  name: path.slice(SRC.length),
  text: readFileSync(path, "utf8"),
}));

/**
 * Class-ish tokens from the file's className attributes.
 *
 * Deliberately loose — it reads every string literal inside a className,
 * including the branches of a clsx() call, which is exactly where a stale
 * class hides from a reviewer skimming the JSX.
 */
function classesIn(text: string): { cls: string; line: number }[] {
  const out: { cls: string; line: number }[] = [];
  const attr = /className=(?:"([^"]*)"|\{([\s\S]*?)\n\s*\}|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
  for (const match of text.matchAll(attr)) {
    const body = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const line = text.slice(0, match.index).split("\n").length;
    const strings = match[1]
      ? [match[1]]
      : [...body.matchAll(/"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
    for (const s of strings) {
      for (const cls of s.split(/\s+/).filter(Boolean)) out.push({ cls, line });
    }
  }
  return out;
}

/** Strips a responsive/state prefix: `sm:hover:text-ink` → `text-ink`. */
const bare = (cls: string) => cls.slice(cls.lastIndexOf(":") + 1);

describe("no component names a value the tokens cannot reach", () => {
  /** The Homestead vocabulary. Every one of these is now a class that does nothing. */
  const RETIRED =
    /^(bg|text|border|ring|divide|placeholder|from|to|shadow|rounded|font)-(canvas|app|inset|ink-editorial|ink-prose|muted|meta|subtle|line|line-light|line-form|line-strong|olive|gold|notice|notice-bg|notice-border|error|brand|prose|ui|form|control|row|card|cta)(-[a-z0-9]+)?$/;

  /** Tailwind's default palette, which the preset removed. */
  const DEFAULT_PALETTE =
    /^(bg|text|border|ring|divide|placeholder|from|via|to|fill|stroke|decoration|outline|accent|caret|shadow)-(inherit|current|transparent|black|white|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-\d{1,3})?(\/\d{1,3})?$/;

  /** An arbitrary value re-hardcodes something a token should own. */
  const ARBITRARY = /^(bg|text|border|ring|shadow|rounded|font|leading|tracking)-\[/;

  for (const file of FILES) {
    const classes = classesIn(file.text);

    it(`${file.name} uses no retired Homestead class`, () => {
      const bad = classes.filter((c) => RETIRED.test(bare(c.cls)));
      expect(bad.map((c) => `line ${c.line}: ${c.cls}`)).toEqual([]);
    });

    it(`${file.name} uses no color outside the token set`, () => {
      // `transparent`, `current` and `inherit` survive in the preset; the rest
      // of Tailwind's palette does not.
      const bad = classes.filter(
        (c) =>
          DEFAULT_PALETTE.test(bare(c.cls)) && !/-(inherit|current|transparent)$/.test(bare(c.cls)),
      );
      expect(bad.map((c) => `line ${c.line}: ${c.cls}`)).toEqual([]);
    });

    it(`${file.name} uses no arbitrary color, size or radius`, () => {
      const bad = classes.filter((c) => ARBITRARY.test(bare(c.cls)));
      expect(bad.map((c) => `line ${c.line}: ${c.cls}`)).toEqual([]);
    });

    /**
     * The old component layer was unprefixed: `card`, `figure`, `btn-primary`.
     * Those selectors are gone, and unlike a retired color they leave no
     * trace — a `.card` renders as an unstyled div, which reads as a layout
     * bug rather than a missing stylesheet.
     */
    it(`${file.name} uses the prefixed component classes`, () => {
      const unprefixed = new Set([
        "card",
        "figure",
        "btn-primary",
        "btn-secondary",
        "field-input",
        "field-label",
      ]);
      const bad = classes.filter((c) => unprefixed.has(bare(c.cls)));
      expect(bad.map((c) => `line ${c.line}: ${c.cls}`)).toEqual([]);
    });
  }
});

describe("brand rules that a class list alone would not catch", () => {
  for (const file of FILES) {
    /**
     * The display face is Georgia at 400 and never bold — see docs/brand.md.
     * `base.css` sets the weight, but a `font-semibold` utility sits in a
     * later layer and wins, so the only reliable guard is the markup.
     */
    it(`${file.name} never sets a bold weight on the display face`, () => {
      const offenders: string[] = [];
      for (const match of file.text.matchAll(/className=(?:"([^"]*)"|\{([\s\S]*?)\n\s*\})/g)) {
        const body = match[1] ?? match[2] ?? "";
        if (!body.includes("font-display")) continue;
        if (/\bfont-(semibold|bold|extrabold|black)\b/.test(body)) {
          offenders.push(`line ${file.text.slice(0, match.index).split("\n").length}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    /** A `.super-btn` with no variant renders as an invisible transparent pill. */
    it(`${file.name} pairs every super-btn with a variant`, () => {
      const offenders: string[] = [];
      for (const match of file.text.matchAll(/className=(?:"([^"]*)"|\{([\s\S]*?)\n\s*\})/g)) {
        const body = match[1] ?? match[2] ?? "";
        if (!/\bsuper-btn\b/.test(body)) continue;
        if (!/\bsuper-btn-(primary|outline|solid|danger|ghost)\b/.test(body)) {
          offenders.push(`line ${file.text.slice(0, match.index).split("\n").length}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  /**
   * One white button per screen is the rule the whole color system rests on:
   * `primary` is the thing you came to do, `accent` is everything around it.
   * This cannot count per rendered screen, but a file with a crowd of them has
   * certainly broken it.
   */
  it("no file leans on more than a handful of primary buttons", () => {
    const heavy = FILES.map((f) => ({
      name: f.name,
      count: (f.text.match(/super-btn-primary/g) ?? []).length,
    })).filter((f) => f.count > 6);
    expect(heavy).toEqual([]);
  });
});

describe("the app defines no styling of its own", () => {
  /**
   * The failure this guards against is silent and total.
   *
   * CSS requires @import to precede every other statement. An @import placed
   * after a @tailwind directive — the natural way to write "components go in
   * the components layer" — is rejected by PostCSS, and Vite drops that file
   * from the bundle. The build still succeeds. The app ships with no component
   * layer, every `.super-*` class resolves to nothing, and the only symptom is
   * that the design looks wrong. It happened once already.
   */
  it("every @import in index.css precedes every @tailwind directive", () => {
    const lines = readFileSync(join(SRC, "index.css"), "utf8").split("\n");
    const lastImport = lines.reduce((n, l, i) => (l.startsWith("@import") ? i : n), -1);
    const firstTailwind = lines.findIndex((l) => l.startsWith("@tailwind"));
    expect(firstTailwind).toBeGreaterThan(-1);
    expect(lastImport).toBeLessThan(firstTailwind);
  });

  it("index.css only assembles the brand package", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const declarations = css
      .split("\n")
      .filter((line) => /^\s*[a-z-]+\s*:/.test(line) && !line.trim().startsWith("*"));
    expect(declarations).toEqual([]);
  });

  it("no component hardcodes a hex color in a style prop", () => {
    const offenders = FILES.filter((f) => /style=\{\{[^}]*#[0-9a-fA-F]{3,8}/.test(f.text)).map(
      (f) => f.name,
    );
    expect(offenders).toEqual([]);
  });
});
