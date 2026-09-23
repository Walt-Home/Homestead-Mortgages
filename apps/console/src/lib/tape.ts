/**
 * The tape desk's wire: what our API answers about a tape, and the calls
 * the desk makes. The shapes are `services/tape-desk.ts` in `apps/api`,
 * spelled here once for the screen.
 */

import { hm, upload, type Call } from "./api.js";

export type PreviewChange = "created" | "updated" | "unchanged";

export interface RowException {
  readonly row: number;
  readonly code: string;
  readonly detail?: string;
  readonly message?: string;
  readonly [k: string]: unknown;
}

export interface PreviewRow {
  readonly row: number;
  readonly number: string;
  readonly borrower: string | null;
  readonly property: string | null;
  readonly balanceCents: string | null;
  readonly ratePct: string | null;
  readonly standing: string | null;
  readonly change: PreviewChange;
  readonly loanState: string | null;
  readonly claimed: boolean;
  readonly email: string | null;
  readonly exceptions: readonly RowException[];
}

export interface TapePreview {
  readonly profile: string;
  readonly asOf: string;
  readonly servicer: {
    readonly slug: string;
    readonly displayName: string;
    readonly exists: boolean;
  };
  readonly headers: {
    readonly matched: boolean;
    readonly required: number;
    readonly missing: readonly string[];
  };
  readonly rejected: boolean;
  readonly alreadyLoaded: { readonly importId: string; readonly loadedAt: string } | null;
  readonly rowsTotal: number;
  readonly rowsReadable: number;
  readonly rowsRefused: number;
  readonly counts: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
  };
  readonly claimed: number;
  readonly supplement: {
    readonly rows: number;
    readonly matched: number;
    readonly withEmail: number;
    readonly ignoredColumns: readonly string[];
  } | null;
  readonly gaps: Record<string, number>;
  readonly rows: readonly PreviewRow[];
  /** The first few hundred row exceptions; `exceptionsTotal` is the count. */
  readonly exceptions: readonly RowException[];
  readonly exceptionsTotal: number;
  readonly exceptionSummary: readonly {
    readonly code: string;
    readonly column: string | null;
    readonly rows: number;
  }[];
}

export interface DeskServicer {
  readonly slug: string;
  readonly displayName: string;
  readonly integrationDepth: string;
  readonly book: {
    readonly imports: number;
    readonly lastAsOf: string | null;
    readonly loans: {
      readonly total: number;
      readonly byState: Record<string, number | undefined>;
    };
  };
}

export interface DeskImport {
  readonly id: string;
  readonly asOf: string;
  readonly profile: string;
  readonly rowsTotal: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly loansCreated: number;
  readonly loansUpdated: number;
  readonly loansUnchanged: number;
  readonly partiesCreated: number;
  readonly createdAt: string;
}

export interface TapeLoad {
  readonly servicer: {
    readonly slug: string;
    readonly displayName: string;
    readonly id: string;
    readonly created: boolean;
  };
  readonly result:
    | { readonly status: "rejected"; readonly missing_headers: string[] }
    | { readonly status: "already_loaded"; readonly importId: string }
    | {
        readonly status: "loaded";
        readonly importId: string;
        readonly counts: {
          readonly rows_total: number;
          readonly rows_loaded: number;
          readonly rows_rejected: number;
          readonly loans_created: number;
          readonly loans_updated: number;
          readonly loans_unchanged: number;
          readonly parties_created: number;
        };
        readonly report: {
          readonly loans?: readonly {
            readonly servicer_loan_number: string;
            readonly change: string;
            readonly state: string;
          }[];
        } & Record<string, unknown>;
      };
  readonly loadedBy: string;
}

export type InvitationOutcome =
  | {
      readonly number: string;
      readonly status: "sent";
      readonly to: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "not_delivered";
      readonly to: string;
      readonly reason: string;
      readonly link: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "no_address";
      readonly link: string;
      readonly expiresAt: string;
    }
  | { readonly number: string; readonly status: "not_claimable"; readonly reason: string };

/** The servicing app's own receipt for its copy of the book, as its console API answers it. */
export interface ServicingBookReceipt {
  readonly import_id: string;
  readonly status: "loaded" | "rejected" | "already_loaded" | string;
  readonly rows_total?: number;
  readonly rows_loaded?: number;
  readonly rows_exception?: number;
  readonly loans_created?: number;
  readonly loans_updated?: number;
  readonly loans_unchanged?: number;
  readonly parties_created?: number;
  readonly missing_headers?: string[];
  readonly [k: string]: unknown;
}

export interface TapeFiles {
  readonly servicer: { readonly slug: string; readonly displayName: string };
  readonly profile: string;
  readonly asOf?: string;
  readonly tape: { readonly filename: string; readonly base64: string };
  readonly supplement?: { readonly filename: string; readonly base64: string };
}

export const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** A file as the desk sends it: its name and its bytes, base64. */
export async function fileToWire(file: File): Promise<{ filename: string; base64: string }> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than the desk takes (30 MB).`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { filename: file.name, base64: btoa(binary) };
}

/** "Northlight Mortgage Servicing (sample partner)" → "northlight-mortgage-servicing-sample-partner". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const todayEt = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export const deskServicers = (init: Call = {}) =>
  hm<{ servicers: DeskServicer[] }>("/servicers", init).then((r) => r.servicers);

export const deskImports = (slug: string, init: Call = {}) =>
  hm<{ imports: DeskImport[] }>("/imports", { ...init, query: { servicer: slug } }).then(
    (r) => r.imports,
  );

export const previewTape = (files: TapeFiles, init: Call = {}) =>
  hm<TapePreview>("/preview", { ...init, body: files });

export const loadTape = (files: TapeFiles, init: Call = {}) =>
  hm<TapeLoad>("/imports", { ...init, body: files });

/** Invitations go in batches: the door takes 5,000 and a mailer is slow. */
export const INVITE_BATCH = 500;

export const inviteToClaim = (
  body: { servicerSlug: string; invitations: { number: string; email: string | null }[] },
  init: Call = {},
) => hm<{ outcomes: InvitationOutcome[] }>("/claims", { ...init, body }).then((r) => r.outcomes);

/** The servicing app's own import of the same files, through its console API. */
export function loadIntoServicingBook(
  input: {
    readonly legalName: string;
    readonly nmlsrId: string;
    readonly asOf: string;
    readonly profile: string;
    readonly tape: File;
    readonly supplement: File | null;
  },
  role?: string,
): Promise<ServicingBookReceipt> {
  const form = new FormData();
  form.set("partner_legal_name", input.legalName);
  form.set("partner_nmlsr_id", input.nmlsrId);
  form.set("as_of_date", input.asOf);
  form.set("profile", input.profile);
  form.set("tape", input.tape, input.tape.name);
  if (input.supplement) form.set("supplement", input.supplement, input.supplement.name);
  return upload<ServicingBookReceipt>("/partner-book/imports", form, { role });
}

export const changeTone = (c: PreviewChange): "ok" | "info" | "neutral" =>
  c === "created" ? "ok" : c === "updated" ? "info" : "neutral";

export const changeWord = (c: PreviewChange): string =>
  c === "created" ? "New" : c === "updated" ? "Changed" : "Unchanged";
