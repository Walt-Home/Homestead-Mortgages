/**
 * The two labels on the bank screen's figure row, which are the claims in this
 * product that are not about a vendor by name.
 *
 * `QUALIFYING_INCOME_LABEL = "Verified income"` was a constant rendered on two
 * screens, and the thing it claimed was already contradicted on the wire:
 * `POST /files/:id/bank` returns `incomeConfidence`, Plaid runs in Assets mode
 * where income is inferred from recurring deposits, and `toAssetReport` says
 * in its own words that it never produces "verified".
 *
 * Keying the label on that field fixed the sentence and left the shape: a
 * label whose provenance is not the figure's. Two ways, each of which shipped:
 *
 *   1. `incomeConfidence` is the BANK's answer, and the figure is the sum of
 *      `file.incomeSources` — rows the payroll route replaces wholesale while
 *      `assets` stays pointed at the older bank snapshot. A borrower who
 *      finished the payroll branch saw employer-reported income called
 *      estimated.
 *   2. `incomeConfidence` is a field of the report, and on a fixture
 *      deployment the report is invented. `clean_w2` declares "verified", so
 *      "Verified income" rendered under a credit pill that correctly read
 *      "Sample credit · Made up for this prototype".
 *
 * So the rule here is not a wording. It is that the word "verified" has to be
 * earned twice over — by a retrieval that happened, and by that retrieval
 * saying it established the income — and that an absent answer earns neither,
 * which is the direction a constant fails in.
 */

import { describe, expect, it } from "vitest";
import type { AssetReport } from "@hm/shared";
import type { ConnectorModes } from "../disclosures.js";
import {
  assetsLabel,
  incomeBasis,
  incomeConfidenceOf,
  INCOME_WORKED_OUT_FROM_BANK,
  money,
  qualifyingIncome,
  qualifyingIncomeLabel,
  type IncomeConfidence,
} from "../figures.js";

/**
 * The two unions are the same union. A screen deciding what to call a figure
 * and the connector deciding what the figure is worth have to be reading the
 * same three values, and nothing else in the web app imports the report type.
 */
const _sameUnion: IncomeConfidence = "estimated" satisfies AssetReport["incomeConfidence"];

const LIVE: ConnectorModes = { bank: "production", payroll: "production" };

/** The label a borrower sees, from the two things it is allowed to depend on. */
const label = (
  reportedBy: readonly ("bank" | "payroll" | null)[],
  confidence: IncomeConfidence | null,
  modes: ConnectorModes = LIVE,
) =>
  qualifyingIncomeLabel(
    incomeBasis({
      reportedBy,
      assets: confidence === null ? null : { incomeConfidence: confidence },
      modes,
    }),
  );

describe("what the income figure may be called", () => {
  it("says verified where the bank report established it", () => {
    expect(label(["bank"], "verified")).toBe("Verified income");
  });

  it("does not claim verification from an answer that is not one", () => {
    for (const confidence of ["estimated", "insufficient", null] as const) {
      expect(label(["bank"], confidence)).not.toMatch(/verified/i);
    }
  });

  /**
   * The bank screen renders this label in the same row as the assets label,
   * which on a live deployment IS what the accounts evidence. A word that
   * reads as a softer synonym of the one beside it is the version of this fix
   * that changes nothing.
   */
  it("is plainly a different word from the one on the row beside it", () => {
    expect(label(["bank"], "estimated")).not.toBe(label(["bank"], "verified"));
    expect(label(["bank"], "estimated")).toMatch(/estimated/i);
  });
});

