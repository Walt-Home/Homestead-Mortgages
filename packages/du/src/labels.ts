/**
 * `xlink:label`, minted per document and stored nowhere.
 *
 * The attribute's type is `xs:NCName`: a value must begin with a letter or an
 * underscore and may not contain a colon. **A bare UUID is illegal whenever it
 * starts with a digit** — ten of sixteen first hex characters are digits, so
 * about 62% of `randomUUID()` output fails schema validation outright, and a
 * URN with colons fails always. So labels are minted from a prefix and a
 * counter, and `assertNCName` is here to make a future prefix fail loudly
 * rather than in Fannie Mae's parser.
 *
 * **Labels carry no meaning between submissions and nothing may store one.**
 * They number the LIVE rows in `(created_at, id)` order, and a row that went
 * away and came back keeps its `created_at`: it re-enters that order in the
 * middle and renumbers every `ASSET_n` after it. Reviving a row in place is the
 * operation the identity index exists to permit, so this is the model working
 * rather than a defect in it. What survives a resubmission is the row's uuid
 * primary key and DU's returned casefile identifier.
 *
 * Fannie Mae's own files are inconsistent about how labels are formed, which is
 * the other half of the argument: `DI-C09` decouples the counter from
 * `SequenceNumber` (`<LIABILITY SequenceNumber="4" xlink:label="LIABILITY_3">`)
 * while `DI-C02` tracks them, and a related loan is `LOANRELATED_n` in seven
 * files and `RELATED_LOAN_n` in two. Anything parsing a label prefix is
 * building on sand.
 */

/**
 * The label spaces, one per container kind that an arc can name.
 *
 * `asset` spans all four asset kinds because they share one XML container, one
 * label space and one `SequenceNumber` space — so the allocator cannot be per
 * table. The five role kinds below the borrower are the non-borrowing parties
 * `du_deal_parties` and `du_vestings` hold; Fannie Mae labels those roles too,
 * even though no arc in the eighteen samples points at one.
 */
const PREFIX = {
  asset: "ASSET",
  liability: "LIABILITY",
  expense: "EXPENSE",
  borrowerRole: "BORROWER",
  employer: "EMPLOYER",
  incomeItem: "CURRENT_INCOME_ITEM",
  verification: "VERIFICATION",
  propertyOwnerRole: "PROPERTY_OWNER",
  loanOriginationCompanyRole: "LOAN_ORIGINATION_COMPANY",
  loanOriginatorRole: "LOAN_ORIGINATOR",
  notePayToRole: "NOTE_PAY_TO",
  housingCounselingAgencyRole: "HOUSING_COUNSELING_AGENCY",
} as const;

export type DuLabelKind = keyof typeof PREFIX;

/** What `xs:NCName` admits, minus the colon the type also forbids. */
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Refuse a label the schema would refuse.
 *
 * Every label this file mints passes by construction, so this is aimed at the
 * next prefix somebody adds: a name with a space or a colon in it produces a
 * document that fails validation with a message about an attribute value, a
 * long way from the constant that caused it.
 */
export function assertNCName(label: string): string {
  if (!NCNAME.test(label)) {
    throw new Error(
      `${JSON.stringify(label)} cannot be an xlink:label: xs:NCName starts with a letter ` +
        "or an underscore and carries no colon.",
    );
  }
  return label;
}

/** One allocator per document, per container kind. */
export interface DuLabels {
  /** The next label in `kind`'s space, numbered from 1 in emission order. */
  next(kind: DuLabelKind): string;
}

export function createLabels(): DuLabels {
  const issued = new Map<DuLabelKind, number>();
  return {
    next(kind) {
      const n = (issued.get(kind) ?? 0) + 1;
      issued.set(kind, n);
      return assertNCName(`${PREFIX[kind]}_${n}`);
    },
  };
}

/**
 * Which row got which label, so the arcs can be folded after the containers
 * are built.
 *
 * A `RELATIONSHIP` names two labels and nothing else — there is nowhere on an
 * arc for an ownership share, an as-of date or a primary flag, which is why
 * none of those has a column — so the graph can only be written once both ends
 * have been minted. Every map here is keyed by the row the label was minted
 * for, except the last three: an owned property is reached through its asset,
 * because `ASSET_IsAssociatedWith_LIABILITY` points at the ASSET and the
 * foreign key that carries it points at the `du_owned_properties` row; an
 * `EMPLOYER` element is one employment, so it is keyed by the party and the
 * employer together; and a verification is one report type for one borrower
 * rather than one snapshot, so it is keyed by the pair it was selected for and
 * not by the row it was read from.
 */
export interface DuLabelIndex {
  readonly assetByRow: Map<string, string>;
  readonly assetByOwnedProperty: Map<string, string>;
  readonly liabilityByRow: Map<string, string>;
  readonly expenseByRow: Map<string, string>;
  readonly roleByApplicationParty: Map<string, string>;
  readonly incomeItemByRow: Map<string, string>;
  readonly employerByPartyAndEmployer: Map<string, string>;
  readonly verificationByReportTypeAndParty: Map<string, string>;
}

export function createLabelIndex(): DuLabelIndex {
  return {
    assetByRow: new Map(),
    assetByOwnedProperty: new Map(),
    liabilityByRow: new Map(),
    expenseByRow: new Map(),
    roleByApplicationParty: new Map(),
    incomeItemByRow: new Map(),
    employerByPartyAndEmployer: new Map(),
    verificationByReportTypeAndParty: new Map(),
  };
}

/** The key an `EMPLOYER` label is filed under: one element per party per employer. */
export function employerKey(partyId: string, employerId: string): string {
  return `${partyId}:${employerId}`;
}

/**
 * The key a `DU:UNDERWRITING_VERIFICATION` label is filed under.
 *
 * The pair rather than the snapshot id, because the selection keeps one report
 * per type per borrower out of an append-only history: the row that produced
 * the element is not what the arc is about, and keying on it would make the
 * label unfindable the moment a re-pull changed which row won.
 */
export function verificationKey(reportType: string, applicationPartyId: string): string {
  return `${reportType}:${applicationPartyId}`;
}
