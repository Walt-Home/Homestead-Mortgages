/**
 * Toasts: a small queue at the bottom of the screen, one at a time is plenty.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon } from "./Icon.js";
import type { Tone } from "./ui.js";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const ToastContext = createContext<{
  toast: (t: { tone?: Tone; title: string; body?: string }) => void;
}>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((t: { tone?: Tone; title: string; body?: string }) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, tone: t.tone ?? "neutral", title: t.title, body: t.body }]);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <ToastItem
            key={t.id}
            toast={t}
            onDone={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, toast.tone === "danger" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [onDone, toast.tone]);
  return (
    <div
      role="status"
      className={clsx(
        "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border bg-surface px-4 py-3 shadow-menu",
        toast.tone === "danger" ? "border-danger/30" : "border-line-2",
      )}
    >
      <Icon
        name={toast.tone === "ok" ? "check" : toast.tone === "danger" ? "alert" : "info"}
        size={18}
        className={clsx(
          "mt-0.5",
          toast.tone === "ok" && "text-ok",
          toast.tone === "danger" && "text-danger",
          toast.tone === "warn" && "text-warn",
          (toast.tone === "neutral" || toast.tone === "info") && "text-fg-2",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-fg">{toast.title}</div>
        {toast.body ? <div className="mt-0.5 text-sm text-fg-2">{toast.body}</div> : null}
      </div>
      <button
        type="button"
        onClick={onDone}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 rounded-sm p-1 text-fg-3 hover:text-fg"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext).toast;
}
