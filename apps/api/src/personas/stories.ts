/**
 * The sample borrowers, and the one list that describes them.
 *
 * A tester needs to see what a file in each state actually looks like, and the
 * only honest way to show that is to have walked one there. So a persona is
 * not a screenshot and not a fixture blob: it is a real user, a real file and
 * a real application whose every state was written by the same services the
 * four screens call. This file says who they are and where they should end up;
 * the seed walks them there and refuses to commit one that lands somewhere
 * else.
 *
 * Three readers, one list: the seed, `GET /api/auth/personas` (which shows the
 * LIVE state beside each name, not the target), and the health line.
 *
 * `story` and `unavailableBecause` are borrower-visible copy — they render on
 * the sign-in page to anyone who loads staging — so they keep the same rules
 * every other line of copy keeps, and `stories.test.ts` runs those rules over
 * them.
 */

import type { FlowStage } from "@hm/db";
import type { PersonaId } from "@hm/connectors";
import type {
  Address,
  ApplicationState,
  DecisionOutcome,
  LoanPurpose,
  OccupancyType,
  PropertyType,
} from "@hm/shared";
import type { MarketInputs } from "@hm/underwriting";

export type PersonaKey =
  | "maya_okafor"
  | "ben_castillo"
  | "priya_dev_raman"
  | "tom_nguyen"
  | "aisha_bello"
  | "grander_import"
  | "lena_fischer"
  | "marcus_hale"
  | "omar_haddad";

/**
 * The row this build cannot walk a person to, and everybody else.
 *
 * Split at the type level so `Record<SeededKey, …>` is exhaustive: the seed
 * keeps one walk per person, and adding a persona without one is a compile
 * error rather than a missing sample nobody notices until staging.
 */
export type DeferredKey = "grander_import";
export type SeededKey = Exclude<PersonaKey, DeferredKey>;

/** Screen 1's answers, in dollars. The seed converts to cents at the boundary. */
export interface PersonaTerms {
  readonly purpose: LoanPurpose;
  readonly valueOrPrice: number;
  readonly loanAmount: number;
  readonly downPayment: number;
  readonly occupancy: OccupancyType;
  readonly propertyType: PropertyType;
  /**
   * One of the three addresses the fixture property adapter knows. Anything
   * else falls back to manual entry with no property card, so a persona at
   * another address would open on a screen 1 that cannot describe its own
   * house. `stories.test.ts` holds this against `ADDRESS_BOOK`.
   */
  readonly address: Address;
}

interface PersonaBase<K extends PersonaKey> {
  readonly key: K;
  /**
   * What the picker's row is called, which is not always one person's name.
   *
   * Priya's row is two people and says so; the Grander row is a mortgage
   * nobody has claimed. So this is a label, and the seed does not write it
   * into anybody's `legal_name` — the person's own name lives beside their
   * date of birth in the seed, with the rest of screen 2's answers.
   */
  readonly name: { readonly first: string; readonly last: string };
  /** One line, in borrower words. No dates, no promises, no requirement ids. */
  readonly story: string;
}

/**
 * A persona the seed can actually walk to a state.
 *
 * `market` is recorded in the derivation log when the decision runs. It is the
 * APR, APOR and fee total the flow does not collect, supplied here rather than
 * invented by the engine — which is why a real-flow file ends `referred` and
 * these do not.
 */
export interface SeededPersona extends PersonaBase<SeededKey> {
  readonly target: ApplicationState;
  readonly fixture: PersonaId;
  readonly fixtureOptions?: { readonly screening?: "clear" | "near_match" };
  readonly resumeStage: FlowStage;
  readonly terms: PersonaTerms;
  readonly market?: MarketInputs;
  readonly expectedOutcome?: DecisionOutcome;
}

/** A state the model can name and this build cannot produce a person in. */
export interface DeferredPersona extends PersonaBase<DeferredKey> {
  readonly target: null;
  readonly unavailableBecause: string;
}

/**
 * Two shapes rather than one with optional fields, discriminated on `target`.
 *
 * The deferred row has no fixture, no terms and no stage, and giving it
 * placeholders would be exactly the invention the row exists to refuse. This
 * way the seed cannot reach for terms that were never decided, and the picker
 * cannot offer a row that has nowhere to go.
 */
