/**
 * The whole flow, end to end, without a database.
 *
 * This walks a fixture borrower through screens 1–8 as an in-memory LoanFile
 * and asserts the thing the product actually promises: that connecting
 * accounts retires requirements, that the ones left are the ones that genuinely
 * apply, and that the decision explains itself.
 *
 * It is the test that would catch the failure mode nobody notices — an engine
 * that returns a clean, confident answer built on inputs it never had.
 */

import { describe, expect, it } from "vitest";
import { fixtureRegistry, PERSONAS } from "@hm/connectors";
import type { LoanFile } from "@hm/shared";
import { assessAll, outstanding, progress } from "@hm/requirements";
import { underwrite, APOR_TABLE } from "@hm/underwriting";
import {
  REFERENCE,
  afterDeclarations,
  afterIdentity,
  consent,
  token,
  asFileEmployment,
} from "./support/in-memory-file.js";

const registry = fixtureRegistry({ latencyMs: 0, persona: "clean_w2", referenceDate: REFERENCE });

/** "Rent payment history identified", the one requirement a housing basis gates. */
const RENTER_REQUIREMENT = "CRD-018";

describe("the onboarding flow", () => {
  it("retires requirements as each connector lands", async () => {
    let file = afterIdentity();
    const before = progress(file);

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const afterCredit = progress(file);

    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const afterBank = progress(file);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: asFileEmployment(payroll.data.employments, file.borrowers[0]!.partyId),
    };
    const afterPayroll = progress(file);

    // Each connection satisfies strictly more than the one before it.
    expect(afterCredit.satisfied).toBeGreaterThan(before.satisfied);
    expect(afterBank.satisfied).toBeGreaterThan(afterCredit.satisfied);
    expect(afterPayroll.satisfied).toBeGreaterThan(afterBank.satisfied);
  });

  it("never lets satisfied progress go backwards", async () => {
    // The invariant that matters more than any single count: connecting an
    // account may only ever increase what is satisfied. It went 23 → 21 here
    // once — five income requirements were vacuously satisfied against empty
    // arrays while their applicability was still unknown, then resolved to
    // inapplicable when payroll returned. See progress() in engine.ts.
    let file = afterIdentity();
    const counts = [progress(file).satisfied];

    file = afterDeclarations(file);
    counts.push(progress(file).satisfied);

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    counts.push(progress(file).satisfied);

    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    counts.push(progress(file).satisfied);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: asFileEmployment(payroll.data.employments, file.borrowers[0]!.partyId),
    };
    counts.push(progress(file).satisfied);

    file = { ...file, consents: [...file.consents, consent("form_4506c")] };
    const irs = await registry.irs.fetchTranscripts(file, token("tax_transcript"), []);
    file = { ...file, transcripts: irs.data };
    counts.push(progress(file).satisfied);

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });

  it("never lets the new questions move a mid-flight file backwards", async () => {
    // Seven always-applicable borrower-input rows landed in the registry with
    // the declarations screen, and `progress()` counts only what definitely
    // applies — so a file that was nearly done is exactly where a new row
    // shows up as lost ground. The walk below is a borrower who connected
    // everything first and answered the questions afterwards, which is the
    // order a resumed file takes them in.
    let file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    file = { ...file, assets: bankOutcome.result.data };

    const answered = afterDeclarations(file);
    const before = progress(file);
    const after = progress(answered);

    expect(after.satisfied).toBeGreaterThan(before.satisfied);
    // And the three conditional ones resolve rather than linger: a borrower
    // who has answered is no longer somebody we might still ask.
    expect(after.undetermined).toBeLessThan(before.undetermined);
    expect(after.outstanding).toBeLessThan(before.outstanding);

    // Named, not counted. The counts above rise for any answer at all — one
    // residence row moves both of them — so the assertion that the screen did
    // its job has to say which requirements it retired.
    const satisfied = assessAll(answered)
      .filter((a) => a.satisfaction.status === "satisfied")
      .map((a) => a.requirement.id);
    // APP-028 is on the file rather than on each borrower — one house is held
    // on one estate — and it is named here because screen 3 is the only place
    // it can be answered: nothing retrieved carries it, so a walk that reached
    // this point with it already satisfied would be a fixture answering for a
    // borrower who was never asked.
    expect(satisfied).toEqual(expect.arrayContaining(["APP-022", "APP-023", "APP-026", "APP-028"]));
    const stillOwed = assessAll(answered)
      .filter((a) => a.applies === true && a.satisfaction.status !== "satisfied")
      .map((a) => a.requirement.id);
    for (const id of [
      "APP-022",
      "APP-023",
      "APP-024",
      "APP-025",
      "APP-026",
      "APP-027",
      "APP-028",
    ]) {
      expect(stillOwed, id).not.toContain(id);
    }
  });

  it("shrinks the undetermined set as data arrives", async () => {
    let file = afterIdentity();
    const before = progress(file).undetermined;

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: asFileEmployment(payroll.data.employments, file.borrowers[0]!.partyId),
    };

    // "We might still ask" must actually get smaller. If it did not, the
    // conditions are not reading the data the connectors returned.
    expect(progress(file).undetermined).toBeLessThan(before);
  });

  it("never marks an unsatisfied requirement as satisfied on an empty file", () => {
    const file = afterIdentity();
    const satisfied = assessAll(file)
      .filter((a) => a.satisfaction.status === "satisfied")
      .map((a) => a.requirement.id);

    // Nothing that depends on a connector may be satisfied before one runs.
    expect(satisfied).not.toContain("CRD-001");
    expect(satisfied).not.toContain("AST-001");
    expect(satisfied).not.toContain("INC-002");
    expect(satisfied).not.toContain("UW-001");
  });

  /**
   * A housing basis nobody stated is not a renter.
   *
   * `borrowers.current_housing` was NOT NULL with a default of "rent", so
   * `renter_limited_mortgage_history` — which tests only `=== "own"` — answered
   * "yes, a renter" about every borrower in the product, on a question no
   * screen asked. The column is nullable now, and the condition has to answer
   * the third value rather than fall through to the renter branch.
   */
  function withNoStatedHousing(file: LoanFile): LoanFile {
    return {
      ...file,
      borrowers: file.borrowers.map((b) => ({
        ...b,
        currentHousing: null,
        monthlyRent: undefined,
      })),
    };
  }

  /**
   * With the credit report in hand, so the condition has everything BUT the
   * basis. Before the pull it answers null for want of a tradeline history and
   * the housing basis decides nothing, which would make the pair below agree
   * for the wrong reason.
   */
  async function afterCredit(): Promise<LoanFile> {
    const file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    return { ...file, credit: credit.data };
  }

  it("cannot say whether an unasked borrower rents", async () => {
    const file = await afterCredit();
    const stated = assessAll(file).find((a) => a.requirement.id === RENTER_REQUIREMENT);
    const unasked = assessAll(withNoStatedHousing(file)).find(
      (a) => a.requirement.id === RENTER_REQUIREMENT,
    );

    expect(stated!.applies).not.toBeNull();
    expect(unasked!.applies).toBeNull();
  });

  it("counts an unasked borrower as undetermined rather than decided", async () => {
    // Rule 2, in the one number a borrower reads: applicability is three-valued
    // and `progress()` counts only what definitely applies. An unknown basis
    // moves the requirement into "we might still ask", which is the honest
    // place for it, rather than leaving it answered from a default.
    const file = await afterCredit();
    const stated = progress(file);
    const unasked = progress(withNoStatedHousing(file));

    expect(unasked.undetermined).toBe(stated.undetermined + 1);
  });

  it("still never lets satisfied progress go backwards with no basis stated", async () => {
    // The regression the counts test guards, walked again on a file whose
    // housing basis is unknown for the whole walk. A third value that made the
    // count move backwards would be the 23 → 21 failure in a new costume.
    let file = withNoStatedHousing(afterIdentity());
    const counts = [progress(file).satisfied];

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    counts.push(progress(file).satisfied);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: asFileEmployment(payroll.data.employments, file.borrowers[0]!.partyId),
    };
    counts.push(progress(file).satisfied);

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });

  it("orders outstanding work by regulatory exposure first", () => {
    const items = outstanding(afterIdentity());
    const severities = items.map((i) => i.requirement.failureSeverity);
    const firstRework = severities.indexOf("rework_delay");
    const lastRegulatory = severities.lastIndexOf("regulatory_violation");
    if (firstRework !== -1 && lastRegulatory !== -1) {
      expect(lastRegulatory).toBeLessThan(firstRework);
    }
  });
});

