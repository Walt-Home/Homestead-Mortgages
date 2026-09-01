import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Assessment } from "../lib/api.js";

/**
 * Screen 7. Drew's note: "Only what didn't connect. Should feel like an
 * exception, not a step."
 *
 * So it renders nothing when nothing is outstanding, and says so. The empty
 * state is the intended state.
 */
export function UploadPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["assessment", fileId],
    queryFn: () => api.get<Assessment>(`/requirements/${fileId}/assessment`),
    enabled: Boolean(fileId),
  });

  const items = (data?.outstanding ?? []).filter(
    (o) =>
      o.applicabilityKnown &&
      (o.source === "document_upload" || o.source === "borrower_input") &&
      o.screen === "upload_fallback",
  );

  return (
    <div className="card">
      <h1 className="font-brand text-[22px] font-semibold text-ink-editorial">
        {items.length === 0 ? "Nothing left to send" : "A few things we could not retrieve"}
      </h1>

      {items.length === 0 ? (
        <p className="mt-2 font-prose text-[16px] leading-relaxed text-ink-prose">
          Your connections covered everything. There is nothing to upload.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[14px] text-muted">
            Your connections covered most of it. These {items.length} need you.
          </p>
          <ul className="mt-6 space-y-4">
            {items.map((item) => (
              <li key={item.id} className="rounded-row border border-line-light bg-raised px-4 py-3.5">
                <p className="text-[15px] text-ink-editorial">{item.statement}</p>
                <p className="mt-1 text-[13px] text-muted">{item.missing}</p>
                <p className="mt-1 text-[12px] text-subtle">Asked because: {item.appliesBecause}</p>
                <button className="btn-secondary mt-3 text-[13px]" type="button" disabled>
                  Upload — not wired in this prototype
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <button className="btn-primary mt-6" onClick={() => navigate(`/f/${fileId}/decision`)}>
        See where I stand
      </button>
    </div>
  );
}
