import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alreadyOnBook,
  bookGapWords,
  bookLoan,
  bookSum,
  bookSumWords,
  confirmsNumber,
  keptOnRemoval,
  refusalWords,
  removeTapePath,
  repeatedTapeName,
  tapeName,
  type ReconciledTape,
  type TapeReconciliation,
  type TapeRemoval,
} from "../book.js";
import { statementLoansCsvUrl } from "../billing.js";

const tape = (over: Partial<ReconciledTape> & { id: string }): ReconciledTape => ({
  filename: null,
  asOf: "2026-04-30",
  loadedAt: "2026-10-26T18:25:00.000Z",
  billedFrom: "2026-10-01",
  rowsTotal: 0,
  rowsLoaded: 0,
  rowsRefused: 0,
  loansCreated: 0,
  loansUpdated: 0,
  loansUnchanged: 0,
  loansStillOnBook: 0,
  balanceCents: "0",
  refused: [],
  duplicates: 0,
  duplicatesOf: [],
  removable: { ok: true, reasons: [] },
  removes: { loans: 0, observations: 0, reviews: 0 },
  ...over,
});

const removal = (over: Partial<TapeRemoval> & { tapeId: string }): TapeRemoval => ({
  id: `r-${over.tapeId}`,
  filename: null,
  asOf: "2026-04-30",
  loansRemoved: 0,
  observationsRemoved: 0,
  balanceCents: "0",
  reason: "a re-export of a tape already on the book",
  removedBy: "staff-1",
  removedByName: "Drew",
  removedAt: "2026-10-27T14:00:00.000Z",
  ...over,
});

describe("a refused row, in words", () => {
  it("says each refusal the reader knows plainly", () => {
    expect(refusalWords("no_loan_number")).toBe("No loan number");
    expect(refusalWords("no_term", "Term")).toBe("No term");
    expect(refusalWords("no_state")).toBe("No state");
    expect(refusalWords("no_balance_or_rate")).toBe("No balance or rate");
    expect(refusalWords("loan_number_scientific")).toBe("Loan number in scientific notation");
    expect(refusalWords("loan_number_not_exact")).toBe("Loan number too long to read exactly");
  });

  it("names the column an unreadable cell was in", () => {
    expect(refusalWords("unreadable_cell", "Maturity Date")).toBe("Maturity Date unreadable");
    expect(refusalWords("unreadable_cell", null)).toBe("A cell unreadable");
  });

  it("makes words of a code it has not met", () => {
    expect(refusalWords("some_new_rule")).toBe("Some new rule");
  });
});

describe("a tape's name", () => {
  it("is the file it arrived as, or its date", () => {
    expect(tapeName({ filename: "Grander April.xlsx", asOf: "2026-04-30" })).toBe(
      "Grander April.xlsx",
    );
    expect(tapeName({ filename: null, asOf: "2026-04-30" })).toBe("Tape of Apr 30, 2026");
  });

  it("counts the loans it found already on the book, changed or not", () => {
    expect(alreadyOnBook(tape({ id: "t", loansUpdated: 12, loansUnchanged: 233 }))).toBe(245);
  });
});

describe("what taking a tape back removes", () => {
  it("is the loans only it carries, not the loans it created", () => {
    // The API's own case: a tape that created 12 loans, three of which a
    // later tape carries too, removes 9 and keeps 3; 9 is what is confirmed.
    const a = tape({
      id: "a",
      loansCreated: 12,
      loansStillOnBook: 12,
      removes: { loans: 9, observations: 12, reviews: 12 },
    });
    expect(a.removes.loans).toBe(9);
    expect(keptOnRemoval(a)).toBe(3);
    expect(confirmsNumber("12", a.removes.loans)).toBe(false);
    expect(confirmsNumber("9", a.removes.loans)).toBe(true);
  });

  it("can be no loans at all, when a later tape carries every one", () => {
    const october = tape({
      id: "c",
      loansCreated: 430,
      loansStillOnBook: 430,
      removes: { loans: 0, observations: 430, reviews: 0 },
    });
    expect(keptOnRemoval(october)).toBe(430);
    expect(confirmsNumber("0", october.removes.loans)).toBe(true);
  });
});

