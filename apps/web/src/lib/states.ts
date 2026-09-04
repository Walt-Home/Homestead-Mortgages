/**
 * Every state a person can be in, and the words for it.
 *
 * This is a CATALOGUE, not a renderer and not a source of truth. Nothing in
 * the schema records most of these yet — see docs/states.md, which marks what
 * is built and what is designed — so the gallery that renders it says so
 * plainly rather than implying these are live accounts.
 *
 * Two rules it exists to hold:
 *
 * 1. **No colour here.** Each entry carries a `tone`, which is a meaning, and
 *    exactly one .tsx maps a tone to a class. A colour in a .ts module is a
 *    colour the design-system test cannot see, because it only reads
 *    `className` in .tsx files.
 *
 * 2. **No promise the system cannot keep.** There is no mailer in this repo —
 *    no Resend yet, no SMTP, nothing. So no copy here says we will email,
 *    write or call. "We'll put it here" is true, because a person can come
 *    back to the page. `states.test.ts` enforces that with a regex, and it
 *    should stay until a delivery record exists in the schema.
 *
 * Figures in the copy are ILLUSTRATIVE. The real screens interpolate; these
 * are written out so the sentence can be judged at its real length.
 */

/** What a state means about the outcome — never what colour to paint it. */
export type Tone = "neutral" | "ok" | "warn" | "danger";

export interface StateEntry {
  readonly id: string;
  /** Heading the borrower reads. */
  readonly heading: string;
  readonly body: string;
  /** The one control. Null where there is genuinely nothing to press. */
  readonly action: string | null;
  readonly tone: Tone;
  /** Short label for the pill. */
  readonly pill: string;
  readonly terminal: boolean;
  /** What the state means internally. Shown in the gallery, never to a borrower. */
  readonly meaning: string;
}

export interface StateGroup {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly states: readonly StateEntry[];
}

