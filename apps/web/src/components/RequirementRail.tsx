import clsx from "clsx";
import type { Assessment, OutstandingItem } from "../lib/api.js";

/**
 * The rail that answers "what is left".
 *
 * Three groups, and they are three different sentences:
 *   · needed now — applies to you, and you can do it
 *   · we might still ask — applicability is not yet knowable
 *   · waiting — applies, but something upstream has to happen first
 *
 * Collapsing the middle group into either neighbour is what makes a flow feel
 * dishonest. A borrower told they are done, then asked for four more things
 * after the credit pull, has been misled by a progress bar.
 */

const SEVERITY_LABEL: Record<OutstandingItem["severity"], string> = {
  regulatory_violation: "Required by law",
  repurchase_unsaleable: "Required to sell the loan",
  financial_loss: "Affects your price",
  rework_delay: "Keeps things moving",
};

export function RequirementRail({ assessment }: { assessment: Assessment | undefined }) {
  if (!assessment) {
    return <aside className="w-full lg:w-80 text-[13px] text-subtle">Loading requirements…</aside>;
  }

  const { progress, outstanding, blocked } = assessment;
  const actionable = outstanding.filter((o) => o.applicabilityKnown);
  const possible = outstanding.filter((o) => !o.applicabilityKnown);

  return (
    <aside className="w-full lg:w-80 shrink-0">
      <div className="card">
        <h2 className="font-brand text-[15px] font-semibold text-ink-editorial">Your file</h2>

        <dl className="mt-4 space-y-1.5 text-[13px]">
          <Row label="Satisfied" value={progress.satisfied} tone="olive" />
          <Row label="Needed now" value={actionable.length} tone="gold" />
          <Row label="Waiting on something else" value={progress.blocked} tone="muted" />
          <Row label="We might still ask" value={possible.length} tone="muted" />
        </dl>

        {actionable.length > 0 && (
          <Group title="Needed now">
            {actionable.slice(0, 6).map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </Group>
        )}

        {possible.length > 0 && (
          <Group title="We might still ask">
            <p className="text-[12px] leading-relaxed text-subtle">
              {possible.length} item{possible.length === 1 ? "" : "s"} depend on information we
              haven&rsquo;t received yet. Connecting an account usually settles them without
              anything to fill in.
            </p>
          </Group>
        )}

        {blocked.length > 0 && (
          <Group title="Waiting">
            {blocked.slice(0, 4).map((b) => (
              <div key={b.id} className="text-[12px] leading-relaxed">
                <span className="text-ink-soft">{b.statement}</span>
                {b.rootCauses[0] && (
                  <span className="block text-subtle">after {b.rootCauses[0]}</span>
                )}
              </div>
            ))}
          </Group>
        )}
      </div>
    </aside>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: "olive" | "gold" | "muted" }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted">{label}</dt>
      <dd
        className={clsx(
          "figure text-[15px]",
          tone === "olive" && "text-olive",
          tone === "gold" && "text-gold",
          tone === "muted" && "text-meta",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t border-line-light pt-4">
      <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-subtle">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Item({ item }: { item: OutstandingItem }) {
  return (
    <div className="text-[12px] leading-relaxed">
      <span className="text-ink-soft">{item.statement}</span>
      <span className="block text-subtle">
        {item.missing ?? item.waitingFor} · {SEVERITY_LABEL[item.severity]}
      </span>
    </div>
  );
}
