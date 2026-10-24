/**
 * The stock templates the verbatim check holds a call's agent lines to.
 *
 * The servicing app's harness refuses a chat message that equals a line of
 * its copy library (apps/servicing/docs/ux/12-message-copy-library.md),
 * loaded the way `channels.ts` loads it. On a call the same failure is an
 * agent reading the app's written copy aloud, whole: a card's words in a
 * voice, where they make no sense ("please check what I understood below").
 * These are the library's lines a delinquent borrower's call could reach,
 * each with its key and its text exactly as the library writes it; a test
 * parses the library the way `channels.ts` does and holds each to it.
 *
 * The browser playground reads no files, so the lines are carried here
 * rather than read at run time.
 */

import type { EvalTemplate } from "./ported/types.js";

export const CALL_TEMPLATES: readonly EvalTemplate[] = [
  {
    key: "hardship.heard",
    text: "I'm sorry to hear that — thank you for telling me. Nothing changes today. I've opened a request for help so we can look at your options together; please check what I understood below.",
  },
  { key: "hardship.open", text: "If something's changed, tell me — there are options." },
  {
    key: "hardship.id_eval.started",
    text: "We've started an early-help review. Finishing it needs a few details from you — the items are listed under Needed from you.",
  },
  {
    key: "hardship.id_eval.review",
    text: "A person is reviewing your early-help request. You'll hear back here.",
  },
  {
    key: "hardship.application.received",
    text: "Your request for help is in. We'll confirm what's needed within 5 business days.",
  },
  {
    key: "hardship.notice.ei",
    text: "Your payment due {{date}} hasn't arrived — here are your options and your team.",
  },
];

/** The copy library, and the line the servicing app parses it with (channels.ts:94, :104). */
export const COPY_LIBRARY_FILE = "docs/ux/12-message-copy-library.md";
export const COPY_LINE = /^- `([a-z0-9_.]+)` — [^—"]*? — "((?:[^"\\]|\\.)*)"(.*)$/;
