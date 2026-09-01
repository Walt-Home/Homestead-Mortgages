import clsx from "clsx";
import type { Assessment, OutstandingItem } from "../lib/api.js";

/**
 * The rail that answers "what is left".
 *
 * Two things it must not do, both of which it used to.
 *
 * It must not show a borrower work they cannot possibly do. The list ran to
 * twenty-one items, of which eleven were things like "Loan Estimate delivered"
 * and "OFAC / SDN screening cleared" — lender and engine work with no button
 * anywhere. Burying the two real actions under nine impossible ones makes the
 * product look broken to anyone who reads the list and goes looking.
 *
 * And it must not fail silently. A failed fetch left it saying "Loading
 * requirements…" forever, which is indistinguishable from a slow network and
 * hides the fact that the screen beside it is showing nothing real.
 */

const SEVERITY_LABEL: Record<OutstandingItem["severity"], string> = {
  regulatory_violation: "Required by law",
  repurchase_unsaleable: "Required to sell the loan",
  financial_loss: "Affects your price",
  rework_delay: "Keeps things moving",
};

export function RequirementRail({
  assessment,
  failed,
}: {
  assessment: Assessment | undefined;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <aside className="w-full shrink-0 lg:w-80">
        <div className="card">
          <h2 className="font-brand text-[15px] font-semibold text-ink-editorial">Your file</h2>
          <p className="mt-3 text-[13px] leading-relaxed text-error">
            We couldn&rsquo;t load what&rsquo;s outstanding. The steps still work — reload to try
            again.
          </p>
        </div>
      </aside>
    );
  }

  if (!assessment) {
    return <aside className="w-full text-[13px] text-subtle lg:w-80">Loading requirements…</aside>;
  }

  const { progress, outstanding, blocked } = assessment;
  const mine = outstanding.filter((o) => o.actor === "borrower" && o.applicabilityKnown);
  const possible = outstanding.filter((o) => o.actor === "borrower" && !o.applicabilityKnown);
  const theirs = outstanding.filter((o) => o.actor === "lender");

  return (
    <aside className="w-full shrink-0 lg:w-80">
      <div className="card">
        <h2 className="font-brand text-[15px] font-semibold text-ink-editorial">Your file</h2>

        <dl className="mt-4 space-y-1.5 text-[13px]">
          <Row label="Satisfied" value={progress.satisfied} tone="olive" />
          <Row label="Your turn" value={mine.length} tone="gold" />
          <Row label="We're handling" value={theirs.length} tone="muted" />
          <Row label="Waiting on something else" value={progress.blocked} tone="muted" />
        </dl>

        {mine.length > 0 && (
          <Group title="Your turn">
            {mine.slice(0, 6).map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </Group>
        )}

        {mine.length === 0 && (
          <Group title="Your turn">
            <p className="text-[12px] leading-relaxed text-subtle">
              Nothing right now — carry on to the next step.
            </p>
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

        {theirs.length > 0 && (
          <Group title="We're handling">
            <p className="text-[12px] leading-relaxed text-subtle">
              {theirs.length} item{theirs.length === 1 ? "" : "s"} are ours or the engine&rsquo;s —
              disclosures, screenings and the arithmetic. Nothing for you to do.
            </p>
          </Group>
        )}

        {blocked.length > 0 && (
          <Group title="Waiting">
            {blocked.slice(0, 4).map((b) => (
              <div key={b.id} className="text-[12px] leading-relaxed">
                <span className="text-ink-soft">{b.statement}</span>
                {b.rootCauses[0] && <span className="block text-subtle">after {b.rootCauses[0]}</span>}
              </div>
            ))}
          </Group>
        )}
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "olive" | "gold" | "muted";
}) {
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