/**
 * What the engine counts when there are two people and one has answered.
 *
 * Every per-borrower evaluator read `borrowers[0]`, so a co-borrower who had
 * answered nothing left the file reading exactly as complete as a file with
 * nobody on it but the primary. That is the same shape of mistake as one
 * person's signature authorizing another's credit pull, arriving as a number
 * instead of as a retrieval: the product told a household it was finished on
 * the strength of half a household's answers.
 */
describe("a second borrower", () => {
  const SAM = "22222222-2222-2222-2222-222222222222";

  /** On the file, and asked nothing so far. */
  function withCoBorrower(file: LoanFile): LoanFile {
    const first = file.borrowers[0]!;
    return {
      ...file,
      borrowers: [
        first,
        {
          ...first,
          id: "b2",
          partyId: SAM,
          firstName: "Sam",
          lastName: "Okafor",
          email: "sam@example.com",
          ssn: { last4: "8765", vaultHandle: "vault:8765:test" },
          identityVerification: null,
          demographics: null,
          firstTimeHomebuyer: null,
          currentHousing: null,
          monthlyRent: undefined,
          // He has said he is married and named nobody. The file's consent
          // rows are all hers, so he has signed neither the verification
          // authorization nor the eConsent either.
          maritalStatus: "married",
          nonBorrowingSpouseName: undefined,
          // Different from hers, so a requirement that went back to reading
          // the first borrower would answer with her language and still call
          // itself satisfied.
          preferredLanguage: "es",
        },
      ],
    };
  }

  /** His own answers, given — one for every field the file puts to both people. */
  function coBorrowerAnswers(file: LoanFile): LoanFile {
    const first = file.borrowers[0]!;
    return {
      ...file,
      borrowers: [
        first,
        {
          ...file.borrowers[1]!,
          identityVerification: {
            verificationId: "fixture-idv.b2",
            status: "verified",
            verifiedAt: REFERENCE.toISOString(),
          },
          demographics: {
            ethnicity: "declined",
            race: "declined",
            sex: "declined",
            visualObservationNoted: false,
          },
          firstTimeHomebuyer: true,
          currentHousing: "rent",
          monthlyRent: 2_150,
          nonBorrowingSpouseName: "Adaeze Okafor",
        },
      ],
      consents: [
        ...file.consents,
        { ...consent("verification_authorization"), borrowerId: "b2" },
        { ...consent("econsent"), borrowerId: "b2" },
      ],
    };
  }

  const idsSatisfied = (file: LoanFile) =>
    assessAll(file)
      .filter((a) => a.satisfaction.status === "satisfied")
      .map((a) => a.requirement.id);

  it("is not finished because the first borrower is", () => {
    const alone = afterIdentity();
    const together = withCoBorrower(alone);

    // What the co-borrower genuinely owes: his identity is unverified, he has
    // not been put the Reg B questions, nobody has asked whether he has owned a
    // home, he has named no spouse, and he has signed neither the verification
    // authorization nor the eConsent. Each was satisfied while he was
    // invisible — APP-005 while `tokenFor` would refuse every pull about him.
    for (const id of ["APP-001", "APP-005", "APP-011", "APP-012", "APP-015", "APP-021"]) {
      expect(idsSatisfied(alone), id).toContain(id);
      expect(idsSatisfied(together), id).not.toContain(id);
    }
  });

  it("says which of the two it is still missing", () => {
    const together = withCoBorrower(afterIdentity());
    const identity = assessAll(together).find((a) => a.requirement.id === "APP-001")!;
    expect(identity.satisfaction.status).toBe("unsatisfied");
    // The name is the whole point of asking everybody: "identity not verified"
    // on a two-person file is not an answer anybody can act on.
    expect((identity.satisfaction as { missing: string }).missing).toContain("Sam Okafor");
    expect((identity.satisfaction as { missing: string }).missing).not.toContain("Dana");
  });

  it("leaves a one-borrower file counting exactly what it counted before", () => {
    // The guard on the change itself. A second person is what puts a name in
    // front of the evidence and a requirement back on the list; a file with one
    // borrower must read character for character as it did.
    const alone = afterIdentity();
    const identity = assessAll(alone).find((a) => a.requirement.id === "APP-001")!;
    expect(identity.satisfaction).toEqual({
      status: "satisfied",
      evidence: "identity verified 2026-06-15",
    });
  });

  it("counts his answers forward, never backward", () => {
    // The 23 → 21 invariant, on the axis this commit adds. Answering for the
    // second person may only ever raise the satisfied count, and must raise it:
    // a co-borrower whose answers changed nothing would mean they were never
    // being counted.
    const unanswered = progress(withCoBorrower(afterIdentity()));
    const answered = progress(coBorrowerAnswers(withCoBorrower(afterIdentity())));

    expect(answered.satisfied).toBeGreaterThan(unanswered.satisfied);
    expect(answered.borrowerOutstanding).toBeLessThan(unanswered.borrowerOutstanding);
  });

  it("does not let his silence settle a question about her", async () => {
    // `renter_limited_mortgage_history` is true of anybody who rents and false
    // only once it is false of everybody. She rents, so the rent history is
    // owed whatever he turns out to be — his silence must not retire it, and
    // `some()` over a three-valued answer would have read it as a no.
    const file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    const together = withCoBorrower({ ...file, credit: credit.data });

    const rent = assessAll(together).find((a) => a.requirement.id === RENTER_REQUIREMENT)!;
    expect(rent.applies).toBe(true);
  });

  it("cannot say whether a household rents when only the owner has answered", async () => {
    // And the other direction: she owns outright, he has not been asked. False
    // for everybody who has answered is not false for the file, because the one
    // person who has not answered is the one who could still make it true.
    const file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    const owner = {
      ...file,
      credit: credit.data,
      borrowers: [{ ...file.borrowers[0]!, currentHousing: "own" as const }],
    };

    expect(assessAll(owner).find((a) => a.requirement.id === RENTER_REQUIREMENT)!.applies).toBe(
      false,
    );
    expect(
      assessAll(withCoBorrower(owner)).find((a) => a.requirement.id === RENTER_REQUIREMENT)!
        .applies,
    ).toBeNull();
  });

  it("does not judge his rent history by her credit report", async () => {
    // `LoanFile.credit` is ONE report and it carries no party; every pull mints
    // its token from the first borrower, so the tradelines are hers. Asking the
    // rent-history question of him and answering it out of her file said "he
    // has twelve months of mortgage rating" about a man whose credit has never
    // been pulled, and retired CRD-018 for an actual renter.
    const file = afterIdentity();
    const pulled = await registry.credit.pullTriMerge(file, token("credit_report"));
    const herMortgage = {
      id: "tl-her-mortgage",
      creditorName: "Fixture Savings",
      type: "mortgage" as const,
      balance: 310_000,
      monthlyPayment: 1_980,
      openedDate: "2019-04-01",
      disputed: false,
      paymentHistory: Array.from({ length: 24 }, () => "0"),
      maxDelinquency: 0,
    };
    const owner = {
      ...file,
      credit: { ...pulled.data, tradelines: [...pulled.data.tradelines, herMortgage] },
      borrowers: [{ ...file.borrowers[0]!, currentHousing: "own" as const }],
    };
    const together = withCoBorrower(owner);
    const heRents: LoanFile = {
      ...together,
      borrowers: [
        together.borrowers[0]!,
        { ...together.borrowers[1]!, currentHousing: "rent" as const, monthlyRent: 1_800 },
      ],
    };

    // Null, not false. "We have not pulled his credit" and "he has a mortgage"
    // are different answers and only one of them is true.
    expect(
      assessAll(heRents).find((a) => a.requirement.id === RENTER_REQUIREMENT)!.applies,
    ).toBeNull();
  });

  it("reads every per-borrower answer off his own row", () => {
    // Each field asked of both people, driven to a different value on his row
    // than on hers. A requirement that went back to the first borrower would
    // answer with her language, her spouse handling and her signature — and
    // report itself satisfied on his behalf.
    const together = coBorrowerAnswers(withCoBorrower(afterIdentity()));
    const evidence = (id: string) => {
      const a = assessAll(together).find((x) => x.requirement.id === id)!;
      expect(a.satisfaction.status, id).toBe("satisfied");
      return (a.satisfaction as { evidence: string }).evidence;
    };

    expect(evidence("APP-017")).toBe(
      "Dana Whitfield: preferred language en; Sam Okafor: preferred language es",
    );
    for (const id of ["APP-005", "APP-012", "APP-015", "APP-021"]) {
      expect(evidence(id), id).toContain("Sam Okafor");
    }
  });
});

