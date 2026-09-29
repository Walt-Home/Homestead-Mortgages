/**
 * Doing something: one hook that runs an act, refreshes what it changed,
 * tells the person, and — when the servicing app answers ROLE_REQUIRED with
 * the roles this session could act as — sends it again as the first of
 * them, once, because the console has one role and the four underneath are
 * the servicing app's spelling of it. A refusal that survives that is
 * offered as buttons, as it always was.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, call, type Call } from "./api.js";
import { useToast } from "../components/Toast.js";
import { roleWord } from "./auth.js";

export interface ActState {
  busy: boolean;
  error: ApiError | null;
  /** Roles the person may retry as; empty when the refusal is final. */
  actAs: readonly string[];
}

export function useAct(opts: { invalidate?: readonly (readonly unknown[])[]; done?: string } = {}) {
  const queries = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<ActState>({ busy: false, error: null, actAs: [] });
  const [last, setLast] = useState<{ path: string; init: Call } | null>(null);

  const run = useCallback(
    async <T>(path: string, init: Call = {}): Promise<T | null> => {
      setState({ busy: true, error: null, actAs: [] });
      setLast({ path, init });
      let attempt = init;
      for (let sent = 0; ; sent += 1) {
        try {
          const { data } = await call<T>(path, attempt);
          setState({ busy: false, error: null, actAs: [] });
          for (const key of opts.invalidate ?? [])
            void queries.invalidateQueries({ queryKey: key });
          if (opts.done) toast({ tone: "ok", title: opts.done });
          return data;
        } catch (err) {
          const e = err instanceof ApiError ? err : new ApiError(0, String(err), null);
          // An act asked for under no role is asked for under the least the
          // account holds; when the route wants another, send it as that one.
          const again = e.actAs[0];
          if (again && sent === 0 && !attempt.role) {
            attempt = { ...attempt, role: again };
            continue;
          }
          setState({ busy: false, error: e, actAs: e.actAs });
          if (e.actAs.length === 0) {
            toast({ tone: "danger", title: "That didn't go through", body: e.message });
          }
          return null;
        }
      }
    },
    [opts.invalidate, opts.done, queries, toast],
  );

  /** Send the last act again as another role. */
  const retryAs = useCallback(
    async (role: string) => {
      if (!last) return null;
      toast({ tone: "neutral", title: `Sending again as ${roleWord(role)}` });
      return run(last.path, { ...last.init, role });
    },
    [last, run, toast],
  );

  const clear = useCallback(() => setState({ busy: false, error: null, actAs: [] }), []);

  return { ...state, run, retryAs, clear };
}
