/**
 * A page: a header with the title on the left and the actions on the right,
 * then the content, at a measure that keeps tables readable on a wide screen.
 */

import type { ReactNode } from "react";
import clsx from "clsx";
import { Link } from "react-router-dom";
import { Icon } from "./Icon.js";

export function Page({
  title,
  description,
  actions,
  back,
  meta,
  children,
  wide,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A link back to the list this came from. */
  back?: { to: string; label: string };
  /** A quiet line under the title: counts, an as-of, a status. */
  meta?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={clsx(
        "mx-auto w-full px-4 pb-16 pt-5 md:px-8 md:pt-8",
        wide ? "max-w-[1440px]" : "max-w-[1180px]",
      )}
    >
      {back ? (
        <Link
          to={back.to}
          className="mb-3 inline-flex items-center gap-1 text-sm text-fg-2 hover:text-fg"
        >
          <Icon name="arrow-left" size={16} />
          {back.label}
        </Link>
      ) : null}
      <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg md:text-3xl">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-base text-fg-2">{description}</p> : null}
          {meta ? <div className="mt-2 text-sm text-fg-3">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {children}
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("mt-8 first:mt-0", className)}>
      {title ? (
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {aside ? <div className="text-sm text-fg-3">{aside}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