describe("the decision", () => {
  async function fullyConnected(): Promise<LoanFile> {
    let file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: asFileEmployment(payroll.data.employments, file.borrowers[0]!.partyId),
      consents: [...file.consents, consent("form_4506c")],
    };
    const irs = await registry.irs.fetchTranscripts(file, token("tax_transcript"), []);
    return { ...file, transcripts: irs.data };
  }

  /**
   * The same borrower on a loan the engine will not state an APR for.
   *
   * 92.3% of value, which is mortgage insurance, which is a finance charge
   * this engine holds only an estimated rate card for. It is inside every
   * eligibility limit, so what the engine reports is that it could not compute
   * — not that it turned the loan down.
   */
  const insured = (file: LoanFile): LoanFile => ({
    ...file,
    loan: { ...file.loan!, loanAmount: 600_000, downPayment: 50_000 },
  });

  it("computes ratios from connected data", async () => {
    const decision = underwrite(await fullyConnected(), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    expect(decision.ratios.dtiBack).not.toBeNull();
    expect(decision.ratios.ltv).toBeCloseTo(80, 0);
    expect(decision.ratios.totalQualifyingIncome).toBe(
      PERSONAS.clean_w2.payroll(REFERENCE).incomeSources[0]!.monthlyAmount,
    );
  });

  it("records a derivation for every number it reports", async () => {
    const decision = underwrite(await fullyConnected(), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    const labels = decision.derivations.map((d) => d.label);
    expect(labels).toContain("Back-end DTI");
    expect(labels).toContain("LTV");
    expect(labels).toContain("Housing PITIA");
    expect(labels).toContain("Representative FICO");

    for (const d of decision.derivations) {
      // A derivation with neither a formula nor a blocking reason is a number
      // with no explanation, which is exactly what screen 8 must never show.
      expect(d.formula === "not computed" ? d.blockedBy?.length : d.formula.length).toBeTruthy();
    }
  });

  it("refers rather than approves when an input could not be computed", async () => {
    // Mortgage insurance, so there is no APR and the tests that need one block.
    const decision = underwrite(insured(await fullyConnected()), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    expect(decision.derivations.some((d) => d.blockedBy?.length)).toBe(true);
    expect(decision.aus?.recommendation).toBe("refer");
    // And it must NOT quietly claim a clean bill of health.
    expect(decision.outcome).not.toBe("clear_to_close");
    // Nor wear a decided word at all. `referred` is the outcome's own way of
    // saying the recommendation could not be turned into a decision.
    expect(decision.outcome).toBe("referred");
  });

  it("stamps the engine so a shadow decision is never mistaken for an agency one", async () => {
    const decision = underwrite(await fullyConnected(), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });
    expect(decision.aus?.engine).toBe("shadow");
  });

  it("runs the compliance tests on nothing but the file", async () => {
    // Nobody is handed a market. The fee schedule is priced against the loan,
    // the average prime offer rate comes off the week this file's rate was
    // quoted, and the APR is solved from the two — which is what it takes for
    // a file a borrower actually walked to carry a QM determination.
    const decision = underwrite(await fullyConnected(), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    expect(decision.compliance.qmStatus).toBe("qm");
    expect(decision.compliance.isHpml).toBe(false);
    expect(decision.compliance.pointsAndFeesPass).toBe(true);
    expect(decision.compliance.isHighCost).toBe(false);
  });

  it("blocks the tests that need an APR when it will not state one", async () => {
    const decision = underwrite(insured(await fullyConnected()), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });
    // The fee schedule still prices, so the points-and-fees test still runs.
    // What stops is everything that compares a rate to the market — including
    // HOEPA, which may not answer "not high-cost" off the fee trigger while
    // its rate trigger was never tested.
    expect(decision.compliance.pointsAndFeesPass).toBe(true);
    expect(decision.compliance.qmStatus).toBeNull();
    expect(decision.compliance.isHpml).toBeNull();
    expect(decision.compliance.isHighCost).toBeNull();
  });

  it("still takes a market it is handed, which is the persona seed's privilege", async () => {
    const decision = underwrite(await fullyConnected(), {
      aporTable: APOR_TABLE,
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
      market: { apr: 6.44, apor: 6.1, pointsAndFeesAmount: 9_800, totalLoanAmount: 328_750 },
      estimatedFees: 9_800,
      estimatedPrepaids: 4_200,
    });

    expect(decision.compliance.isHpml).toBe(false);
    expect(decision.compliance.pointsAndFeesPass).toBe(true);
    expect(decision.compliance.isHighCost).toBe(false);
  });
});