export type PersonaStory = SeededPersona | DeferredPersona;

export function isSeeded(story: PersonaStory): story is SeededPersona {
  return story.target !== null;
}

/**
 * What a row this build knows how to walk, and this database has not been
 * given, says for itself. Borrower-visible, like the stories beside it, so
 * `stories.test.ts` runs the same rules over it.
 */
export const NOT_SEEDED_HERE = "This one has not been set up on this deployment.";

/*
 * The three houses, copied from the fixture's own address book.
 *
 * They are matched exactly — `fixturePropertyDataConnector` throws
 * `AddressNotFoundError` on anything else, and screen 1 falls back to manual
 * entry with no property card — so these are the subject-property addresses,
 * which are not the addresses the identity documents carry.
 */

/** clean_w2's house: a 1962 single-family in Travis County. */
const AUSTIN: Address = {
  line1: "1247 Oak Street",
  city: "Austin",
  state: "TX",
  postalCode: "78704",
};

/** thin_file_renter's: a condo, so association dues are part of the payment. */
const ATLANTA: Address = {
  line1: "540 Ponce De Leon Ave NE",
  line2: "Unit 312",
  city: "Atlanta",
  state: "GA",
  postalCode: "30308",
};

/** variable_income's: Willow Glen, and the assessor's tax figure, not the AVM's. */
const SAN_JOSE: Address = {
  line1: "1247 Oak Street",
  city: "San Jose",
  state: "CA",
  postalCode: "95125",
};