export const STATE_GROUPS: readonly StateGroup[] = [
  {
    id: "before",
    title: "Before there is an application",
    note: "Nothing has been retrieved and no clock is running. The refinance funnel leads here, on a rate the borrower stated rather than one we verified.",
    states: [
      {
        id: "quoted",
        pill: "Estimate",
        tone: "neutral",
        terminal: false,
        meaning:
          "A rate comparison against a borrower-stated existing rate. No party record, no pull, no application.",
        heading: "Here's today's rate against yours",
        body: "You told us you're paying 6.875% on about $410,000. Today we'd quote 5.99% — roughly $240 a month less. That's an estimate from what you've told us: not an offer, not a Loan Estimate, and we haven't checked your credit or looked you up anywhere. Nothing here is an application yet.",
        action: "See what applying involves",
      },
    ],
  },

  {
    id: "intake",
    title: "Becoming an application",
    note: "The moment the sixth TRID piece is pinned, this stops being a draft and a three-business-day clock starts. That transition is stamped by the database, not by a caller who might forget.",
    states: [
      {
        id: "draft",
        pill: "In progress",
        tone: "neutral",
        terminal: false,
        meaning:
          "Started; fewer than six TRID pieces pinned. Not an application under Reg B or TRID.",
        heading: "In progress",
        body: "You've started, and you can stop here as long as you like — we haven't pulled anything about you, and this isn't an application yet. Next up is your bank connection, which takes about two minutes.",
        action: "Continue",
      },
      {
        id: "intake_received",
        pill: "Received",
        tone: "neutral",
        terminal: false,
        meaning:
          "All six pieces pinned. The Loan Estimate clock is running. Stamped once and never un-stamped.",
        heading: "We have your application",
        body: "That's everything we need to call this an application, which starts a clock on our side: your Loan Estimate is due by 9 September. We'll put it here as soon as it exists. Nothing is needed from you right now.",
        action: "See what happens next",
      },
    ],
  },

  {
    id: "working",
    title: "Being worked on",
    note: "The distinction the current product cannot draw at all: whether the next move is ours or the borrower's.",
    states: [
      {
        id: "in_processing",
        pill: "With us",
        tone: "neutral",
        terminal: false,
        meaning: "Open obligations, none of them the borrower's. Nothing is blocked on them.",
        heading: "We're working on it",
        body: "Nothing is needed from you right now. We're verifying your income against the bank activity you connected, and confirming the property record with the county.",
        action: null,
      },
      {
        id: "awaiting_borrower",
        pill: "Needs you",
        tone: "warn",
        terminal: false,
        meaning:
          "At least one open obligation names a borrower. The state today's forward-only stage cannot express.",
        heading: "Two things left for you",
        body: "Your last two payslips — about a minute if they're in your email. And a short note about the $4,200 deposit on 14 August, so we can count it. Everything else is with us or a vendor, and none of it needs you.",
        action: "Start with the deposit note",
      },
      {
        id: "suspended",
        pill: "Waiting",
        tone: "warn",
        terminal: false,
        meaning:
          "Blocked on a third party — an appraisal, a payoff quote, a sanctions near-match. Clocks keep running unless tolling is lawful and recorded.",
        heading: "Waiting on someone else",
        body: "The appraiser has been out to the property and we're waiting on their report. That's ours to chase, not yours. We expect it by 11 September and we'll say so here if that slips.",
        action: null,
      },
      {
        id: "in_underwriting",
        pill: "In review",
        tone: "neutral",
        terminal: false,
        meaning:
          "A named actor holds the file — an underwriter, or later the AI reviewer inside its bounded authority. Assignment is a real, contended, auditable fact.",
        heading: "With an underwriter",
        body: "Someone is looking at a couple of figures that need a person rather than a calculation. There's nothing for you to do, and we'll put the answer here.",
        action: null,
      },
    ],
  },

  {
    id: "decided",
    title: "Decided",
    note: "The rung order is a copy decision as much as a logic one: a decline outranks an outstanding task, because telling somebody to attach a document after you have declined them is worse than telling them nothing.",
    states: [
      {
        id: "counteroffer_outstanding",
        pill: "Counteroffer",
        tone: "warn",
        terminal: false,
        meaning:
          "Creditworthy, wrong loan. Reachable today on LTV over the cap. Not a denial and must not be routed as one.",
        heading: "Not that loan — but here's one we can do",
        body: "As you've structured it, the loan is 97.8% of the property's value, and this program stops at 97%. At $412,000 instead of $416,000 it fits, and your payment goes down about $22. You have until 18 September to decide.",
        action: "Look at the alternative",
      },
      {
        id: "conditionally_approved",
        pill: "Approved",
        tone: "ok",
        terminal: false,
        meaning: "Risk accepted, product eligible, conditions open with named owners.",
        heading: "Approved, with a short list left",
        body: "You're approved subject to four things. Three are ours or a vendor's — the appraisal, the title search, and the flood determination — and you don't need to do anything about those. One is yours: a copy of your homeowner's insurance binder.",
        action: "Upload the insurance binder",
      },
      {
        id: "approved",
        pill: "Approved",
        tone: "ok",
        terminal: false,
        meaning:
          "Every underwriting-phase obligation satisfied by a live artifact. The guard is a SQL predicate an examiner can run themselves — and it tests applicability separately, with no severity filter.",
        heading: "Approved",
        body: "Everything on the underwriting side is done. We still owe you two documents before we can close, and that's our obligation rather than a step you're waiting to finish.",
        action: "See what's still owed to you",
      },
      {
        id: "clear_to_close",
        pill: "Clear to close",
        tone: "ok",
        terminal: false,
        meaning:
          "Every obligation, every phase, each disclosure with a delivery record. Honestly unreachable today: no document generation exists, and that gap stays visible rather than papered over.",
        heading: "Clear to close",
        body: "Everything is done and every document you're owed has reached you. Your closing is booked for 22 September at 10am.",
        action: "See your closing details",
      },
    ],
  },

  {
    id: "closing",
    title: "Closing",
    note: "Two clocks run here, and one of them — the right to rescind — does not exist anywhere in the product today, on a loan mix that is mostly refinances.",
    states: [
      {
        id: "closing",
        pill: "Closing",
        tone: "neutral",
        terminal: false,
        meaning:
          "Closing Disclosure delivered with its own three-day receipt clock; documents out for signature; pre-funding re-screen pending.",
        heading: "Closing",
        body: "Your Closing Disclosure went out on 19 September and by law you have three business days with it before signing. Your documents are ready when that window closes.",
        action: "Read your Closing Disclosure",
      },
      {
        id: "rescission_pending",
        pill: "Can be cancelled",
        tone: "warn",
        terminal: false,
        meaning:
          "TILA three-day right to rescind. Funding is barred until it expires, and the clock starts from the LATER of consummation, disclosure delivery, and two copies of the notice per entitled consumer.",
        heading: "Signed — and you can still change your mind",
        body: "You've signed, and by law you have three business days to cancel. We can't fund until 25 September at midnight. The notice explains exactly how to use that right if you want to.",
        action: "Read the cancellation notice",
      },
      {
        id: "funded",
        pill: "Funded",
        tone: "ok",
        terminal: true,
        meaning:
          "Disbursed. The application's job is over and a Loan now exists; questions about the mortgage move to that object.",
        heading: "It's done",
        body: "Your mortgage funded on 25 September. We're setting it up with your servicer now, and your first payment date will appear here once they've boarded it.",
        action: "See your mortgage",
      },
    ],
  },

  {
    id: "not_approved",
    title: "Not approved",
    note: "Four different endings that the current product would record identically. They are separately reportable, they carry different retention, and only some of them owe the borrower a notice.",
    states: [
      {
        id: "adverse_action_pending",
        pill: "Decision made",
        tone: "danger",
        terminal: false,
        meaning:
          "Declined, notice not yet delivered. THIS is the compliance dashboard — a 30-day clock is running and this row is the alertable object. There is no path from here to any approval word.",
        heading: "We can't move forward",
        body: "We've decided we can't approve this, and you're owed a written explanation with the specific reasons — by law, within 30 days. Here are the reasons as we recorded them: the debt-to-income ratio is 51%, above this program's limit of 45%. The formal notice isn't ready yet, and we'll put it here when it is.",
        action: "Read the reasons",
      },
      {
        id: "denied",
        pill: "Not approved",
        tone: "danger",
        terminal: true,
        meaning:
          "Told, with specific principal reasons traced to derivation nodes, within the window. Requires a delivered notice for every applicant.",
        heading: "Not approved",
        body: "The reasons are your debt-to-income ratio at 51%, against this program's limit of 45%. Your notice is dated 26 September and you can read it here. A credit report was part of this decision, and the notice tells you which bureau and how to get your file from them free of charge.",
        action: "Read your notice",
      },
      {
        id: "incomplete_closed",
        pill: "Closed",
        tone: "neutral",
        terminal: true,
        meaning:
          "Reg B 1002.9(c) — a notice of incomplete application was delivered and the response window lapsed. Separately reportable, and never recorded as a denial or a withdrawal.",
        heading: "Closed because we didn't hear back",
        body: "We asked for your payslips on 12 August and didn't hear back by 2 September, so this application is closed. Nothing about this counts against you. Starting again is quick — most of what we hold is still current, and we'll say exactly what's gone stale.",
        action: "Start again",
      },
      {
        id: "withdrawn",
        pill: "Withdrawn",
        tone: "neutral",
        terminal: true,
        meaning:
          "The borrower stopped it. Guarded on actor kind so staff cannot write this state. Withdrawal is not deletion.",
        heading: "Withdrawn at your request",
        body: "We've stopped every retrieval and switched off any monitoring tied to this application. We keep the record until September 2028 because the law requires it, and you can see exactly what we kept and what we removed.",
        action: "See what we kept",
      },
      {
        id: "canceled",
        pill: "Cancelled",
        tone: "neutral",
        terminal: true,
        meaning:
          "We stopped it, for a reason that is not a credit decision — a duplicate file, an out-of-footprint property, a licensing gap. Cancellation after substantive evaluation is flagged for compliance review, so it cannot be used to avoid a notice.",
        heading: "We closed this application",
        body: "You started a second application for the same property on 30 August, so we've closed this one to keep them from getting tangled. Nothing about it counts against you.",
        action: "Open the newer one",
      },
      {
        id: "expired",
        pill: "Expired",
        tone: "neutral",
        terminal: true,
        meaning:
          "A draft that never became an application. No notice is owed because nothing was applied for — the distinction from incomplete_closed exists for reporting and retention.",
        heading: "This one timed out",
        body: "You started this in June and it never became an application, so we've closed it. We didn't retrieve anything about you and there's nothing to report. Starting again takes about a minute.",
        action: "Start again",
      },
    ],
  },

  {
    id: "crosscutting",
    title: "On a single figure",
    note: "Not a state of the application — a state of one number inside it. Two live sources disagreeing is a common path here, not an edge case: the partner import will contradict the borrower, and the servicer payoff will contradict the stated rate.",
    states: [
      {
        id: "contested",
        pill: "Checking",
        tone: "warn",
        terminal: false,
        meaning:
          "Two sources disagree on one predicate. The engine holds the derived figure rather than picking one quietly.",
        heading: "Two sources disagree",
        body: "Your payslip says $8,200 a month and your employer's records say $7,950. We're not going to pick one quietly — someone here is looking at it, and until they do we're holding your affordability figure rather than guessing. If you know which is right, telling us will speed it up.",
        action: "Tell us which is right",
      },
    ],
  },

  {
    id: "loan",
    title: "Your mortgage",
    note: "A separate object with its own life. Integration depth — deep link today, API next, Supermortgage as the servicer later — is a connection detail rather than a lifecycle fact, so becoming the servicer is a configuration change and not a migration.",
    states: [
      {
        id: "loan_pending_boarding",
        pill: "Setting up",
        tone: "neutral",
        terminal: false,
        meaning:
          "Funded and ours, not yet at a servicer. Transfer notices are owed ahead of the date.",
        heading: "Setting up with your servicer",
        body: "Your mortgage is live and we're handing the account to Grander, who'll look after it day to day. This usually takes a few days, and your first payment date will appear here once it's done.",
        action: null,
      },
      {
        id: "loan_boarding",
        pill: "Setting up",
        tone: "neutral",
        terminal: false,
        meaning:
          "Transfer file sent, not yet acknowledged. A real state because it is the window in which a payment can be misdirected and nobody can find the borrower.",
        heading: "Almost there",
        body: "Grander has your account and is finishing the setup. Don't make a payment anywhere yet — we'll show you where and when as soon as they confirm.",
        action: null,
      },
      {
        id: "loan_imported_unclaimed",
        pill: "Unconfirmed",
        tone: "warn",
        terminal: false,
        meaning:
          "A Grander mortgage attached to a party who has never authenticated. NOTHING person-keyed may be retrieved — but a rate comparison against a published sheet is lawful, because our own servicing data joined to a rate sheet is not a consumer report.",
        heading: "Grander shared this mortgage with us",
        body: "We have 42 Oak Street at 6.875% from Grander. Until you confirm it's yours, that's all we do with it — we haven't checked your credit, contacted anyone or looked you up anywhere, and we can't. Confirming means verifying your ID, not just your email.",
        action: "Confirm this is mine",
      },
      {
        id: "loan_active",
        pill: "Active",
        tone: "ok",
        terminal: false,
        meaning:
          "Serviced and current in our system of record. Delinquency is an attribute of the newest servicing observation, not a state.",
        heading: "Your mortgage",
        body: "$408,220 at 5.99%. Next payment of $2,847 is due 1 October, serviced by Grander. We re-check your rate against the market every month and only get in touch when it's worth your time.",
        action: "Manage this mortgage",
      },
      {
        id: "loan_monitoring_only",
        pill: "Watching",
        tone: "neutral",
        terminal: false,
        meaning:
          "We watch it and can offer better; we neither own nor service it. The right state for a claimed portfolio loan we did not originate, and for one sold servicing-released.",
        heading: "We're watching this one",
        body: "42 Oak Street at 6.875%, serviced by someone else. We don't handle your payments — we just check monthly whether you could do better, and tell you when you could. You can switch that off whenever you like.",
        action: "Turn this off",
      },
      {
        id: "loan_in_servicing_transfer",
        pill: "Transferring",
        tone: "warn",
        terminal: false,
        meaning:
          "Servicing is moving, to us or away. Notices are owed ahead of the transfer date and the borrower's error-resolution rights follow the loan.",
        heading: "Your servicer is changing",
        body: "From 1 November your mortgage will be serviced by Grander instead of us. Your rate, your balance and your payment don't change. Keep paying us until 31 October, then them — and there's a 60-day grace period if a payment goes to the wrong place.",
        action: "See what changes",
      },
      {
        id: "loan_paid_off",
        pill: "Paid off",
        tone: "ok",
        terminal: true,
        meaning:
          "Satisfied by any means other than our own refinance — a sale, or a competitor's payoff.",
        heading: "Paid off",
        body: "This mortgage was paid off on 14 March 2029 and the lien has been released. Nothing further is owed on it.",
        action: null,
      },
      {
        id: "loan_refinanced_internally",
        pill: "Refinanced",
        tone: "ok",
        terminal: true,
        meaning:
          "Paid off by a loan we originated. Kept distinct from paid_off because it is the monitoring loop's success metric and the one attributable chain the product exists to produce.",
        heading: "Refinanced",
        body: "This one was paid off on 14 March 2029 by the mortgage you refinanced into, which took your rate from 6.875% to 5.49%.",
        action: "See the new mortgage",
      },
      {
        id: "loan_transferred_out",
        pill: "Transferred",
        tone: "neutral",
        terminal: true,
        meaning:
          "Servicing sold or the loan sold servicing-released. We may keep the relationship and the opportunity surface even though the servicing data stops — which is why Loan and Party are different records.",
        heading: "Serviced by someone else now",
        body: "Your mortgage moved to Cardinal Servicing on 1 November, so payments and statements are with them. We can keep watching your rate if you want us to.",
        action: "Keep watching my rate",
      },
      {
        id: "loan_charged_off",
        pill: "Closed",
        tone: "danger",
        terminal: true,
        meaning:
          "Terminal loss after foreclosure, short sale or deed in lieu. Different retention and reporting, and it starts the party's seasoning clocks.",
        heading: "This mortgage is closed",
        body: "This account was closed following the sale of the property in 2029. If you're thinking about borrowing again, there are waiting periods that depend on how it was resolved, and we can tell you where you stand.",
        action: "Talk to someone",
      },
      {
        id: "loan_matured",
        pill: "Paid off",
        tone: "ok",
        terminal: true,
        meaning: "Term completed and satisfied.",
        heading: "Paid in full",
        body: "You reached the end of the term on 1 October 2055 and the mortgage is satisfied. The lien has been released.",
        action: null,
      },
    ],
  },

  {
    id: "opportunity",
    title: "Something we found",
    note: "The monitoring loop's output, and the one place the product starts the conversation. A file we proposed must not be counted as organic demand, which is why its origin is recorded differently.",
    states: [
      {
        id: "opportunity_refinance",
        pill: "Worth a look",
        tone: "ok",
        terminal: false,
        meaning:
          "A monthly review found a material opportunity. Accepting creates a NEW application while the old loan keeps being paid — which is why the home screen has to hold more than one thing.",
        heading: "You could be paying about $240 less a month",
        body: "Your loan is at 6.875% and we'd quote around 5.99% today. That's worked out from your own loan's numbers and our current rate sheet — we haven't run your credit for it. It's an estimate, not an offer. Applying would take about ten minutes, and we'd reuse eleven things we already hold.",
        action: "See what applying involves",
      },
      {
        id: "monitoring_failed",
        pill: "Check failed",
        tone: "warn",
        terminal: false,
        meaning:
          "A refresh whose re-pull failed records link_degraded and computes NOTHING. An incomplete refresh yields blocked derivations, blocked yields refer, and an appended refer is a verdict the borrower did not earn.",
        heading: "We couldn't check this month",
        body: "Your bank connection needs signing into again, so we couldn't compare your rate. This isn't a result — it's a check we weren't able to run, and we'd rather say that than show you a number we made up.",
        action: "Reconnect your bank",
      },
    ],
  },
] as const;

/** Flattened, for counting and for tests. */
export const ALL_STATES: readonly StateEntry[] = STATE_GROUPS.flatMap((g) => g.states);
