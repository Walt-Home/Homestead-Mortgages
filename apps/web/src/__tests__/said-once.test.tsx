/**
 * One thing, said once.
 *
 * Every failure guarded here reached a borrower as the product contradicting
 * itself on a single screen: the standing rendered twice 150px apart, once
 * with the line the screen overrode and once without; one engine figure
 * labelled two ways across two of the same borrower's screens; a money
 * formatter copied into three files, which is three places for the rounding to
 * drift; two buttons of different weight going to the same URL; and an anchor
 * where a `Link` belongs, which throws away the SPA on the way home.
 *
 * The rules read the source, because none of them is a rule about one
 * component's output — they are rules about there being one of something. A
 * second copy passes every test the first copy passes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Figure } from "../components/Figure.js";
import { QUALIFYING_INCOME_LABEL, money, qualifyingIncome } from "../lib/figures.js";
import { screenOwnsStanding } from "../lib/flow.js";

const SRC = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: path.slice(SRC.length),
  text: readFileSync(path, "utf8"),
}));

const read = (name: string) => readFileSync(join(SRC, name), "utf8");

describe("where the file stands, rendered once per route", () => {
  it("names the review screen, and only it", () => {
    expect(screenOwnsStanding("review")).toBe(true);
    for (const path of ["property", "identity", "bank"]) {
      expect(screenOwnsStanding(path), path).toBe(false);
    }
  });

  it("leaves the header copy on the branches, which render none of their own", () => {
    // payroll, irs and documents collapse to `review` for the step nav. If
    // the shell keyed its standing on that instead of on the URL path, all
    // three would lose the only line telling the borrower where the file is.
    for (const path of ["payroll", "irs", "documents"]) {
      expect(screenOwnsStanding(path), path).toBe(false);
    }
    for (const page of ["ConnectPages.tsx", "UploadPage.tsx"]) {
      expect(read(join("pages", page)), page).not.toContain("<ApplicationStanding");
    }
  });

  it("is the rule the shell actually asks", () => {
    const app = read("App.tsx");
    expect(app).toContain("standingInHeader={!screenOwnsStanding(last)}");
    // One render in the shell, and it is behind the flag. Both halves matter:
    // an unguarded second render anywhere in this file is the defect back.
    expect([...app.matchAll(/<ApplicationStanding/g)]).toHaveLength(1);
    expect(app).toContain("{fileId && standingInHeader && (");
  });

  it("is rendered by exactly one screen", () => {
    const pages = FILES.filter(
      (f) => f.name.startsWith("pages/") && f.text.includes("<ApplicationStanding"),
    );
    expect(pages.map((f) => f.name)).toEqual(["pages/ReviewPage.tsx"]);
  });
});

describe("one money formatter", () => {
  it("is declared in one place", () => {
    const declared = FILES.filter((f) => /\bconst money =|\bfunction money\b/.test(f.text));
    expect(declared.map((f) => f.name)).toEqual(["lib/figures.ts"]);
  });

  it("rounds to whole dollars, which is what all three copies did", () => {
    expect(money(414_999.6)).toBe("$415,000");
    expect(money(7083.33)).toBe("$7,083");
  });
});

describe("one Figure, with the null-tolerant contract", () => {
  it("is declared in one place", () => {
    const declared = FILES.filter((f) => /\bfunction Figure\b|\bconst Figure =/.test(f.text));
    expect(declared.map((f) => f.name)).toEqual(["components/Figure.tsx"]);
  });

  it("says a figure it has", () => {
    const markup = renderToStaticMarkup(<Figure label="Verified assets" value="$41,220" />);
    expect(markup).toContain("$41,220");
    expect(markup).not.toContain("—");
    expect(markup).not.toContain("still working this out");
  });

  it("says a dash rather than a number for one it does not", () => {
    // The contract the review screen's copy could not express. A zero and an
    // omitted row both read as an answer; this is the reason the wider type
    // is the one that survived.
    const markup = renderToStaticMarkup(<Figure label="Debt-to-income" value={null} />);
    expect(markup).toContain("—");
    expect(markup).toContain("still working this out");
  });
});

describe("one label for the income the decision turns on", () => {
  it("is said the same way on both screens that show it", () => {
    for (const page of ["BankPage.tsx", "ReviewPage.tsx"]) {
      const text = read(join("pages", page));
      expect(text, page).toContain("QUALIFYING_INCOME_LABEL");
      expect(text, page).toContain("qualifyingIncome(");
    }
  });

  it("leaves no second name for it anywhere", () => {
    const offenders = FILES.filter(
      (f) => f.name !== "lib/figures.ts" && /"(Monthly|Verified) income"/.test(f.text),
    );
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("carries the period the other label carried", () => {
    expect(qualifyingIncome(7083.33)).toBe("$7,083/mo");
    expect(QUALIFYING_INCOME_LABEL).toBe("Verified income");
  });
});

describe("one control per destination", () => {
  it("offers one way off the documents branch", () => {
    const upload = read(join("pages", "UploadPage.tsx"));
    expect([...upload.matchAll(/f\/\$\{fileId\}\/review/g)]).toHaveLength(1);
  });
});

describe("going home does not reload the app", () => {
  it("uses no anchor for an in-app destination", () => {
    // `App.tsx`'s header comment is the whole argument: an <a> throws away the
    // SPA and reloads everything. Two pages held one anyway, and both were the
    // control offered after something had already gone wrong.
    const offenders = FILES.filter((f) => /href=["'{]\s*["'`]?\//.test(f.text)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});
