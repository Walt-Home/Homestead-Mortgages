/**
 * Loading a partner's tape (his 33.1): the file, its supplement, the
 * partner it belongs to and the date it is as of. The answer is the import's
 * report — what loaded, what changed, what was refused — shown in place, so
 * the person who loaded it sees what it did before they go anywhere.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet } from "../components/Sheet.js";
import { Button, Field, Input, Notice, Pill, Rows, type Tone } from "../components/ui.js";
import { ApiError, upload } from "../lib/api.js";
import { roleWord } from "../lib/auth.js";
import { fmtDate, words } from "../lib/format.js";

interface Partner {
  partner_party_id: string;
  legal_name: string;
}

export interface ImportReport {
  import_id: string;
  status: "loaded" | "rejected" | "already_loaded" | string;
  partner_party_id?: string;
  rows_total?: number;
  rows_loaded?: number;
  rows_exception?: number;
  loans_created?: number;
  loans_updated?: number;
  loans_unchanged?: number;
  parties_created?: number;
  parties_linked?: number;
  invitations_sent?: number;
  invitations_held?: number;
  on_hold?: number;
  exceptions_by_code?: Record<string, number>;
  missing_headers?: string[];
  report?: Record<string, unknown>;
  [k: string]: unknown;
}

const statusTone = (s: string): Tone =>
  s === "loaded" ? "ok" : s === "rejected" ? "danger" : s === "already_loaded" ? "warn" : "neutral";

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function UploadTapeSheet({
  partners,
  onClose,
}: {
  partners: Partner[];
  onClose: () => void;
}) {
  const queries = useQueryClient();
  const [legalName, setLegalName] = useState(partners.length === 1 ? partners[0]!.legal_name : "");
  const [nmlsr, setNmlsr] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [servicerNumber, setServicerNumber] = useState("");
  const [mersOrgId, setMersOrgId] = useState("");
  const [tape, setTape] = useState<File | null>(null);
  const [supplement, setSupplement] = useState<File | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const ready =
    !!tape && legalName.trim() !== "" && nmlsr.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(asOf);

  const send = async (role?: string) => {
    if (!tape) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("partner_legal_name", legalName.trim());
    form.set("partner_nmlsr_id", nmlsr.trim());
    form.set("as_of_date", asOf);
    form.set("profile", "m3-v1");
    if (servicerNumber.trim()) form.set("partner_servicer_number", servicerNumber.trim());
    if (mersOrgId.trim()) form.set("partner_mers_org_id", mersOrgId.trim());
    form.set("tape", tape, tape.name);
    if (supplement) form.set("supplement", supplement, supplement.name);
    try {
      const rep = await upload<ImportReport>("/partner-book/imports", form, { role });
      setReport(rep);
      for (const key of [
        ["partners"],
        ["book-imports"],
        ["book-loans"],
        ["book-day"],
        ["loans"],
        ["home"],
      ])
        void queries.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, String(err), null));
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    if (!report) return [];
    const has = (v: unknown): v is number => typeof v === "number";
    const n = (v: unknown) => (has(v) ? v.toLocaleString() : "—");
    const rows: { label: string; value: string; mono?: boolean }[] = [
      { label: "Rows on the tape", value: n(report.rows_total) },
      { label: "Rows loaded", value: n(report.rows_loaded) },
      { label: "Rows refused", value: n(report.rows_exception) },
      {
        label: "Loans created · updated",
        value: `${n(report.loans_created)} · ${n(report.loans_updated)}`,
      },
      {
        label: "People created · linked",
        value: `${n(report.parties_created)} · ${n(report.parties_linked)}`,
      },
    ];
    if (has(report.invitations_sent))
      rows.push({ label: "Invitations sent", value: n(report.invitations_sent) });
    if (has(report.on_hold)) rows.push({ label: "On hold", value: n(report.on_hold) });
    const supplement = (
      report.report as
        { supplement?: { rows?: number; matched?: number; orphans?: number } } | undefined
    )?.supplement;
    if (supplement && has(supplement.rows))
      rows.push({
        label: "Supplement rows · matched · orphans",
        value: `${n(supplement.rows)} · ${n(supplement.matched)} · ${n(supplement.orphans)}`,
      });
    rows.push({ label: "Import id", value: report.import_id, mono: true });
    return rows;
  }, [report]);
  const gaps = useMemo(() => {
    const g = (report?.report as { gaps?: Record<string, number> } | undefined)?.gaps;
    return g
      ? Object.entries(g)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
      : [];
  }, [report]);

  return (
    <Sheet
      open
      onClose={onClose}
      title={report ? "Tape loaded" : "Load a tape"}
      subtitle={
        report
          ? `${legalName} · as of ${fmtDate(asOf)}`
          : "A servicer's monthly book, on the m3-v1 profile."
      }
      footer={
        report ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : error?.actAs.length ? (
          error.actAs.map((r) => (
            <Button key={r} loading={busy} onClick={() => void send(r)}>
              Load it as {roleWord(r)}
            </Button>
          ))
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void send()}>
              Load the tape
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Pill tone={statusTone(report.status)}>{words(report.status)}</Pill>
            <span className="text-sm text-fg-2">
              {report.status === "already_loaded" &&
                "This exact tape was loaded before; nothing was written twice."}
              {report.status === "rejected" && "Nothing was written."}
              {report.status === "loaded" && "The book is on the platform."}
            </span>
          </div>
          {report.missing_headers?.length ? (
            <Notice tone="danger" title="The tape is missing headers the profile requires">
              {report.missing_headers.join(", ")}
            </Notice>
          ) : null}
          <Rows rows={counts} />
          {gaps.length ? (
            <div>
              <div className="mb-2 text-sm font-medium text-fg">
                What the tape leaves out, by loan count
              </div>
              <Rows rows={gaps.map(([k, v]) => ({ label: words(k), value: v.toLocaleString() }))} />
            </div>
          ) : null}
          {report.exceptions_by_code && Object.keys(report.exceptions_by_code).length ? (
            <div>
              <div className="mb-2 text-sm font-medium text-fg">Rows refused, by reason</div>
              <Rows
                rows={Object.entries(report.exceptions_by_code)
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, n]) => ({ label: words(code), value: n.toLocaleString() }))}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <Field
            label="Partner"
            htmlFor="tape-partner"
            hint="The servicer whose book this is, as its legal name."
          >
            <Input
              id="tape-partner"
              list="tape-partners"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Northlight Mortgage Servicing"
            />
            <datalist id="tape-partners">
              {partners.map((p) => (
                <option key={p.partner_party_id} value={p.legal_name} />
              ))}
            </datalist>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="NMLSR id" htmlFor="tape-nmlsr">
              <Input
                id="tape-nmlsr"
                inputMode="numeric"
                value={nmlsr}
                onChange={(e) => setNmlsr(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="As of" htmlFor="tape-asof" hint="The date the tape's figures are as of.">
              <Input
                id="tape-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Tape" htmlFor="tape-file" hint="The .xlsx on the m3-v1 profile.">
            <input
              id="tape-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setTape(e.target.files?.[0] ?? null)}
              className="block w-full text-base text-fg file:mr-3 file:rounded-full file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg hover:file:bg-surface-2"
            />
          </Field>
          <Field
            label="Supplement"
            htmlFor="tape-supplement"
            hint="The .csv beside it, when there is one."
          >
            <input
              id="tape-supplement"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setSupplement(e.target.files?.[0] ?? null)}
              className="block w-full text-base text-fg file:mr-3 file:rounded-full file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg hover:file:bg-surface-2"
            />
          </Field>
          <button
            type="button"
            className="text-sm text-fg-2 hover:text-fg"
            onClick={() => setMore((m) => !m)}
          >
            {more ? "Fewer fields" : "Servicer number and MERS org id…"}
          </button>
          {more ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Servicer number" htmlFor="tape-servicer">
                <Input
                  id="tape-servicer"
                  value={servicerNumber}
                  onChange={(e) => setServicerNumber(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="MERS org id" htmlFor="tape-mers">
                <Input
                  id="tape-mers"
                  value={mersOrgId}
                  onChange={(e) => setMersOrgId(e.target.value)}
                  className="font-mono"
                />
              </Field>
            </div>
          ) : null}
          {error ? (
            error.actAs.length ? (
              <Notice
                tone="warn"
                title={`Loading a tape needs ${error.actAs.map(roleWord).join(" or ")}`}
              >
                You hold that role. Send it again under it.
              </Notice>
            ) : (
              <Notice tone="danger">
                {/loans_servicer_loan_number_key/.test(error.message)
                  ? "A loan number on this tape already belongs to another partner's book. The platform holds loan numbers unique across partners, so the tape has to come in under the partner that holds them."
                  : error.message}
              </Notice>
            )
          ) : null}
          <Notice tone="neutral">
            The same two files load once: a tape already loaded answers as such and writes nothing.
            A tape missing a required header is refused whole.
          </Notice>
        </div>
      )}
    </Sheet>
  );
}
