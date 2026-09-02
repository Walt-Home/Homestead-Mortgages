import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Assessment } from "../lib/api.js";
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

  const items = (data?.outstanding ?? []).filter(
    (o) => o.actor === "borrower" && o.applicabilityKnown && o.screen === "upload_fallback",
  );

  const signable = (data?.outstanding ?? []).filter(
    (o) => o.actor === "borrower" && o.applicabilityKnown && o.source === "esign",
  );

  if (error) {
    return (
      <div className="card">
        <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
          We couldn&rsquo;t check what&rsquo;s left
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Something went wrong loading your outstanding items, so we can&rsquo;t tell you whether
          anything is needed. Reload to try again.
        </p>
        <button className="btn-secondary mt-6" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
        {isLoading
          ? "Checking what's left…"
          : items.length === 0 && signable.length === 0
            ? "Nothing left to send"
            : "A few things we could not retrieve"}
      </h1>

      {!isLoading && items.length === 0 && signable.length === 0 && (
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Your connections covered everything. There is nothing to upload.
        </p>
      )}

      {signable.length > 0 && (
        <div className="mt-6 space-y-4">
          <p className="text-[14px] text-muted">These two need your signature.</p>
          {signable.map((item) => (
            <div
              key={item.id}
              className="rounded-row border border-line-light bg-raised px-4 py-3.5"
            >
              <p className="text-[15px] text-ink-editorial">{item.statement}</p>
              <p className="mt-1 text-[13px] text-muted">{item.missing}</p>
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
          <p className="mt-6 text-[14px] text-muted">
            Your connections covered the rest. These {items.length} have to come from you.
          </p>
          <ul className="mt-4 space-y-4">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-row border border-line-light bg-raised px-4 py-3.5"
              >
                <p className="text-[15px] text-ink-editorial">{item.statement}</p>
                <p className="mt-1 text-[13px] text-muted">{item.missing}</p>
                <p className="mt-1 text-[12px] text-subtle">
                  Why we need it: {item.appliesBecause}
                </p>
                {!readOnly && <AttachControl fileId={fileId} requirementId={item.id} />}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-8 flex items-center gap-3">
        <button className="btn-primary" onClick={() => navigate(`/f/${fileId}/review`)}>
          See where I stand
        </button>
        <button className="btn-secondary" onClick={() => navigate(`/f/${fileId}/review`)}>
          Back
        </button>
      </div>

      {(items.length > 0 || signable.length > 0) && (
        <p className="mt-5 text-[12px] leading-relaxed text-subtle">
          Documents you attach never leave your device — we record the name and size so the file
          knows the evidence exists, and nothing more.
        </p>
      )}

      <button
        className="mt-4 block text-[12px] text-subtle underline-offset-2 hover:underline"
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
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
      await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "That didn't attach."),
  });

  if (attached) {
    return (
      <p className="mt-3 text-[13px] text-olive">
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
        className="btn-secondary text-[13px]"
        onClick={() => inputRef.current?.click()}
        disabled={attach.isPending}
      >
        {attach.isPending ? "Attaching…" : "Attach a document"}
      </button>
      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}
    </div>
  );
}