describe("the book adds up", () => {
  // Production on 26 October 2026: six tapes, the second a re-export of the first.
  const sixTapes: TapeReconciliation = {
    servicer: { slug: "grander", displayName: "Grander" },
    loansOnBook: 2111,
    tapes: [
      tape({ id: "a", loansCreated: 245, loansStillOnBook: 245 }),
      tape({ id: "b", loansCreated: 245, loansStillOnBook: 245, duplicates: 245 }),
      tape({ id: "c", loansCreated: 430, loansStillOnBook: 430 }),
      tape({ id: "d", loansCreated: 440, loansStillOnBook: 440 }),
      tape({ id: "e", loansCreated: 389, loansStillOnBook: 389 }),
      tape({ id: "f", loansCreated: 362, loansStillOnBook: 362 }),
    ],
    removals: [],
    check: { created: 2111, removed: 0, loansOnBook: 2111, adds: true },
  };

  it("when every loan a tape created, less every one removed, is on the book", () => {
    const sum = bookSum(sixTapes);
    expect(sum).toEqual({ tapes: 6, created: 2111, removed: 0, onBook: 2111, adds: true });
    expect(bookSumWords(sum)).toBe(
      "2,111 new loans across 6 tapes − 0 removed = 2,111 on the book",
    );
  });

  it("counts a removed tape among the tapes, though it is no longer listed", () => {
    const after: TapeReconciliation = {
      ...sixTapes,
      loansOnBook: 1866,
      tapes: sixTapes.tapes.filter((t) => t.id !== "b"),
      removals: [removal({ tapeId: "b", loansRemoved: 245 })],
      check: { created: 2111, removed: 245, loansOnBook: 1866, adds: true },
    };
    const sum = bookSum(after);
    expect(sum.tapes).toBe(6);
    expect(sum.adds).toBe(true);
    expect(bookSumWords(sum)).toBe(
      "2,111 new loans across 6 tapes − 245 removed = 1,866 on the book",
    );
  });

  it("does not, when the arithmetic fails, whatever the server's flag says", () => {
    const off = bookSum({
      ...sixTapes,
      check: { created: 2111, removed: 0, loansOnBook: 2110, adds: true },
    });
    expect(off.adds).toBe(false);
    expect(bookGapWords(off)).toBe(
      "2,111 new loans across 6 tapes, less 0 removed, is 2,111; the book holds 2,110 loans.",
    );
    expect(bookSum({ ...sixTapes, check: { ...sixTapes.check, adds: false } }).adds).toBe(false);
  });

  it("names the tape a duplicate repeats, listed or removed", () => {
    const rec = {
      tapes: [tape({ id: "a", filename: "april.xlsx" })],
      removals: [removal({ tapeId: "z", filename: "april again.xlsx" })],
    };
    expect(repeatedTapeName("a", rec)).toBe("april.xlsx");
    expect(repeatedTapeName("z", rec)).toBe("april again.xlsx");
    expect(repeatedTapeName("missing", rec)).toBe("another tape");
  });
});

describe("the typed confirmation", () => {
  it("matches the number with or without its commas", () => {
    expect(confirmsNumber("245", 245)).toBe(true);
    expect(confirmsNumber(" 1,866 ", 1866)).toBe(true);
    expect(confirmsNumber("244", 245)).toBe(false);
    expect(confirmsNumber("", 0)).toBe(false);
    expect(confirmsNumber("0", 0)).toBe(true);
  });
});

describe("the paths", () => {
  it("removes a tape under its servicer", () => {
    expect(removeTapePath("grander-investment-management-llc", "46188449")).toBe(
      "/servicers/grander-investment-management-llc/tapes/46188449/remove",
    );
  });

  it("downloads a month's loans from billing's door", () => {
    expect(statementLoansCsvUrl("grander", "2026-10")).toBe(
      "/console/hm/billing/servicers/grander/statements/2026-10/loans.csv",
    );
  });
});

describe("one loan, read", () => {
  afterEach(() => vi.unstubAllGlobals());

  const loan = { id: "l-1", number: "1002027994" };
  const answering = (body: unknown) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("asks our door for it, and unwraps the portal's `{ loan }`", async () => {
    const fetch = answering({ loan });
    await expect(bookLoan("grander", "l-1")).resolves.toEqual(loan);
    expect(fetch).toHaveBeenCalledWith(
      "/console/hm/tape/servicers/grander/loans/l-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads a bare loan the same", async () => {
    answering(loan);
    await expect(bookLoan("grander", "l-1")).resolves.toEqual(loan);
  });
});
