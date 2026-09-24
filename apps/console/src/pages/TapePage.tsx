/**
 * The tape desk: one job, on its own, without the console around it.
 *
 * A servicer's monthly book arrives as a tape and a supplement. The desk
 * walks it through four steps and shows a receipt at each: the files, a
 * review of what loading them would do — read by our own reader, nothing
 * written — the load itself into the servicing app's book and then into the
 * loans database, and the invitations that turn the people on the tape into
 * borrowers who can claim their mortgage. Recapture starts with the claim,
 * and the claim starts here.
 *
 * Nothing on this page is the servicing app's word alone: the review and
 * the loans-database receipt come from our API, gated by the same console
 * session the servicing app holds.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../components/Icon.js";
import { Wordmark } from "../components/Shell.js";
import { Table, type Column } from "../components/Table.js";
import {
  Button,
  Field,
  Input,
  Notice,
  Pill,
  Rows,
  Select,
  Stat,
  type Tone,
} from "../components/ui.js";
import { ApiError, api } from "../lib/api.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { fmtDate, fmtDateTime, money, pct, plural, words } from "../lib/format.js";
import {
  changeTone,
  changeWord,
  deskImports,
  deskServicers,
  fileToWire,
  INVITE_BATCH,
  inviteToClaim,
  loadIntoServicingBook,
  loadTape,
  previewTape,
  slugify,
  todayEt,
  type InvitationOutcome,
  type PreviewRow,
  type ServicingBookReceipt,
  type TapeFiles,
  type TapeLoad,
  type TapePreview,
  analyzeBook,
  VERDICT_RANK,
  verdictWord,
  verdictTone,
  type BookAnalysis,
  type Verdict,
} from "../lib/tape.js";

type Step = "files" | "review" | "load" | "invite";
const STEPS: readonly { key: Step; label: string }[] = [
  { key: "files", label: "Files" },
  { key: "review", label: "Review" },
  { key: "load", label: "Load" },
  { key: "invite", label: "Invite" },
];

const NEW = "__new__";

const PAGE = 100;

/**
 * A table that shows a page at a time and finds a row by what is written on
 * it. A real book is fourteen thousand rows; nobody reads that as one table.
 */
