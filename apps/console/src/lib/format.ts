/**
 * Words and figures. His API answers in three timestamp shapes and money as
 * strings of cents; every screen reads them through here.
 */

const TZ = "America/New_York";

/** ISO, or Postgres text (`2026-09-22 14:03:11.123456+00`), or a plain date. */
export function parseTs(s: string | null | undefined): Date | null {
  if (!s) return null;
  let t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(`${t}T00:00:00`);
  t = t.replace(" ", "T");
  if (/[+-]\d{2}$/.test(t)) t = `${t}:00`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(s: string | null | undefined): string {
  const d = parseTs(s);
  if (!d) return "—";
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: TZ,
  }).format(d);
}

export function fmtDateTime(s: string | null | undefined): string {
  const d = parseTs(s);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  }).format(d);
}

export function fmtTime(s: string | null | undefined): string {
  const d = parseTs(s);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  }).format(d);
}

/** Today's calendar date in the display zone, as [year, month, day]. */
function todayParts(now: Date): [number, number, number] {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

/** "3h ago", "in 2d", "just now". A plain date counts calendar days, whatever the machine's zone. */
export function fmtRelative(s: string | null | undefined, now: Date = new Date()): string {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) {
    const [y, m, d] = s.trim().split("-").map(Number);
    const [ty, tm, td] = todayParts(now);
    const days = Math.round(
      (Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - Date.UTC(ty, tm - 1, td)) / 86_400_000,
    );
    if (days === 0) return "today";
    if (Math.abs(days) >= 30) return fmtDate(s);
    return days < 0 ? `${-days}d ago` : `in ${days}d`;
  }
  const d = parseTs(s);
  if (!d) return "—";
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? ["just now", 0]
      : abs < 3_600_000
        ? [`${Math.round(abs / 60_000)}m`, 1]
        : abs < 86_400_000
          ? [`${Math.round(abs / 3_600_000)}h`, 1]
          : abs < 30 * 86_400_000
            ? [`${Math.round(abs / 86_400_000)}d`, 1]
            : [fmtDate(s), 2];
  if (unit[1] === 0) return unit[0] as string;
  if (unit[1] === 2) return unit[0] as string;
  return diff < 0 ? `${unit[0]} ago` : `in ${unit[0]}`;
}

export function money(
  cents: string | number | bigint | null | undefined,
  opts: { compact?: boolean } = {},
): string {
  if (cents === null || cents === undefined || cents === "") return "—";
  let n: bigint;
  try {
    n =
      typeof cents === "bigint"
        ? cents
        : BigInt(typeof cents === "number" ? Math.round(cents) : cents.split(".")[0]!);
  } catch {
    return String(cents);
  }
  const negative = n < 0n;
  const whole = (negative ? -n : n) / 100n;
  const frac = (negative ? -n : n) % 100n;
  if (opts.compact && whole >= 1000n) {
    const dollars = Number(whole);
    const s =
      dollars >= 1_000_000
        ? `${(dollars / 1_000_000).toFixed(2)}M`
        : `${(dollars / 1_000).toFixed(1)}K`;
    return `${negative ? "−" : ""}$${s}`;
  }
  return `${negative ? "−" : ""}$${whole.toLocaleString("en-US")}.${frac.toString().padStart(2, "0")}`;
}

export function pct(v: string | number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** `human_portal_task` → "Human portal task". */
export function words(s: string | null | undefined): string {
  if (!s) return "—";
  const w = s.replace(/[_-]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n + 1 ? `${id.slice(0, n)}…` : id;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
