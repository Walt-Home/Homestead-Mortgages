/**
 * The console's primitives. Small, composable, and the only place a visual
 * decision about a button, a pill, a field or a surface is made.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./Icon.js";

/* ── Buttons ─────────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,border-color,color,transform,opacity] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90",
  secondary: "border border-line-2 bg-surface text-fg hover:border-line-3 hover:bg-surface-2",
  ghost: "text-fg-2 hover:bg-surface-2 hover:text-fg",
  danger: "border border-danger/40 bg-surface text-danger hover:bg-danger-soft",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: IconName;
    loading?: boolean;
  }
>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={clsx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon name="loader" size={16} className="animate-spin" />
      ) : icon ? (
        <Icon name={icon} size={16} />
      ) : null}
      {children}
    </button>
  );
});

/** A square icon button, for chrome: close, menu, back. */
export function IconButton({
  label,
  icon,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/* ── Pills ───────────────────────────────────────────────────────────────── */

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const PILL_TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-2",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
};

export function Pill({
  tone = "neutral",
  children,
  className,
  mono,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
        mono && "font-mono",
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small count beside a nav item or a heading. */
export function Count({ n, tone = "neutral" }: { n: number | null | undefined; tone?: Tone }) {
  if (n === null || n === undefined) return null;
  return (
    <span
      className={clsx(
        "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium",
        n === 0 ? "bg-transparent text-fg-3" : PILL_TONE[tone],
      )}
    >
      {n.toLocaleString()}
    </span>
  );
}

/* ── Fields ──────────────────────────────────────────────────────────────── */

const FIELD_BASE =
  "block w-full rounded-md border border-line-3 bg-surface px-3 text-fg placeholder:text-fg-3 transition-[border-color,box-shadow] duration-150 focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-focus/20 disabled:opacity-50 aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    // 16px on the input itself: anything smaller makes iOS Safari zoom in.
    return (
      <input
        ref={ref}
        className={clsx(FIELD_BASE, "h-11 text-[16px] leading-6 sm:h-10 sm:text-base", className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={clsx(FIELD_BASE, "h-10 cursor-pointer pr-8 text-base", className)}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={clsx(FIELD_BASE, "min-h-20 resize-y py-2 text-base", className)}
      {...rest}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label
      className={clsx(
        "inline-flex cursor-pointer select-none items-center gap-2 text-base text-fg",
        className,
      )}
    >
      <input type="checkbox" className="h-4 w-4 rounded-sm border-line-3" {...rest} />
      {label}
    </label>
  );
}

/* ── Surfaces and layout ─────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-lg border border-line-2 bg-surface shadow-card",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A section label: small caps, quiet, above a group. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("text-xs font-semibold uppercase tracking-[0.08em] text-fg-3", className)}>
      {children}
    </div>
  );
}

/** A big figure with its label under it. */
export function Stat({
  label,
  value,
  tone,
  hint,
  onClick,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={clsx(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-line-2 bg-surface p-4 text-left shadow-card",
        onClick && "transition-colors hover:border-line-3 hover:bg-surface-2",
      )}
    >
      <span className="text-sm text-fg-2">{label}</span>
      <span
        className={clsx(
          "text-2xl font-semibold tracking-tight",
          tone === "danger" && "text-danger",
          tone === "warn" && "text-warn",
          tone === "ok" && "text-ok",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-fg-3">{hint}</span> : null}
    </Tag>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const icon: IconName =
    tone === "ok" ? "check" : tone === "danger" || tone === "warn" ? "alert" : "info";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={clsx(
        "flex gap-3 rounded-md border px-4 py-3 text-base",
        tone === "info" && "border-info/20 bg-info-soft text-fg",
        tone === "ok" && "border-ok/20 bg-ok-soft text-fg",
        tone === "warn" && "border-warn/25 bg-warn-soft text-fg",
        tone === "danger" && "border-danger/25 bg-danger-soft text-fg",
        tone === "neutral" && "border-line-2 bg-surface-2 text-fg",
        tone === "accent" && "border-accent/25 bg-accent-soft text-fg",
        className,
      )}
    >
      <Icon
        name={icon}
        size={18}
        className={clsx(
          "mt-0.5",
          tone === "info" && "text-info",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "danger" && "text-danger",
          tone === "accent" && "text-accent",
          tone === "neutral" && "text-fg-2",
        )}
      />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={clsx(title && "mt-0.5", "text-fg-2")}>{children}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon = "inbox",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-fg-3">
        <Icon name={icon} size={22} />
      </div>
      <div className="text-md font-medium text-fg">{title}</div>
      {children ? <div className="max-w-sm text-base text-fg-2">{children}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** A segmented control: one of a few values, all visible. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode; count?: number }[];
  className?: string;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-line-2 bg-surface p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors",
            o.value === value ? "bg-fg text-surface" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
          )}
        >
          {o.label}
          {o.count !== undefined ? (
            <span className={clsx("text-xs", o.value === value ? "text-surface/70" : "text-fg-3")}>
              {o.count.toLocaleString()}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** Key–value rows, the detail pattern everywhere. */
export function Rows({
  rows,
  className,
}: {
  rows: readonly { label: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={clsx("divide-y divide-line", className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-start justify-between gap-6 py-2.5">
          <dt className="shrink-0 text-sm text-fg-2">{r.label}</dt>
          <dd
            className={clsx(
              "min-w-0 break-words text-right text-base text-fg",
              r.mono && "font-mono text-sm",
            )}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={clsx("animate-pulse rounded-sm bg-surface-3", className ?? "h-4 w-24")}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Icon name="loader" className={clsx("animate-spin text-fg-3", className)} />;
}
