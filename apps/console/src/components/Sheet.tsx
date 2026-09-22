/**
 * A detail sheet: slides in from the right on a desktop, takes the whole
 * screen on a phone. Escape and the backdrop close it; focus goes to the
 * sheet on open and back to where it was on close.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconButton } from "./ui.js";

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (restore.current instanceof HTMLElement) restore.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-fg/30 backdrop-blur-[1px] transition-opacity"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={clsx(
          "absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-sheet outline-none",
          "animate-[sheet-in_240ms_var(--ease-out)]",
          wide ? "md:w-[720px]" : "md:w-[520px]",
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4 md:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold tracking-tight text-fg">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-sm text-fg-2">{subtitle}</div> : null}
          </div>
          <IconButton label="Close" icon="x" onClick={onClose} className="-mr-2 -mt-1" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-6">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 md:px-6">
            {footer}
          </div>
        ) : null}
      </div>
      <style>{`@keyframes sheet-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}`}</style>
    </div>,
    document.body,
  );
}
