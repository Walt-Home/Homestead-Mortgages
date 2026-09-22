/**
 * The data table, and the card list it becomes on a narrow screen.
 *
 * One column model drives both: above `md` the rows are a table with a
 * sticky header, hairline rows and figures right-aligned; below it each row
 * is a card of label–value pairs, because a nine-column table on a phone is
 * a scroll in two directions and nothing else. A row that opens something is
 * a button in both forms.
 */

import type { ReactNode } from "react";
import clsx from "clsx";
import { EmptyState, Skeleton } from "./ui.js";
import { Icon, type IconName } from "./Icon.js";

export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: Row) => ReactNode;
  readonly align?: "left" | "right";
  /** Tailwind width class for the table form, e.g. "w-40". */
  readonly width?: string;
  /** Left out of the card form (a status already shown in the title, say). */
  readonly hideOnCard?: boolean;
  /** Shown as the card's title rather than a labelled pair. */
  readonly primary?: boolean;
  readonly mono?: boolean;
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty,
  className,
  dense,
}: {
  columns: readonly Column<Row>[];
  rows: readonly Row[] | undefined;
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  empty?: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode };
  className?: string;
  dense?: boolean;
}) {
  if (loading && !rows) {
    return (
      <div className={clsx("divide-y divide-line", className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
        ))}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <EmptyState icon={empty?.icon} title={empty?.title ?? "Nothing here"} action={empty?.action}>
        {empty?.body}
      </EmptyState>
    );
  }
  const primary = columns.find((c) => c.primary) ?? columns[0]!;
  const cardColumns = columns.filter((c) => c !== primary && !c.hideOnCard);
  const cell = (c: Column<Row>) =>
    clsx(
      "align-middle",
      dense ? "px-3 py-2" : "px-4 py-3",
      c.align === "right" ? "text-right" : "text-left",
      c.mono && "font-mono text-sm",
    );

  return (
    <div className={className}>
      {/* The table form. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-base">
          <thead className="sticky top-0 z-[1] bg-surface">
            <tr className="border-b border-line-2">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={clsx(
                    "whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-fg-3",
                    c.align === "right" ? "text-right" : "text-left",
                    c.width,
                  )}
                >
                  {c.header}
                </th>
              ))}
              {onRowClick ? <th className="w-8" aria-hidden="true" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={clsx(
                  "group transition-colors",
                  onRowClick && "cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2",
                )}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cell(c)}>
                    {c.render(row)}
                  </td>
                ))}
                {onRowClick ? (
                  <td className="pr-3 text-right text-fg-3 group-hover:text-fg-2">
                    <Icon name="chevron-right" size={16} className="inline-block" />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The card form. */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((row) => {
          const Tag = onRowClick ? "button" : "div";
          return (
            <li key={rowKey(row)}>
              <Tag
                type={onRowClick ? "button" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx(
                  "block w-full px-4 py-3.5 text-left",
                  onRowClick && "transition-colors active:bg-surface-2",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 text-base font-medium text-fg">
                    {primary.render(row)}
                  </div>
                  {onRowClick ? (
                    <Icon name="chevron-right" size={18} className="mt-0.5 text-fg-3" />
                  ) : null}
                </div>
                {cardColumns.length > 0 ? (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {cardColumns.map((c) => (
                      <div key={c.key} className="contents">
                        <dt className="text-fg-3">{c.header}</dt>
                        <dd className={clsx("min-w-0 text-fg", c.mono && "font-mono")}>
                          {c.render(row)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Tag>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
