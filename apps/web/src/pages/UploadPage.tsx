import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { branchCanSatisfy } from "@hm/shared";
import { api, ApiError, type Assessment, type OutstandingItem } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";
import { SignDocument } from "../components/SignDocument.js";

/**
 * NOTE, and a known rough edge of the four-screen rebuild.
 *
 * The items on this branch render `statement` and `appliesBecause` straight
 * from the requirements registry, which is the sheet's own wording — so
 * phrases like "4506-C executed" still reach a borrower here. Everywhere else
 * in the flow the internal vocabulary is gone; this is the one surface where
 * it survives, because the alternative is hand-writing borrower-facing copy
 * for all 77 requirements and a half-done map reads worse than a consistent
 * one. Worth doing before this is shown to anybody real.
 */

/**
 * What this screen can actually do something about.
 *
 * The narrowing is `branchCanSatisfy`, the same predicate `branchesFor` uses
 * to decide whether to offer the documents card at all and the API uses to
 * decide whether the file is waiting on a person. Stated once, in
 * `@hm/shared`, because the three have to agree: listing every item the
 * borrower owns on this screen offers an upload against a finding no upload
 * moves — a recent credit inquiry, a bankruptcy the engine seasons from its
 * own derivation — so somebody attaches a document and nothing changes.
 */
export function attachable(
  outstanding: readonly OutstandingItem[],
  payrollLinked: boolean,
): OutstandingItem[] {
  return outstanding.filter(
    (o) =>
      o.actor === "borrower" &&
      o.applicabilityKnown &&
      o.screen === "upload_fallback" &&
      branchCanSatisfy({ requirementId: o.id, source: o.source }, payrollLinked),
  );
}

/**
 * Screen 7. Drew's note: "Only what didn't connect. Should feel like an
 * exception, not a step."
 *
 * Two things this must get right. It renders nothing when nothing is
 * outstanding — the empty state is the intended state. And it must never claim
 * the borrower is finished because a fetch failed: "Nothing left to send" on a
 * network error is the most confidently wrong sentence in the product.
 *
 * **No file content is transmitted.** Picking a file sends its name, type and
 * size; the bytes stay on the machine. See apps/api/src/routes/documents.ts.
 */
export function UploadPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: fileData } = useLoanFile(fileId);
  const readOnly = fileData?.file.isDemo === true;

  // Same cache key as the shell, so the rail and this page cannot disagree
  // about what is outstanding.
  const { data, error, isLoading } = useQuery({
    queryKey: ["assessment", fileId, "upload"],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    enabled: Boolean(fileId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  const items = attachable(data?.outstanding ?? [], fileData?.file.payroll != null);

  const signable = (data?.outstanding ?? []).filter(
    (o) => o.actor === "borrower" && o.applicabilityKnown && o.source === "esign",
  );

  if (error) {
    return (
      <div className="super-card">
        <h1 className="font-display text-2xl text-ink">
          We couldn&rsquo;t check what&rsquo;s left
        </h1>
        <p className="mt-2 text-base text-ink-soft">
          Something went wrong loading your outstanding items, so we can&rsquo;t tell you whether
          anything is needed. Reload to try again.
        </p>
        <button className="super-btn super-btn-outline mt-6" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="super-card">
      <h1 className="font-display text-2xl text-ink">
        {isLoading
          ? "Checking what's left…"
          : items.length === 0 && signable.length === 0
            ? "Nothing left to send"
            : "A few things we could not retrieve"}
      </h1>

      {!isLoading && items.length === 0 && signable.length === 0 && (
        <p className="mt-2 text-base text-ink-soft">
          Your connections covered everything. There is nothing to upload.
        </p>
      )}

      {signable.length > 0 && (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-ink-muted">These two need your signature.</p>
          {signable.map((item) => (
            <div key={item.id} className="super-notice">
              <p className="text-base text-ink">{item.statement}</p>
              <p className="mt-1 text-sm text-ink-muted">{item.missing}</p>
              {!readOnly && (
                <div className="mt-3">
                  <SignDocument
                    fileId={fileId}
                    kind={
                      item.id === "INC-008"
                        ? "form_4506c"
                        : item.id === "APP-012"
                          ? "econsent"
                          : "verification_authorization"
                    }
                    label="Review and sign"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className="mt-6 text-sm text-ink-muted">
            Your connections covered the rest. These {items.length} have to come from you.
          </p>
          <ul className="mt-4 space-y-4">
            {items.map((item) => (
              <li key={item.id} className="super-notice">
                <p className="text-base text-ink">{item.statement}</p>
                <p className="mt-1 text-sm text-ink-muted">{item.missing}</p>
                <p className="mt-1 text-xs text-ink-faint">Why we need it: {item.appliesBecause}</p>
                {!readOnly && <AttachControl fileId={fileId} requirementId={item.id} />}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-8 flex items-center gap-3">
        <button
          className="super-btn super-btn-primary"
          onClick={() => navigate(`/f/${fileId}/review`)}
        >
          See where I stand
        </button>
        <button
          className="super-btn super-btn-outline"
          onClick={() => navigate(`/f/${fileId}/review`)}
        >
          Back
        </button>
      </div>

      {(items.length > 0 || signable.length > 0) && (
        <p className="mt-5 text-xs text-ink-faint">
          Documents you attach never leave your device — we record the name and size so the file
          knows the evidence exists, and nothing more.
        </p>
      )}

      <button
        className="super-link-quiet mt-4 block text-xs"
        onClick={() => void queryClient.invalidateQueries({ queryKey: ["assessment"] })}
      >
        Refresh what&rsquo;s outstanding
      </button>
    </div>
  );
}

function AttachControl({ fileId, requirementId }: { fileId: string; requirementId: string }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: (f: File) =>
      api.post(`/files/${fileId}/documents`, {
        satisfiesRequirementId: requirementId,
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        bytes: f.size,
      }),
    onSuccess: async (_r, f) => {
      setAttached(f.name);
      setError(null);
      // Ask the engine again with the document the borrower just attached.
      // The review screen renders whatever decision it finds, so without this
      // it shows the one computed before the upload existed.
      await api.post(`/files/${fileId}/decision`, {}).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "That didn't attach."),
  });

  if (attached) {
    return (
      <p className="mt-3 text-sm text-ok">
        {attached} attached — its contents stayed on your device.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attach.mutate(f);
        }}
      />
      <button
        className="super-btn super-btn-outline"
        onClick={() => inputRef.current?.click()}
        disabled={attach.isPending}
      >
        {attach.isPending ? "Attaching…" : "Attach a document"}
      </button>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
