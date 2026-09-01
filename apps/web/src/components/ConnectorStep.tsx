import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";

/**
 * Screens 3–6: connect a source, see what came back.
 *
 * The important behaviour here is what happens the SECOND time you land on it.
 * This component used to start every render at "idle" and offer a Connect
 * button regardless of whether the connector had already run — so going back
 * to look at your credit report showed an empty form, and clicking it pulled
 * again. Now the parent passes what the file already holds, and a completed
 * step renders as completed, with re-running an explicit choice rather than
 * the only available action.
 */

export interface ConnectorStepProps {
  fileId: string;
  endpoint: "credit" | "bank" | "payroll" | "irs";
  title: string;
  /** What the borrower gets by connecting, in their terms, not ours. */
  promise: string;
  detail: string;
  duration: string;
  /** Data already on the file for this connector, if it has run. */
  existing: unknown | null;
  /**
   * Pulls the domain object out of the POST response, so a freshly-pulled
   * result and one loaded from the file render through the same code path.
   * Without it the two shapes differ and a revisited screen renders blank.
   */
  extract: (response: Record<string, unknown>) => unknown;
  /** Demo files are read-only; offering a button that 403s is worse than no button. */
  readOnly?: boolean;
  /** Rendered instead of the Connect button when something must happen first. */
  blocked?: { message: string; action?: React.ReactNode } | null;
  onDone: () => void;
  renderResult: (data: unknown) => React.ReactNode;
}

export function ConnectorStep(props: ConnectorStepProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshResult, setFreshResult] = useState<unknown>(null);

  // What to show: whatever we just pulled, else whatever the file already had.
  const result = freshResult ?? props.existing;
  const connected = result !== null && result !== undefined;

  async function connect() {
    setPending(true);
    setError(null);
    try {
      const response = await api.post<Record<string, unknown>>(
        `/files/${props.fileId}/${props.endpoint}`,
      );
      setFreshResult(props.extract(response));
      // The rail and the file both change on a pull; without this the sidebar
      // keeps showing work the connector just retired.
      await queryClient.invalidateQueries({ queryKey: ["file", props.fileId] });
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    } catch (err) {
      if (err instanceof ApiError && err.code === "AUTHORIZATION_REQUIRED") {
        setError(
          err.requirementId === "INC-008"
            ? "We need your signed 4506-C before we can request transcripts."
            : "We need your signed authorization before we can verify anything.",
        );
      } else if (err instanceof ApiError && err.code === "DEMO_FILE_READ_ONLY") {
        setError("This is a sample file, so it can't be changed. Start your own to try this.");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">{props.title}</h1>
      <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">{props.promise}</p>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">{props.detail}</p>

      {!connected && props.blocked && (
        <div className="mt-6 rounded-row border border-notice-border bg-notice-bg px-4 py-3.5">
          <p className="text-[14px] leading-relaxed text-ink-soft">{props.blocked.message}</p>
          {props.blocked.action && <div className="mt-3">{props.blocked.action}</div>}
        </div>
      )}

      {!connected && !props.blocked && !props.readOnly && (
        <div className="mt-6 flex items-center gap-3">
          <button className="btn-primary" onClick={connect} disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </button>
          <span className="text-[13px] text-subtle">{props.duration}</span>
        </div>
      )}

      {!connected && props.readOnly && (
        <p className="mt-6 text-[13px] text-subtle">
          This is a sample file. Start your own to walk through connecting.
        </p>
      )}

      {pending && (
        <p className="mt-4 text-[13px] text-meta">
          Talking to your provider. This usually takes a few seconds.
        </p>
      )}

      {error && (
        <div className="mt-5 rounded-row border border-notice-border bg-notice-bg px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      {connected && (
        <div className="mt-6 border-t border-line-light pt-5">
          <div className="mb-4 inline-flex items-center gap-2 rounded-pill bg-olive-light px-3 py-1 text-[12px] font-medium text-olive">
            Connected
          </div>
          {props.renderResult(result)}
          <div className="mt-6 flex items-center gap-3">
            <button className="btn-primary" onClick={props.onDone}>
              Continue
            </button>
            <button className="btn-secondary" onClick={() => navigate(-1)}>
              Back
            </button>
            {!props.readOnly && (
              <button
                className="text-[13px] text-subtle underline-offset-2 hover:underline"
                onClick={connect}
                disabled={pending}
              >
                {pending ? "Refreshing…" : "Pull again"}
              </button>
            )}
          </div>
        </div>
      )}

      {!connected && (
        <div className="mt-6 border-t border-line-light pt-4">
          <button
            className="text-[13px] text-subtle underline-offset-2 hover:underline"
            onClick={() => navigate(-1)}
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
