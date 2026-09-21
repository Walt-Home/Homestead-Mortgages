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
import { NORTHLIGHT } from "@hm/partner-book";
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
export type ImportedKey = "grander_import";
export type SeededKey = Exclude<PersonaKey, ImportedKey>;

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
 * `market` states the APR, APOR and fee total instead of letting the engine
 * derive them, and a seed is the only caller that may. Two reasons, and both
 * are about a sample borrower having to stand where the picker says they
 * stand: a high-cost decline needs an APR six and a half points over the
 * market and no rate sheet in this repository quotes one, and the average
 * prime offer table covers the weeks that have been published, so a seed run
 * next month would refer the borrowers it walked today.
 */
export interface SeededPersona extends PersonaBase<SeededKey> {
  readonly target: ApplicationState;
  readonly fixture: PersonaId;
  readonly fixtureOptions?: { readonly screening?: "clear" | "near_match" };
  readonly resumeStage: FlowStage;
  readonly terms: PersonaTerms;
  readonly market?: MarketInputs;
  readonly expectedOutcome?: DecisionOutcome;
  /**
   * A second sign-in on this story's file: the person the applicant named,
   * who owns no file and is listed under the row that does. The seed walks
   * them through the product's own invitation and claim, so the picker can
   * offer both halves of a household and a tester can be either.
   */
  readonly coBorrower?: SeededCoBorrower;
}

/**
 * The shape `users.persona_key` takes, and the one the sign-in route accepts:
 * a story's key, or a story's key with a suffix after a colon for a second
 * person on that story's file. The database's CHECK says the same thing, and
 * a key the CHECK refuses would fail the deploy rather than the build.
 */
export const PERSONA_KEY_SHAPE = /^[a-z][a-z0-9_]{1,40}(?::[a-z][a-z0-9_]{1,20})?$/;

/** A co-borrower's own row on the picker. Their `key` is the story's, suffixed. */
export interface SeededCoBorrower {
  readonly key: `${SeededKey}:${string}`;
  readonly name: { readonly first: string; readonly last: string };
  /** One line, in borrower words, like the story above it. */
  readonly story: string;
}

/**
 * A person the seed stands on a loan a servicer's tape wrote, rather than
 * walks through an application. No target state, because there is no
 * application: the loan is the record, and it stands where the tape left it.
 */
export interface ImportedPersona extends PersonaBase<ImportedKey> {
  readonly target: null;
  /** The loan the sign-in stands on: the sample book's servicer, and the number the servicer put on the tape. */
  readonly loan: { readonly servicerSlug: string; readonly servicerLoanNumber: string };
}

/**
 * Two shapes rather than one with optional fields, discriminated on `target`.
 *
 * The imported row has no fixture, no terms and no stage, and giving it
 * placeholders would be an application this person never asked for. This
 * way the seed cannot reach for terms that were never decided, and the
 * walk cannot be run on a row that has no screens.
 */
export type PersonaStory = SeededPersona | ImportedPersona;

export function isSeeded(story: PersonaStory): story is SeededPersona {
  return story.target !== null;
}

export function isImported(story: PersonaStory): story is ImportedPersona {
  return story.target === null;
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
    // Two percent of the loan, stated rather than priced off the schedule, so
    // that this row reads the same whenever the seed is run.
    market: { apr: 6.625, apor: 6.2, pointsAndFeesAmount: 6_720, totalLoanAmount: 332_730 },
    expectedOutcome: "approved_with_conditions",
    // The other half of the household, seeded through the invitation Priya
    // sends and the claim he takes, so signing in as him is signing in as a
    // co-borrower who arrived the way a real one does.
    coBorrower: {
      key: "priya_dev_raman:dev",
      name: { first: "Dev", last: "Raman" },
      story:
        "Invited by Priya, and finished his own part: his details, his answers, his signature.",
    },
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
    market: { apr: 13.6, apor: 6.55, pointsAndFeesAmount: 2_840.5, totalLoanAmount: 281_039.75 },
    expectedOutcome: "denied",
  },
  {
    key: "grander_import",
    name: { first: "Grander", last: "import" },
    story:
      "A mortgage that already exists, shared with us by the servicer, seen by the person it belongs to.",
    target: null,
    /*
     * Stood on a loan, not walked to a state.
     *
     * A Grander member is a party and a loan with no application. The loan
     * half is written: a servicer's tape reaches
     * `POST /api/partner/book/imports` with a partner key, and
     * `services/partner-book.ts` makes each row an `imported_unclaimed` loan
     * on a PROVISIONAL party carrying the partner's facts, with nothing
     * person-keyed retrievable. The person half — the claim, a signed
     * single-use token from Grander rather than a sign-in match — is still
     * unbuilt.
     *
     * So the seed does what the claim will do, minus the token: it loads the
     * twelve-loan sample book under its servicer at the depth the live read
     * needs, mints this sign-in with a claimed party of its own, and folds
     * the tape's provisional party into it through `mergePartyInto`, the
     * same merge the co-borrower claim uses. The loan follows the party. It
     * stays `imported_unclaimed` and unmonitored, because the transition the
     * claim will make is not written either; what this person can see is
     * `GET /api/loans` and `GET /api/loans/:id/servicing` — the tape's newest
     * observation beside what the servicing platform has concluded — and
     * nothing that would need a credit request they never made.
     */
    loan: { servicerSlug: NORTHLIGHT.slug, servicerLoanNumber: "NL-100001" },
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
    market: { apr: 6.625, apor: 6.2, pointsAndFeesAmount: 6_640, totalLoanAmount: 328_750 },
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