describe("the label names the retrieval the figure came from", () => {
  /**
   * The payroll route replaces the bank's income rows and writes a payroll
   * snapshot; `repository.ts` keeps `assets` on the older bank report. Reading
   * the label off that report calls payroll-derived income estimated.
   */
  it("follows the rows the engine summed, not the bank report beside them", () => {
    expect(label(["payroll"], "estimated")).toBe("Verified income");
    expect(label(["payroll"], null)).toBe("Verified income");
  });

  it("falls to the bank's answer where the bank still contributes a row", () => {
    expect(label(["bank", "payroll"], "estimated")).toBe("Estimated income");
    expect(label(["bank", "payroll"], "verified")).toBe("Verified income");
  });

  /**
   * The window between a bank pull returning and the file query refetching.
   * The report in hand is the only thing behind the figure, so the bank is who
   * to ask about.
   */
  it("reads an empty list as the bank report in hand", () => {
    expect(label([], "verified")).toBe("Verified income");
    expect(label([], null)).toBe("Estimated income");
    expect(label(undefined as never, null)).toBe("Estimated income");
  });

  /** A row naming no income pull is the weaker of the two answers. */
  it("reads a row with no named retrieval as the bank's", () => {
    expect(label([null], "estimated")).toBe("Estimated income");
    expect(label([null], "verified")).toBe("Verified income");
  });
});

describe("the label names a deployment that retrieved something", () => {
  it("says sample where the connector behind the rows is a fixture", () => {
    expect(label(["bank"], "verified", { bank: "fixture" })).toBe("Sample income");
    expect(label(["payroll"], "verified", { bank: "production", payroll: "fixture" })).toBe(
      "Sample income",
    );
  });

  it("says test mode where the connector is a sandbox", () => {
    expect(label(["bank"], "verified", { bank: "sandbox" })).toBe("Test-mode income");
  });

  /**
   * `/auth/config` is fetched on load and the screen renders before it lands.
   * The same direction `modeOf` defaults in: claim nothing, then earn it.
   */
  it("claims nothing before the deployment has said what it is", () => {
    expect(label(["bank"], "verified", {})).toBe("Sample income");
    expect(
      qualifyingIncomeLabel(incomeBasis({ reportedBy: ["bank"], assets: null, modes: null })),
    ).not.toMatch(/verified/i);
  });

  it("is the same rule for the assets beside it", () => {
    expect(assetsLabel("production")).toBe("Verified assets");
    expect(assetsLabel("sandbox")).not.toMatch(/verified/i);
    expect(assetsLabel("fixture")).not.toMatch(/verified/i);
    const said = (["fixture", "sandbox", "production"] as const).map((m) => assetsLabel(m));
    expect(new Set(said).size).toBe(3);
  });
});

describe("what the bank is said to do with income, before the number exists", () => {
  /**
   * Screen 1 and screen 4 both promised verification of earnings, on the same
   * connector whose report never returns the verified answer. The promise and
   * the label now come out of one module; nothing but the word "verified"
   * being absent from the promise keeps them honest together.
   */
  it("promises work rather than verification", () => {
    expect(INCOME_WORKED_OUT_FROM_BANK).not.toMatch(/verif/i);
    expect(INCOME_WORKED_OUT_FROM_BANK).toMatch(/work out what you earn/);
  });
});

describe("reading the report the file is carrying", () => {
  it("reads the confidence off it", () => {
    expect(incomeConfidenceOf({ incomeConfidence: "verified" })).toBe("verified");
    expect(incomeConfidenceOf({ incomeConfidence: "estimated" })).toBe("estimated");
  });

  /**
   * `LoanFileView.assets` is `unknown`, and a file with no bank connection
   * carries null. Anything that is not one of the three values is not an
   * answer, and the label must fall to the cautious side rather than throw.
   */
  it("treats a missing or unrecognized answer as no answer", () => {
    expect(incomeConfidenceOf(null)).toBeNull();
    expect(incomeConfidenceOf(undefined)).toBeNull();
    expect(incomeConfidenceOf({})).toBeNull();
    expect(incomeConfidenceOf({ incomeConfidence: "VERIFIED" })).toBeNull();
  });
});

describe("how a number is said", () => {
  it("rounds to whole dollars and keeps the period in the value", () => {
    expect(money(4319.62)).toBe("$4,320");
    expect(qualifyingIncome(9250)).toBe("$9,250/mo");
  });
});
