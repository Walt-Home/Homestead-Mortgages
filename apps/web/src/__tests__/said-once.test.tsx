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
import { assetsLabel, money, qualifyingIncome, qualifyingIncomeLabel } from "../lib/figures.js";
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
      expect(text, page).toContain("qualifyingIncomeLabel(");
      expect(text, page).toContain("incomeBasis({");
      expect(text, page).toContain("qualifyingIncome(");
    }
  });

  it("leaves no second name for it anywhere", () => {
    const offenders = FILES.filter(
      (f) =>
        f.name !== "lib/figures.ts" &&
        /"(Monthly|Verified|Estimated|Sample|Test-mode) income"/.test(f.text),
    );
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  /*
   * The label stopped being a constant and became a function of what stands
   * behind the figure, which is a change to what it says and not to how many
   * places say it: one screen deriving it and another writing the word out
   * would be the same drift this block was written for. All four words are
   * checked here because all four are now the label.
   */
  it("carries the period the other label carried", () => {
    expect(qualifyingIncome(7083.33)).toBe("$7,083/mo");
    expect(qualifyingIncomeLabel("verified")).toBe("Verified income");
    expect(qualifyingIncomeLabel("estimated")).toBe("Estimated income");
    expect(qualifyingIncomeLabel("sample")).toBe("Sample income");
    expect(qualifyingIncomeLabel("test_mode")).toBe("Test-mode income");
  });
});

/*
 * Its row-mate, for the same reason and one round later. "Verified assets" was
 * left a literal on the argument that balances ARE what the accounts evidence
 * — true of a Plaid deployment, false of a fixture one, and a claim written
 * into a component cannot tell the two apart.
 */
describe("one label for the assets beside it", () => {
  it("is derived on the screen that shows it, not written out", () => {
    expect(read(join("pages", "BankPage.tsx"))).toContain("assetsLabel(");
  });

  it("leaves no second name for it anywhere", () => {
    const offenders = FILES.filter(
      (f) => f.name !== "lib/figures.ts" && /"(Verified|Sample|Test-mode) assets"/.test(f.text),
    );
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("says verified only where something outside this repo did the counting", () => {
    expect(assetsLabel("production")).toBe("Verified assets");
    expect(assetsLabel("fixture")).not.toMatch(/verified/i);
    expect(assetsLabel("sandbox")).not.toMatch(/verified/i);
  });
});

describe("one shape for a recorded decision", () => {
  it("is declared in one place", () => {
    const declared = FILES.filter((f) => /\b(?:interface|type) Decision\w*\s*[={<]/.test(f.text));
    expect(declared.map((f) => f.name)).toEqual(["lib/file.ts"]);
  });

  it("leaves no screen asserting its own shape over the file's decision", () => {
    // Two screens read `file.decision`, one casting it to a shape carrying the
    // outcome and one to a shape holding only the ratios, so the two did not
    // agree on whether a decision has an outcome at all — and the cast is
    // exactly what stopped that disagreement being loud.
    const offenders = FILES.filter((f) => /\.decision as\b/.test(f.text));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("leaves no second hand-written list of the four figures", () => {
    // The ratios-only half of that disagreement was a private block naming
    // these four by hand, and the rule above cannot see it — a shape called
    // anything but `Decision…` passes. `DecisionRatios` picks the four off
    // `Ratios` instead, so a second list is a second answer to what a ratios
    // block is. Two figures are an input to something (`EndingInput.ratios`
    // asks for exactly two); all four together are the block itself.
    const FIGURES = ["housingPitia", "dtiBack", "ltv", "totalQualifyingIncome"];
    const declared = FILES.filter((f) =>
      FIGURES.every((figure) => new RegExp(`${figure}\\s*:\\s*number`).test(f.text)),
    );
    expect(declared.map((f) => f.name)).toEqual([]);
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
