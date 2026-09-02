import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useLoanFile } from "../lib/file.js";
import { readDraft } from "../lib/identity.js";

/**
 * Where the borrower lands after a hosted identity check.
 *
 * A fixture verifies in place; a real vendor sends the person to its own site
 * and returns them here on a fresh page load, with no component state and no
 * memory of the form they were filling in. Everything they typed was saved
 * before the redirect for exactly this reason — the redirect is the reason the
 * borrower row is written first rather than last.
 *
 * Three outcomes, and the middle one is the one that gets forgotten: verified,
 * still processing, or failed. Stripe reviews a document asynchronously, so
 * landing here before a result exists is normal and is not a failure. Saying
 * "we couldn't verify you" to somebody whose check is still running is both
 * false and alarming.
 *
 * TWO ways in, and they end somewhere different. A borrower who pressed the
 * ID button at the top of screen 2 has not filled the form yet, so they go
 * BACK to screen 2 with their name, date of birth and address now known. A
 * borrower who pressed Continue has already saved everything, so the pulls
 * that the redirect interrupted run here and they go on to the bank.
 *
 * The discriminator is the borrower row: it only exists once Continue has
 * been pressed. Sending a mid-form borrower to the bank screen would silently
 * skip their SSN, their consents and APP-005.
 */
export function IdentityReturnPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useLoanFile(fileId);

  const [status, setStatus] = useState<"checking" | "verified" | "pending" | "failed">("checking");
  const [reason, setReason] = useState<string | null>(null);
  const attempts = useRef(0);

  const verificationId = data?.file.borrowers[0]?.identityVerification?.verificationId;

  /*
   * A saved draft is what says they left from the ID button.
   *
   * The first version of this asked whether a borrower row existed, which is
   * wrong: a file can already have one from an earlier pass through screen 2,
   * and a borrower re-verifying then got routed down the post-Continue path
   * and shown the result of a stale verification. The draft is written
   * immediately before the prefill redirect and cleared on submit, so its
   * presence answers the question exactly.
   */
  const fromPrefill = Boolean(data) && Boolean(fileId) && Boolean(readDraft(fileId));

  /* The mid-form return: complete the prefill session and hand them back to
   * screen 2, which reads the document fields off the file. */
  useEffect(() => {
    if (!fromPrefill || !fileId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;

    async function pick() {
      tries += 1;
      try {
        const r = await api.post<{ status: string; failureReason: string | null }>(
          `/files/${fileId}/identity-document/complete`,
          {},
        );
        if (cancelled) return;
        if (r.status === "verified") {
          setStatus("verified");
          navigate(`/f/${fileId}/identity`, { replace: true });
          return;
        }
        if (r.status === "failed") {
          setReason(r.failureReason);
          setStatus("failed");
          return;
        }
        setStatus("pending");
        if (tries < 8) timer = setTimeout(pick, Math.min(1500 * tries, 6000));
      } catch {
        if (!cancelled) setStatus("pending");
      }
    }

    void pick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fromPrefill, fileId, navigate]);

  useEffect(() => {
    if (!verificationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function check() {
      attempts.current += 1;
      try {
        const r = await api.post<{ status: string; failureReason: string | null }>(
          `/files/${fileId}/identity-verification/complete`,
          { verificationId },
        );
        if (cancelled) return;

        if (r.status === "verified") {
          // The redirect cut screen 2 off mid-submit, so the pulls that would
          // have followed verification have not happened. They run here
          // instead — otherwise a borrower who verifies through a hosted
          // vendor silently ends up with no credit report.
          setStatus("verified");
          await api.post(`/files/${fileId}/credit`, {}).catch(() => undefined);
          await api.post(`/files/${fileId}/screening`, {}).catch(() => undefined);
          const apn = data?.file.propertyRecord?.apn;
          if (apn) await api.post(`/files/${fileId}/liens`, { apn }).catch(() => undefined);

          await queryClient.invalidateQueries({ queryKey: ["file", fileId] });
          await queryClient.invalidateQueries({ queryKey: ["assessment"] });
          if (!cancelled) navigate(`/f/${fileId}/bank`);
          return;
        }
        if (r.status === "failed") {
          setReason(r.failureReason);
          setStatus("failed");
          return;
        }
        // Still processing. Back off rather than hammering: most documents
        // resolve in seconds, and the ones that do not will not resolve faster
        // for being asked twice a second.
        setStatus("pending");
        if (attempts.current < 8) {
          timer = setTimeout(check, Math.min(1500 * attempts.current, 6000));
        }
      } catch {
        if (!cancelled) setStatus("pending");
      }
    }

    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, verificationId, navigate, queryClient]);

  if (!verificationId && !fromPrefill && data) {
    return (
      <div className="card">
        <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
          We don&rsquo;t have a check in progress
        </h1>
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Start again from the identity step and we&rsquo;ll take you through it.
        </p>
        <button className="btn-primary mt-6" onClick={() => navigate(`/f/${fileId}/identity`)}>
          Back to your details
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      {status === "checking" && (
        <>
          <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
            Checking your ID
          </h1>
          <p className="mt-2 text-[14px] text-muted">One moment.</p>
        </>
      )}

      {status === "verified" && (
        <>
          <div className="mb-4 inline-flex items-center gap-2 rounded-pill bg-olive-light px-3 py-1 text-[12px] font-medium text-olive">
            Verified
          </div>
          <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
            That&rsquo;s you confirmed
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            Checking your credit, then on to the next step.
          </p>
        </>
      )}

      {status === "pending" && (
        <>
          <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
            Still checking
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            Your ID is being reviewed. This usually takes a few seconds, and
            occasionally a few minutes.
          </p>
          <p className="mt-3 text-[14px] text-muted">
            You don&rsquo;t have to wait here — carry on, and we&rsquo;ll pick it up.
          </p>
          <div className="mt-6 flex gap-3">
            <button className="btn-primary" onClick={() => navigate(`/f/${fileId}/bank`)}>
              Carry on
            </button>
            <button className="btn-secondary" onClick={() => window.location.reload()}>
              Check again
            </button>
          </div>
        </>
      )}

      {status === "failed" && (
        <>
          <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
            We couldn&rsquo;t confirm that
          </h1>
          <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
            {reason ?? "The check didn't go through."} It happens — a blurry photo or an expired
            document is usually the reason.
          </p>
          <div className="mt-6 flex gap-3">
            <button className="btn-primary" onClick={() => navigate(`/f/${fileId}/identity`)}>
              Try again
            </button>
          </div>
        </>
      )}
    </div>
  );
}