export const PERSONA_STORIES: readonly PersonaStory[] = [
  {
    key: "maya_okafor",
    name: { first: "Maya", last: "Okafor" },
    story: "Has told us who she is and what she is buying; her bank is the next thing.",
    target: "awaiting_borrower",
    fixture: "clean_w2",
    resumeStage: "BANK",
    terms: {
      purpose: "purchase",
      valueOrPrice: 415_000,
      loanAmount: 332_000,
      downPayment: 83_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
  },
  {
    key: "ben_castillo",
    name: { first: "Ben", last: "Castillo" },
    story: "Refinancing the house he already owns. His bank is connected and the work is ours.",
    target: "in_processing",
    fixture: "clean_w2",
    resumeStage: "PAYROLL",
    terms: {
      purpose: "rate_term_refinance",
      valueOrPrice: 415_000,
      loanAmount: 300_000,
      downPayment: 0,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
  },
  {
    key: "priya_dev_raman",
    name: { first: "Priya and Dev", last: "Raman" },
    /*
     * The two conditions the fixture is built to raise, in her words rather
     * than the engine's, and named here because no screen names them: the
     * review screen's approved ending renders the figures and the timeline,
     * and `loan_conditions` reaches no borrower surface yet. A story saying
     * the conditions are named on the file points at a page that does not do
     * it.
     */
    story:
      "Two people, commission income and a gift. Approved, with her pay against last year's " +
      "tax record and a debt load above our usual line still to settle.",
    target: "conditionally_approved",
    fixture: "variable_income",
    resumeStage: "PERSISTENT_CONSENT",
    terms: {
      purpose: "purchase",
      valueOrPrice: 420_000,
      loanAmount: 336_000,
      downPayment: 84_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: SAN_JOSE,
    },
    // Two percent of the loan, which is what the points-and-fees test needs
    // and the flow never collects.
    market: { apr: 6.625, apor: 6.2, pointsAndFeesAmount: 6_720 },
    expectedOutcome: "approved_with_conditions",
  },
  {
    key: "tom_nguyen",
    name: { first: "Tom", last: "Nguyen" },
    story: "Asked for more than the house will carry, and was offered a smaller loan instead.",
    target: "counteroffer_outstanding",
    fixture: "clean_w2",
    resumeStage: "PERSISTENT_CONSENT",
    terms: {
      // 97.9% of value, over the 97% cap for a primary residence. The one
      // decided state a tester can reach through the real flow, because the
      // finding is an eligibility rule and needs no market inputs.
      purpose: "purchase",
      valueOrPrice: 425_000,
      loanAmount: 416_000,
      downPayment: 9_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
    expectedOutcome: "counteroffer",
  },
  {
    key: "aisha_bello",
    name: { first: "Aisha", last: "Bello" },
    story: "A short credit history and a price that made the loan too expensive to approve.",
    target: "adverse_action_pending",
    fixture: "thin_file_renter",
    resumeStage: "PERSISTENT_CONSENT",
    terms: {
      purpose: "purchase",
      valueOrPrice: 299_000,
      loanAmount: 284_050,
      downPayment: 14_950,
      occupancy: "primary_residence",
      // A condo, which is what the county record says and what makes the
      // association dues part of the payment the engine tests her against.
      propertyType: "condo",
      address: ATLANTA,
    },
    // An APR 7.05 points over the average prime offer rate, which is what
    // makes this loan high-cost under HOEPA.
    market: { apr: 13.6, apor: 6.55, pointsAndFeesAmount: 2_840.5 },
    expectedOutcome: "denied",
  },
  {
    key: "grander_import",
    name: { first: "Grander", last: "import" },
    story: "A mortgage somebody already has, waiting for the person it belongs to.",
    target: null,
    /*
     * Not seeded, and not fixable by seeding harder.
     *
     * A Grander member is a party and a loan with no application. The loan
     * half is built: `createImportedLoan` in `services/loans.ts` births one
     * `imported_unclaimed` from a `partner_import` with no originating
     * application, and `loan-machine.ts` holds the `borrower_claimed` edge out
     * of it. What is missing is anything that would put a row there. Nothing
     * outside the tests calls `createImportedLoan`, there is no ingest route
     * and no importer, and the API accepts no machine credential for one to
     * present — `requireAuth` takes a Google sign-in cookie and nothing else.
     * Claiming one is a signed single-use token from Grander, not a sign-in
     * match, and that is unbuilt too.
     *
     * The seed would refuse even with all of that built. An application in any
     * state would say this person asked us for credit when they did not, and
     * an unclaimed party has never authenticated — so there is no user to sign
     * a tester in as.
     *
     * The nearest truthful shape, for whoever builds the importer: a
     * PROVISIONAL party with `sourceFirstSeen: "grander_import"`, its facts
     * asserted by a PARTNER principal at PARTNER_SHARED/UNVERIFIED, one loan
     * row in `imported_unclaimed`, no user, and nothing person-keyed
     * retrievable until the claim. Every piece of that exists already —
     * `createProvisionalParty`, `partnerPrincipal` and `assertPartnerFacts` in
     * `services/party.ts`, and `moveLoanIfLegal` in
     * `services/loan-transition.ts` for the claim itself.
     */
    unavailableBecause: "This is a mortgage that already exists, and we don't hold those yet.",
  },
  {
    key: "lena_fischer",
    name: { first: "Lena", last: "Fischer" },
    story: "Started, then asked us to stop. The record is closed and nothing moves it again.",
    target: "withdrawn",
    fixture: "clean_w2",
    resumeStage: "BANK",
    terms: {
      purpose: "purchase",
      valueOrPrice: 415_000,
      loanAmount: 332_000,
      downPayment: 83_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
  },
  {
    key: "marcus_hale",
    name: { first: "Marcus", last: "Hale" },
    story: "All the way to funded. The closing steps were recorded by hand for this sample.",
    target: "funded",
    fixture: "clean_w2",
    resumeStage: "COMPLETE",
    terms: {
      purpose: "purchase",
      valueOrPrice: 415_000,
      loanAmount: 332_000,
      downPayment: 83_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
    market: { apr: 6.625, apor: 6.2, pointsAndFeesAmount: 6_640 },
    expectedOutcome: "clear_to_close",
  },
  {
    key: "omar_haddad",
    name: { first: "Omar", last: "Haddad" },
    story: "On hold while somebody checks a name that looks like one on a watchlist.",
    target: "suspended",
    fixture: "clean_w2",
    // Every real fixture screens clear, so without this the pill would be
    // contradicted by the file's own evidence.
    fixtureOptions: { screening: "near_match" },
    resumeStage: "BANK",
    terms: {
      purpose: "purchase",
      valueOrPrice: 415_000,
      loanAmount: 332_000,
      downPayment: 83_000,
      occupancy: "primary_residence",
      propertyType: "single_family",
      address: AUSTIN,
    },
  },
];