function PagedTable<Row>({
  columns,
  rows,
  rowKey,
  searchable,
  noun,
}: {
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (r: Row) => string;
  searchable?: (r: Row) => readonly (string | null | undefined)[];
  noun: string;
}) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const needle = q.trim().toLowerCase();
  const matching = useMemo(
    () =>
      needle && searchable
        ? rows.filter((r) => searchable(r).some((v) => v?.toLowerCase().includes(needle)))
        : rows,
    [rows, needle, searchable],
  );
  const visible = matching.slice(0, shown);
  const paged = rows.length > PAGE;
  return (
    <div className="space-y-3">
      {paged && searchable ? (
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(PAGE);
          }}
          placeholder={`Find a ${noun} by number, name or place`}
          aria-label={`Find a ${noun}`}
          className="max-w-md"
        />
      ) : null}
      <Table columns={columns} rows={visible} rowKey={rowKey} dense />
      {paged ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
          <span>
            Showing {visible.length.toLocaleString()} of {plural(matching.length, noun)}
            {needle ? " that match" : ""}
          </span>
          {matching.length > shown ? (
            <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, matching.length - shown).toLocaleString()} more
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The gaps `@hm/partner-book` counts, by the words an ops analyst reads. */
const GAP_LABELS: Record<string, string> = {
  dob: "Date of birth",
  mailing_address: "Mailing address",
  coborrower: "Co-borrower",
};

export function TapePage() {
  const { me, role } = useAuth();
  const navigate = useNavigate();
  const queries = useQueryClient();

  const servicers = useQuery({ queryKey: ["desk-servicers"], queryFn: () => deskServicers() });
  const partners = useQuery({
    queryKey: ["partners", role],
    queryFn: () =>
      api<{ partners: { partner_party_id: string; legal_name: string }[] }>(
        "/partner-book/partners",
      ).then((r) => r.partners),
  });

  const [step, setStep] = useState<Step>("files");
  const [choice, setChoice] = useState<string>("");
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [nmlsr, setNmlsr] = useState("");
  const [asOf, setAsOf] = useState(todayEt());
  const [tape, setTape] = useState<File | null>(null);
  const [supplement, setSupplement] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TapePreview | null>(null);
  /** Today's verdicts by loan number, from the load step's first look. */
  const [verdicts, setVerdicts] = useState<Record<string, Verdict> | null>(null);
  const [wire, setWire] = useState<TapeFiles | null>(null);

  // One servicer to begin with picks itself; a new one is typed.
  useEffect(() => {
    if (choice || !servicers.data) return;
    if (servicers.data.length === 1) setChoice(servicers.data[0]!.slug);
    else if (servicers.data.length === 0) setChoice(NEW);
  }, [servicers.data, choice]);
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(displayName));
  }, [displayName, slugTouched]);

  const chosen = servicers.data?.find((s) => s.slug === choice) ?? null;
  const servicer = chosen
    ? { slug: chosen.slug, displayName: chosen.displayName }
    : choice === NEW
      ? { slug, displayName: displayName.trim() }
      : null;
  const history = useQuery({
    queryKey: ["desk-imports", servicer?.slug],
    queryFn: () => deskImports(servicer!.slug),
    enabled: !!chosen,
  });

  const filesReady =
    !!tape &&
    !!servicer &&
    servicer.displayName !== "" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(servicer.slug) &&
    /^\d{4}-\d{2}-\d{2}$/.test(asOf);

  async function review() {
    if (!tape || !servicer) return;
    setBusy(true);
    setError(null);
    try {
      const files: TapeFiles = {
        servicer,
        profile: "m3-v1",
        asOf,
        tape: await fileToWire(tape),
        ...(supplement ? { supplement: await fileToWire(supplement) } : {}),
      };
      const p = await previewTape(files);
      // The tape's own as-of when it carries one; the load carries the same.
      setWire({ ...files, asOf: p.asOf });
      setPreview(p);
      if (p.asOf !== asOf) setAsOf(p.asOf);
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setStep("files");
    setPreview(null);
    setVerdicts(null);
    setWire(null);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Wordmark />
            <span className="text-sm text-fg-3">/</span>
            <span className="text-sm font-medium text-fg">Tape desk</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-fg-2">
            {me?.legal_name ? <span className="hidden sm:inline">{me.legal_name}</span> : null}
            <Button
              size="sm"
              variant="ghost"
              icon="arrow-left"
              onClick={() => navigate("/partner-book")}
            >
              Back to the console
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Steps current={step} />

        {step === "files" && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="space-y-5">
              <h1 className="text-2xl font-semibold tracking-tight text-fg">
                Load a servicer's tape
              </h1>
              <p className="max-w-prose text-base text-fg-2">
                The monthly book on the m3-v1 profile, and the supplement beside it when there is
                one. Nothing is written until you have seen what the tape would do.
              </p>

              <Field label="Servicer" htmlFor="desk-servicer" hint="Whose book this is.">
                <Select
                  id="desk-servicer"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a servicer
                  </option>
                  {(servicers.data ?? []).map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.displayName}
                    </option>
                  ))}
                  <option value={NEW}>A servicer not listed yet…</option>
                </Select>
              </Field>

              {choice === NEW && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Legal name" htmlFor="desk-name" hint="As it appears on the tape.">
                    <Input
                      id="desk-name"
                      list="desk-partner-names"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Grander Mortgage Servicing"
                    />
                    <datalist id="desk-partner-names">
                      {(partners.data ?? []).map((p) => (
                        <option key={p.partner_party_id} value={p.legal_name} />
                      ))}
                    </datalist>
                  </Field>
                  <Field
                    label="Short name"
                    htmlFor="desk-slug"
                    hint="Lowercase, hyphens; the key every row of theirs carries."
                  >
                    <Input
                      id="desk-slug"
                      value={slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setSlug(e.target.value);
                      }}
                      className="font-mono"
                    />
                  </Field>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="NMLSR id"
                  htmlFor="desk-nmlsr"
                  hint="For the servicing app's copy of the book. Leave blank to skip that copy."
                >
                  <Input
                    id="desk-nmlsr"
                    inputMode="numeric"
                    value={nmlsr}
                    onChange={(e) => setNmlsr(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="As of"
                  htmlFor="desk-asof"
                  hint="The date the tape's figures are as of."
                >
                  <Input
                    id="desk-asof"
                    type="date"
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value)}
                  />
                </Field>
              </div>

              <Drop
                id="desk-tape"
                label="Tape"
                hint="The .xlsx or .csv on the m3-v1 profile."
                accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                file={tape}
                onFile={setTape}
              />
              <Drop
                id="desk-supplement"
                label="Supplement"
                hint="The .csv beside it: loan number, e-mail, name, date of birth. Optional; it is what the invitations are sent to."
                accept=".csv,text/csv"
                file={supplement}
                onFile={setSupplement}
              />

              {error ? <Notice tone="danger">{error}</Notice> : null}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!filesReady}
                  onClick={() => void review()}
                >
                  Review the tape
                </Button>
                <span className="text-sm text-fg-3">Reads the files; writes nothing.</span>
              </div>
            </section>

            <aside className="space-y-4">
              <div className="rounded-lg border border-line bg-surface p-4">
                <div className="mb-2 text-sm font-medium text-fg">
                  {chosen ? `The book we hold for ${chosen.displayName}` : "The book"}
                </div>
                {chosen ? (
                  <Rows
                    rows={[
                      { label: "Tapes loaded", value: chosen.book.imports.toLocaleString() },
                      ...(chosen.book.analysis
                        ? [
                            {
                              label: `Candidates as of ${fmtDate(chosen.book.analysis.asOf)}`,
                              value: chosen.book.analysis.verdicts.candidate.toLocaleString(),
                            },
                          ]
                        : []),
                      {
                        label: "Latest as of",
                        value: chosen.book.lastAsOf ? fmtDate(chosen.book.lastAsOf) : "—",
                      },
                      { label: "Loans", value: chosen.book.loans.total.toLocaleString() },
                      {
                        label: "Unclaimed",
                        value: (chosen.book.loans.byState.imported_unclaimed ?? 0).toLocaleString(),
                      },
                      {
                        label: "Watched",
                        value: (chosen.book.loans.byState.monitoring_only ?? 0).toLocaleString(),
                      },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-fg-2">
                    Choose a servicer to see where their book stands.
                  </p>
                )}
              </div>
              {chosen && (history.data?.length ?? 0) > 0 ? (
                <div className="rounded-lg border border-line bg-surface p-4">
                  <div className="mb-2 text-sm font-medium text-fg">Earlier tapes</div>
                  <ul className="divide-y divide-line-2 text-sm">
                    {history.data!.slice(0, 8).map((i) => (
                      <li key={i.id} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="text-fg">as of {fmtDate(i.asOf)}</span>
                        <span className="text-fg-3">
                          {i.rowsLoaded.toLocaleString()} rows · {fmtDateTime(i.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </aside>
          </div>
        )}

        {step === "review" && preview && wire && (
          <ReviewStep
            preview={preview}
            supplementGiven={!!supplement}
            onBack={startOver}
            onLoad={() => setStep("load")}
          />
        )}

        {step === "load" && preview && wire && tape && (
          <LoadStep
            wire={wire}
            preview={preview}
            book={{
              legalName: preview.servicer.displayName,
              nmlsrId: nmlsr.trim(),
              asOf,
              tape,
              supplement,
            }}
            onDone={(v) => {
              setVerdicts(v);
              for (const key of [
                ["desk-servicers"],
                ["desk-imports"],
                ["partners"],
                ["book-imports"],
                ["book-loans"],
                ["loans"],
                ["home"],
              ])
                void queries.invalidateQueries({ queryKey: key });
              setStep("invite");
            }}
            onBack={() => setStep("review")}
          />
        )}

        {step === "invite" && preview && (
          <InviteStep
            preview={preview}
            verdicts={verdicts}
            onDone={() => navigate("/partner-book")}
            onAnother={() => {
              setTape(null);
              setSupplement(null);
              startOver();
            }}
          />
        )}
      </main>
    </div>
  );
}

/* ── the stepper ──────────────────────────────────────────────────────────── */

function Steps({ current }: { current: Step }) {
  const at = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
      {STEPS.map((s, i) => {
        const done = i < at;
        const here = i === at;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={
                "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium " +
                (here
                  ? "bg-accent text-accent-fg"
                  : done
                    ? "bg-ok-soft text-ok"
                    : "border border-line-2 text-fg-3")
              }
            >
              {done ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className={here ? "font-medium text-fg" : "text-fg-3"}>{s.label}</span>
            {i < STEPS.length - 1 ? <span className="mx-1 text-fg-3">›</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ── a file, dropped or picked ─────────────────────────────────────────────── */

function Drop({
  id,
  label,
  hint,
  accept,
  file,
  onFile,
}: {
  id: string;
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") input.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={take}
        className={
          "flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-4 transition-colors " +
          (over ? "border-accent bg-accent-soft" : "border-line-2 bg-surface hover:border-line-3")
        }
      >
        {file ? (
          <div className="min-w-0">
            <div className="truncate font-medium text-fg">{file.name}</div>
            <div className="text-sm text-fg-3">{(file.size / 1024).toFixed(0)} KB</div>
          </div>
        ) : (
          <div className="text-fg-2">Drop the file here, or choose it.</div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {file ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onFile(null);
                if (input.current) input.current.value = "";
              }}
            >
              Remove
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              input.current?.click();
            }}
          >
            Choose
          </Button>
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </div>
    </Field>
  );
}

/* ── review ────────────────────────────────────────────────────────────────── */

function ReviewStep({
  preview,
  supplementGiven,
  onBack,
  onLoad,
}: {
  preview: TapePreview;
  supplementGiven: boolean;
  onBack: () => void;
  onLoad: () => void;
}) {
  const rows = preview.rows;
  const columns = useMemo<Column<PreviewRow>[]>(
    () => [
      {
        key: "row",
        header: "Row",
        render: (r) => r.row,
        width: "w-14",
        mono: true,
        hideOnCard: true,
      },
      { key: "number", header: "Loan", render: (r) => r.number, mono: true, primary: true },
      { key: "borrower", header: "Borrower", render: (r) => r.borrower ?? "—" },
      { key: "property", header: "Property", render: (r) => r.property ?? "—" },
      {
        key: "refi",
        header: "Refi",
        render: (r) =>
          r.review ? (
            <Pill tone={verdictTone(r.review.verdict)}>{verdictWord(r.review.verdict)}</Pill>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      { key: "balance", header: "Balance", render: (r) => money(r.balanceCents), align: "right" },
      { key: "rate", header: "Rate", render: (r) => pct(r.ratePct), align: "right" },
      {
        key: "standing",
        header: "Standing",
        render: (r) => (r.standing ? words(r.standing) : "—"),
      },
      {
        key: "change",
        header: "Change",
        render: (r) => <Pill tone={changeTone(r.change)}>{changeWord(r.change)}</Pill>,
      },
      {
        key: "claim",
        header: "Claim",
        render: (r) =>
          r.claimed ? (
            <Pill tone="ok">Claimed</Pill>
          ) : r.loanState ? (
            <Pill tone="neutral">Unclaimed</Pill>
          ) : (
            <Pill tone="neutral">Not yet ours</Pill>
          ),
      },
      {
        key: "email",
        header: "Address",
        render: (r) =>
          r.email ? (
            <span className="font-mono text-sm">{r.email}</span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
    ],
    [],
  );
  const exceptionColumns = useMemo<Column<{ row: number; code: string; detail: string }>[]>(
    () => [
      { key: "row", header: "Row", render: (e) => e.row, width: "w-14", mono: true },
      { key: "code", header: "What", render: (e) => words(e.code), primary: true },
      { key: "detail", header: "Detail", render: (e) => e.detail || "—" },
    ],
    [],
  );
  const summaryColumns = useMemo<
    Column<{ key: string; code: string; column: string | null; rows: number }>[]
  >(
    () => [
      { key: "code", header: "What", render: (e) => words(e.code), primary: true },
      { key: "column", header: "Column", render: (e) => e.column ?? "—", mono: true },
      {
        key: "rows",
        header: "Rows",
        render: (e) => e.rows.toLocaleString(),
        align: "right",
        width: "w-24",
      },
    ],
    [],
  );
  const exceptions = preview.exceptions.map((e, i) => ({
    key: `${e.row}-${e.code}-${i}`,
    row: e.row,
    code: e.code,
    detail: String(e.detail ?? e.column ?? e.message ?? ""),
  }));
  const gaps = Object.entries(preview.gaps).filter(([, n]) => n > 0);

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">What this tape would do</h1>
          <p className="mt-1 text-sm text-fg-2">
            {preview.servicer.displayName} · as of {fmtDate(preview.asOf)} · {preview.profile}
            {preview.servicer.exists ? "" : " · a servicer we have not held a book for yet"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            Change the files
          </Button>
          <Button variant="primary" disabled={preview.rejected} onClick={onLoad}>
            {preview.alreadyLoaded ? "Load it anyway" : "Load the tape"}
          </Button>
        </div>
      </div>

      {preview.rejected ? (
        <Notice tone="danger" title="This tape is missing headers the profile requires">
          {preview.headers.missing.join(", ")}. Nothing on it can be read until they are there; the
          profile expects {preview.headers.required} required columns.
        </Notice>
      ) : preview.alreadyLoaded ? (
        <Notice tone="warn" title="These exact files were loaded before">
          On {fmtDateTime(preview.alreadyLoaded.loadedAt)}. Loading again writes nothing new to the
          loans database; the servicing app's copy answers for itself.
        </Notice>
      ) : (
        <Notice tone="ok" title={`The tape matches the ${preview.profile} profile`}>
          All {preview.headers.required} required columns are present.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Rows on the tape" value={preview.rowsTotal.toLocaleString()} />
        <Stat
          label="New loans"
          value={preview.counts.created.toLocaleString()}
          tone={preview.counts.created ? "ok" : undefined}
        />
        <Stat
          label="Changed"
          value={preview.counts.updated.toLocaleString()}
          tone={preview.counts.updated ? "info" : undefined}
        />
        <Stat label="Unchanged" value={preview.counts.unchanged.toLocaleString()} />
        <Stat
          label="Refused"
          value={preview.rowsRefused.toLocaleString()}
          tone={preview.rowsRefused ? "danger" : undefined}
        />
        <Stat
          label="With an address"
          value={preview.supplement ? preview.supplement.withEmail.toLocaleString() : "—"}
          hint={supplementGiven ? undefined : "No supplement"}
        />
      </div>

      {!preview.rejected ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">The loans, row by row</h2>
          <PagedTable
            columns={columns}
            rows={rows}
            rowKey={(r) => `${r.row}-${r.number}`}
            searchable={(r) => [r.number, r.borrower, r.property, r.email]}
            noun="loan"
          />
        </section>
      ) : null}

      {preview.exceptionsTotal ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-fg">
            {plural(preview.exceptionsTotal, "row exception")}
          </h2>
          <p className="mb-3 max-w-prose text-sm text-fg-2">
            An exception names a cell the profile could not read, or a rule a row broke. A row with
            an unreadable cell still loads with that one fact blank; a refused row does not load at
            all, and is counted above.
          </p>
          <Table
            columns={summaryColumns}
            rows={preview.exceptionSummary.map((x, i) => ({
              ...x,
              key: `${x.code}-${x.column ?? ""}-${i}`,
            }))}
            rowKey={(e) => e.key}
            dense
          />
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-fg-2">
              Row by row
              {preview.exceptionsTotal > exceptions.length
                ? ` (the first ${exceptions.length.toLocaleString()})`
                : ""}
            </summary>
            <div className="mt-3">
              <PagedTable
                columns={exceptionColumns}
                rows={exceptions}
                rowKey={(e) => e.key}
                searchable={(e) => [String(e.row), e.code, e.detail]}
                noun="exception"
              />
            </div>
          </details>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {gaps.length ? (
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-2 text-sm font-medium text-fg">What the tape leaves out</div>
            <Rows
              rows={gaps.map(([k, n]) => ({
                label: GAP_LABELS[k] ?? words(k),
                value: `${n.toLocaleString()} ${plural(n, "loan")}`,
              }))}
            />
          </div>
        ) : null}
        {preview.supplement ? (
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-2 text-sm font-medium text-fg">The supplement</div>
            <Rows
              rows={[
                { label: "Rows", value: preview.supplement.rows.toLocaleString() },
                { label: "Matched to a loan", value: preview.supplement.matched.toLocaleString() },
                { label: "With an e-mail", value: preview.supplement.withEmail.toLocaleString() },
                ...(preview.supplement.ignoredColumns.length
                  ? [
                      {
                        label: "Not written to the book",
                        value: preview.supplement.ignoredColumns.join(", "),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── load ──────────────────────────────────────────────────────────────────── */

type Phase<T> =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; value: T }
  | { state: "failed"; error: ApiError }
  | { state: "skipped"; why: string };

function LoadStep({
  wire,
  preview,
  book,
  onDone,
  onBack,
}: {
  wire: TapeFiles;
  preview: TapePreview;
  book: { legalName: string; nmlsrId: string; asOf: string; tape: File; supplement: File | null };
  onDone: (verdicts: Record<string, Verdict> | null) => void;
  onBack: () => void;
}) {
  const [servicing, setServicing] = useState<Phase<ServicingBookReceipt>>({ state: "idle" });
  const [db, setDb] = useState<Phase<TapeLoad>>({ state: "idle" });
  const [analysis, setAnalysis] = useState<Phase<BookAnalysis>>({ state: "idle" });
  const started = useRef(false);

  async function analyze() {
    setAnalysis({ state: "running" });
    try {
      setAnalysis({ state: "done", value: await analyzeBook(preview.servicer.slug) });
    } catch (err) {
      setAnalysis({
        state: "failed",
        error: err instanceof ApiError ? err : new ApiError(0, String(err), null),
      });
    }
  }

  async function loadServicing(role?: string) {
    setServicing({ state: "running" });
    try {
      setServicing({
        state: "done",
        value: await loadIntoServicingBook({ ...book, profile: wire.profile }, role),
      });
      return true;
    } catch (err) {
      setServicing({
        state: "failed",
        error: err instanceof ApiError ? err : new ApiError(0, String(err), null),
      });
      return false;
    }
  }
  async function loadDb() {
    setDb({ state: "running" });
    try {
      const loaded = await loadTape(wire);
      setDb({ state: "done", value: loaded });
      // The first look follows the load: today's verdict on every unclaimed
      // loan of the book, so the invitations can go to the candidates first.
      if (loaded.result.status !== "rejected") await analyze();
    } catch (err) {
      setDb({
        state: "failed",
        error: err instanceof ApiError ? err : new ApiError(0, String(err), null),
      });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      if (book.nmlsrId) {
        const ok = await loadServicing();
        if (!ok) return;
      } else {
        setServicing({
          state: "skipped",
          why: "No NMLSR id was given, so the servicing app's copy was skipped.",
        });
      }
      await loadDb();
    })();
  }, []);

  const receipt = (r: ServicingBookReceipt) => [
    { label: "Rows loaded", value: `${r.rows_loaded ?? "—"} of ${r.rows_total ?? "—"}` },
    {
      label: "Loans created · updated · unchanged",
      value: `${r.loans_created ?? "—"} · ${r.loans_updated ?? "—"} · ${r.loans_unchanged ?? "—"}`,
    },
    { label: "Import id", value: r.import_id, mono: true },
  ];
  const dbDone = db.state === "done";
  const dbResult = dbDone ? db.value.result : null;

  return (
    <div className="mt-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Loading the tape</h1>
        <p className="mt-1 text-sm text-fg-2">
          {preview.servicer.displayName} · as of {fmtDate(preview.asOf)}
        </p>
      </div>

      <PhaseCard
        title="The servicing app's book"
        phase={servicing}
        renderDone={(r) => (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Pill
                tone={
                  r.status === "loaded" ? "ok" : r.status === "already_loaded" ? "warn" : "danger"
                }
              >
                {words(r.status)}
              </Pill>
              <span className="text-sm text-fg-2">
                {r.status === "already_loaded"
                  ? "This exact tape was loaded there before."
                  : r.status === "loaded"
                    ? "The book is on the servicing app."
                    : "Nothing was written there."}
              </span>
            </div>
            <Rows rows={receipt(r)} />
          </>
        )}
        renderFailed={(e) =>
          e.actAs.length ? (
            <div className="space-y-3">
              <Notice tone="warn" title={`Loading needs ${e.actAs.map(roleWord).join(" or ")}`}>
                You hold that role. Load it under it.
              </Notice>
              <div className="flex flex-wrap gap-2">
                {e.actAs.map((r) => (
                  <Button
                    key={r}
                    onClick={() =>
                      void loadServicing(r).then((ok) => {
                        if (ok) void loadDb();
                      })
                    }
                  >
                    Load it as {roleWord(r)}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setServicing({ state: "skipped", why: "Skipped by hand." });
                    void loadDb();
                  }}
                >
                  Skip this copy
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Notice tone="danger">
                {/loans_servicer_loan_number_key/.test(e.message)
                  ? "A loan number on this tape already belongs to another servicer's book in the servicing app, which holds loan numbers unique across servicers."
                  : e.message}
              </Notice>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    void loadServicing().then((ok) => {
                      if (ok) void loadDb();
                    })
                  }
                >
                  Try again
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setServicing({ state: "skipped", why: "Skipped after it failed." });
                    void loadDb();
                  }}
                >
                  Skip this copy and load the loans database
                </Button>
              </div>
            </div>
          )
        }
      />

      <PhaseCard
        title="The loans database"
        phase={db}
        renderDone={(v) => (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Pill
                tone={
                  v.result.status === "loaded"
                    ? "ok"
                    : v.result.status === "already_loaded"
                      ? "warn"
                      : "danger"
                }
              >
                {words(v.result.status)}
              </Pill>
              <span className="text-sm text-fg-2">
                {v.result.status === "loaded"
                  ? `${v.servicer.created ? "The servicer was added and the" : "The"} loans are ours to watch once claimed.`
                  : v.result.status === "already_loaded"
                    ? "These exact files were loaded before; nothing was written twice."
                    : "Nothing was written."}
              </span>
            </div>
            {v.result.status === "loaded" ? (
              <Rows
                rows={[
                  {
                    label: "Rows loaded",
                    value: `${v.result.counts.rows_loaded} of ${v.result.counts.rows_total}`,
                  },
                  {
                    label: "Loans created · updated · unchanged",
                    value: `${v.result.counts.loans_created} · ${v.result.counts.loans_updated} · ${v.result.counts.loans_unchanged}`,
                  },
                  {
                    label: "People created",
                    value: v.result.counts.parties_created.toLocaleString(),
                  },
                  { label: "Import id", value: v.result.importId, mono: true },
                ]}
              />
            ) : v.result.status === "rejected" ? (
              <Notice tone="danger">Missing: {v.result.missing_headers.join(", ")}</Notice>
            ) : null}
          </>
        )}
        renderFailed={(e) => (
          <div className="space-y-3">
            <Notice tone="danger">{e.message}</Notice>
            <Button onClick={() => void loadDb()}>Try again</Button>
          </div>
        )}
      />

      <PhaseCard
        title="The book's first look"
        phase={analysis}
        renderDone={(a) => (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Pill tone={a.counts.candidate ? "ok" : "neutral"}>
                {plural(a.counts.candidate, "refinance candidate")}
              </Pill>
              <span className="text-sm text-fg-2">
                {a.analyzed
                  ? `${plural(a.analyzed, "unclaimed loan")} analyzed against today's rate. The verdicts wait for the claim; nobody is contacted by this.`
                  : a.alreadyReviewed
                    ? "Every loan on the book was already looked at today."
                    : "Nothing on the book to look at."}
              </span>
            </div>
            <Rows
              rows={[
                {
                  label: "Candidates · watching · not now · excluded",
                  value: `${a.counts.candidate.toLocaleString()} · ${a.counts.watching.toLocaleString()} · ${a.counts.not_now.toLocaleString()} · ${a.counts.excluded.toLocaleString()}`,
                },
                {
                  label: "Analyzed now · already today · skipped",
                  value: `${a.analyzed.toLocaleString()} · ${a.alreadyReviewed.toLocaleString()} · ${a.skipped.toLocaleString()}`,
                },
                { label: "As of", value: fmtDate(a.asOf) },
              ]}
            />
          </>
        )}
        renderFailed={(e) => (
          <div className="space-y-3">
            <Notice tone="danger">{e.message}</Notice>
            <Button onClick={() => void analyze()}>Try again</Button>
          </div>
        )}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!dbDone || dbResult?.status === "rejected" || analysis.state === "running"}
          onClick={() => onDone(analysis.state === "done" ? analysis.value.verdicts : null)}
        >
          Invite the borrowers to claim
        </Button>
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={db.state === "running" || servicing.state === "running"}
        >
          Back
        </Button>
      </div>
    </div>
  );
}

function PhaseCard<T>({
  title,
  phase,
  renderDone,
  renderFailed,
}: {
  title: string;
  phase: Phase<T>;
  renderDone: (value: T) => ReactNode;
  renderFailed: (error: ApiError) => ReactNode;
}) {
  const tone: Tone =
    phase.state === "done"
      ? "ok"
      : phase.state === "failed"
        ? "danger"
        : phase.state === "skipped"
          ? "neutral"
          : "info";
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        <Pill tone={tone}>
          {phase.state === "idle"
            ? "Waiting"
            : phase.state === "running"
              ? "Loading…"
              : phase.state === "done"
                ? "Done"
                : phase.state === "failed"
                  ? "Failed"
                  : "Skipped"}
        </Pill>
      </div>
      {phase.state === "running" ? (
        <div className="flex items-center gap-2 text-sm text-fg-2">
          <Icon name="loader" size={16} className="animate-spin" /> Writing…
        </div>
      ) : phase.state === "done" ? (
        renderDone(phase.value)
      ) : phase.state === "failed" ? (
        renderFailed(phase.error)
      ) : phase.state === "skipped" ? (
        <p className="text-sm text-fg-2">{phase.why}</p>
      ) : (
        <p className="text-sm text-fg-3">Waits for the step above.</p>
      )}
    </section>
  );
}

/* ── invite ────────────────────────────────────────────────────────────────── */

function InviteStep({
  preview,
  onDone,
  onAnother,
  verdicts,
}: {
  preview: TapePreview;
  onDone: () => void;
  onAnother: () => void;
  /** Today's verdicts by loan number, from the load step; the preview's own stand in. */
  verdicts: Record<string, Verdict> | null;
}) {
  const verdictOf = useCallback(
    (r: PreviewRow): Verdict | null => verdicts?.[r.number] ?? r.review?.verdict ?? null,
    [verdicts],
  );
  // Unclaimed loans, the refinance candidates first: those are the ones
  // worth a servicer's invitation today.
  const candidates = useMemo(
    () =>
      preview.rows
        .filter((r) => !r.claimed)
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          const va = verdictOf(a.r);
          const vb = verdictOf(b.r);
          const ra = va ? VERDICT_RANK[va] : 9;
          const rb = vb ? VERDICT_RANK[vb] : 9;
          return ra - rb || a.i - b.i;
        })
        .map(({ r }) => r),
    [preview, verdictOf],
  );
  const refiCandidates = useMemo(
    () => candidates.filter((r) => verdictOf(r) === "candidate"),
    [candidates, verdictOf],
  );
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.filter((r) => r.email).map((r) => r.number)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<InvitationOutcome[] | null>(null);

  const toggle = (n: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const [progress, setProgress] = useState<{ sent: number; of: number } | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    const invitations = candidates
      .filter((r) => picked.has(r.number))
      .map((r) => ({ number: r.number, email: r.email }));
    const all: InvitationOutcome[] = [];
    setProgress({ sent: 0, of: invitations.length });
    try {
      // A batch at a time, so a big book shows its progress and a failure
      // keeps what was already answered.
      for (let i = 0; i < invitations.length; i += INVITE_BATCH) {
        const batch = invitations.slice(i, i + INVITE_BATCH);
        all.push(
          ...(await inviteToClaim({ servicerSlug: preview.servicer.slug, invitations: batch })),
        );
        setOutcomes([...all]);
        setProgress({
          sent: Math.min(i + INVITE_BATCH, invitations.length),
          of: invitations.length,
        });
      }
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)}${
          all.length
            ? ` The ${plural(all.length, "invitation")} already answered are listed below.`
            : ""
        }`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const columns = useMemo<Column<PreviewRow>[]>(
    () => [
      {
        key: "pick",
        header: "",
        width: "w-10",
        hideOnCard: true,
        render: (r) => (
          <input
            type="checkbox"
            aria-label={`Invite ${r.number}`}
            checked={picked.has(r.number)}
            onChange={() => toggle(r.number)}
            className="h-4 w-4 rounded-sm border-line-3"
          />
        ),
      },
      { key: "number", header: "Loan", render: (r) => r.number, mono: true, primary: true },
      { key: "borrower", header: "Borrower", render: (r) => r.borrower ?? "—" },
      { key: "property", header: "Property", render: (r) => r.property ?? "—" },
      {
        key: "refi",
        header: "Refi",
        render: (r) => {
          const v = verdictOf(r);
          return v ? (
            <Pill tone={verdictTone(v)}>{verdictWord(v)}</Pill>
          ) : (
            <span className="text-fg-3">—</span>
          );
        },
      },
      {
        key: "email",
        header: "Send to",
        render: (r) =>
          r.email ? (
            <span className="font-mono text-sm">{r.email}</span>
          ) : (
            <span className="text-fg-3">
              No address on the supplement; a link is minted to hand over.
            </span>
          ),
      },
    ],
    [picked, verdictOf],
  );

  const outcomeColumns = useMemo<Column<InvitationOutcome>[]>(
    () => [
      { key: "number", header: "Loan", render: (o) => o.number, mono: true, primary: true },
      {
        key: "status",
        header: "Result",
        render: (o) => (
          <Pill
            tone={o.status === "sent" ? "ok" : o.status === "not_claimable" ? "danger" : "warn"}
          >
            {o.status === "sent"
              ? "Sent"
              : o.status === "not_delivered"
                ? "Not delivered"
                : o.status === "no_address"
                  ? "No address"
                  : "Not claimable"}
          </Pill>
        ),
      },
      {
        key: "detail",
        header: "Detail",
        render: (o) =>
          o.status === "sent" ? (
            <span>
              to <span className="font-mono">{o.to}</span>, good until {fmtDate(o.expiresAt)}
            </span>
          ) : o.status === "not_delivered" ? (
            <span>
              <span className="font-mono">{o.to}</span>: {o.reason}
            </span>
          ) : o.status === "no_address" ? (
            <span>Good until {fmtDate(o.expiresAt)}</span>
          ) : (
            <span>{o.reason}</span>
          ),
      },
      {
        key: "link",
        header: "Link",
        render: (o) =>
          "link" in o ? <CopyLink link={o.link} /> : <span className="text-fg-3">—</span>,
      },
    ],
    [],
  );

  const sent = outcomes?.filter((o) => o.status === "sent").length ?? 0;

  return (
    <div className="mt-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Invite the borrowers to claim
        </h1>
        <p className="mt-1 max-w-prose text-sm text-fg-2">
          Each loan gets one link, good for thirty days, mailed to the address the supplement
          carried. Whoever takes it after signing in becomes the person on the loan, and the daily
          review turns on for it. A loan with no address gets a link you can deliver another way.
        </p>
      </div>

      {!outcomes && refiCandidates.length ? (
        <Notice
          tone="info"
          title={`${plural(refiCandidates.length, "refinance candidate")} on this tape`}
        >
          Today's analysis found them worth a look at today's rate. They are first in the list, and
          nothing has been said to anyone yet.
        </Notice>
      ) : null}

      {outcomes ? (
        <>
          {progress ? (
            <Notice tone="info" title="Sending">
              {progress.sent.toLocaleString()} of {plural(progress.of, "invitation")} answered so
              far; the rest are going out in batches of {INVITE_BATCH}.
            </Notice>
          ) : (
            <Notice tone={sent ? "ok" : "warn"} title={`${plural(sent, "invitation")} sent`}>
              {outcomes.length - sent
                ? `${(outcomes.length - sent).toLocaleString()} of ${outcomes.length.toLocaleString()} need a hand: a link to deliver, or a loan that could not be claimed.`
                : "Every loan you picked was invited."}
            </Notice>
          )}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <PagedTable
            columns={outcomeColumns}
            rows={outcomes}
            rowKey={(o) => o.number}
            searchable={(o) => [o.number, "to" in o ? o.to : null, o.status]}
            noun="invitation"
          />
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
            <Button variant="ghost" onClick={onAnother}>
              Load another tape
            </Button>
          </div>
        </>
      ) : candidates.length === 0 ? (
        <>
          <Notice tone="info" title="Nothing to invite">
            Every loan on this tape is already claimed.
          </Notice>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </>
      ) : (
        <>
          <PagedTable
            columns={columns}
            rows={candidates}
            rowKey={(r) => r.number}
            searchable={(r) => [r.number, r.borrower, r.property, r.email]}
            noun="loan"
          />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              loading={busy}
              disabled={picked.size === 0}
              onClick={() => void send()}
            >
              Send {plural(picked.size, "invitation")}
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                setPicked((s) =>
                  s.size === candidates.length
                    ? new Set()
                    : new Set(candidates.map((r) => r.number)),
                )
              }
            >
              {picked.size === candidates.length ? "Pick none" : "Pick all"}
            </Button>
            {refiCandidates.length ? (
              <Button
                variant="ghost"
                onClick={() => setPicked(new Set(refiCandidates.map((r) => r.number)))}
              >
                Pick the {plural(refiCandidates.length, "candidate")}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onDone}>
              Skip for now
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="max-w-[16rem] truncate font-mono text-xs text-fg-2" title={link}>
        {link}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            window.prompt("Copy the link", link);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
