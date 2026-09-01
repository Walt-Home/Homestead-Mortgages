import { useState } from "react";
import { api, ApiError } from "../lib/api.js";

/**
 * Screens 3–6 are the same shape: explain what connecting does, connect, show
 * what came back. The differences are copy and an endpoint, so they share one
 * component rather than four near-identical files.
 */

export interface ConnectorStepProps {
  fileId: string;
  endpoint: "credit" | "bank" | "payroll" | "irs";
  title: string;
  /** What the borrower gets by connecting, in their terms, not ours. */
  promise: string;
  detail: string;
  /** Roughly how long the pull takes, so the wait is expected rather than alarming. */
  duration: string;
  onDone: () => void;
  renderResult: (data: unknown) => React.ReactNode;
}

export function ConnectorStep(props: ConnectorStepProps) {
  const [status, setStatus] = useState<"idle" | "connecting" | "done" | "error">("idle");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setStatus("connecting");
    setError(null);
    try {
      const response = await api.post<Record<string, unknown>>(
        `/files/${props.fileId}/${props.endpoint}`,
      );
      setResult(response);
      setStatus("done");
    } catch (err) {
      // A 403 here means a consent is missing, and the response says which.
      // Telling the borrower "authorization failed" would be true and useless.
      if (err instanceof ApiError && err.code === "AUTHORIZATION_REQUIRED") {
        setError(
          err.requirementId === "INC-008"
            ? "We need your signed 4506-C before we can request transcripts."
            : "We need your signed authorization before we can verify anything.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
      setStatus("error");
    }
  }

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">{props.title}</h1>
      <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">{props.promise}</p>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">{props.detail}</p>

      {status !== "done" && (
        <div className="mt-6 flex items-center gap-3">
          <button className="btn-primary" onClick={connect} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect"}
          </button>
          <span className="text-[13px] text-subtle">{props.duration}</span>
        </div>
      )}

      {status === "connecting" && (
        <p className="mt-4 text-[13px] text-meta">
          Talking to your provider. This usually takes a few seconds.
        </p>
      )}

      {error && (
        <div className="mt-5 rounded-row border border-notice-border bg-notice-bg px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      {status === "done" && (
        <div className="mt-6 border-t border-line-light pt-5">
          <div className="mb-4 inline-flex items-center gap-2 rounded-pill bg-olive-light px-3 py-1 text-[12px] font-medium text-olive">
            Connected
          </div>
          {props.renderResult(result)}
          <button className="btn-primary mt-6" onClick={props.onDone}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
