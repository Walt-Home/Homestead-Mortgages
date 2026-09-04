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
 * 1. **No color here.** Each entry carries a `tone`, which is a meaning, and
 *    exactly one .tsx maps a tone to a class. A color in a .ts module is a
 *    color the design-system test cannot see, because it only reads
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

/** What a state means about the outcome — never what color to paint it. */
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
        pill: "You've started",
        tone: "neutral",
        terminal: false,
        meaning:
          "Started; fewer than six TRID pieces pinned. Not an application under Reg B or TRID.",
        heading: "In progress",
        body: "You can stop here as long as you like — we haven't pulled anything about you, and this isn't an application yet. Next is a few questions about you: your name, your date of birth, and your Social Security number.",
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
        body: "That's everything we need to call this an application, which starts a clock on our side: your Loan Estimate is due by September 9. We'll put it here as soon as it exists. Your bank connection is next, and that's the last thing we need from you for now.",
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
        body: "Your last two paystubs — about a minute if they're in your email. And a short note about the $4,200 deposit on August 14, so we can count it as yours. We need both by September 2; if we don't have them by then we'll close this application without deciding on it. Everything else is ours to do, and none of it needs you.",
        action: "Start with the deposit note",
      },
      {
        id: "suspended",
        pill: "Waiting",
        tone: "neutral",
        terminal: false,
        meaning:
          "Blocked on a third party — an appraisal, a payoff quote, a sanctions near-match. Clocks keep running unless tolling is lawful and recorded.",
        heading: "Waiting on someone else",
        body: "The appraiser has been out to the property and we're waiting on their report. That's ours to chase, not yours. We expect it by September 11 and we'll say so here if that slips.",
        action: null,
      },
      {
        id: "in_underwriting",
        pill: "In review",
        tone: "neutral",
        terminal: false,
        meaning:
          "A named actor holds the file — an underwriter, or later the AI reviewer inside its bounded authority. Assignment is a real, contended, auditable fact.",
        heading: "Being decided",
        body: "A couple of the figures need judgment rather than a calculation, so your file is being looked at rather than run through. There's nothing for you to do, and we'll put the answer here.",
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
        body: "The loan you asked for, $416,000, is 97.8% of what the property is worth, and this program stops at 97%. Borrowing $412,000 instead fits — that's $4,000 less loan, so $4,000 more for you to bring to closing, and about $22 off your monthly payment. You have until September 18 to decide, and if you'd rather not, you'll still get the reasons we couldn't do the loan the way you asked.",
        action: "Look at the alternative",
      },
      {
        id: "conditionally_approved",
        pill: "Approved with conditions",
        tone: "ok",
        terminal: false,
        meaning: "Risk accepted, product eligible, conditions open with named owners.",
        heading: "Approved, with a short list left",
        body: "You're approved subject to four things. Three are ours or a vendor's — the appraisal, the title search, and the flood determination — and none of them needs anything from you today. If the flood determination comes back saying the property sits in a flood zone, you'll need flood insurance too, and we'll say so here. One is yours: a copy of your homeowner's insurance binder.",
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
        body: "Everything on our side is done, and your closing is booked for September 22 at 10 a.m. Your Closing Disclosure comes first: by law you get three business days with it before you sign.",
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
        body: "Your Closing Disclosure — your final rate, payment and costs — is here, dated September 17. By law you get three business days with it before you sign, counted from when it reaches you. Your closing is booked for September 22, and your documents are ready when that window closes.",
        action: "Read your Closing Disclosure",
      },
      {
        id: "rescission_pending",
        pill: "Can be canceled",
        tone: "warn",
        terminal: false,
        meaning:
          "TILA three-day right to rescind. Funding is barred until it expires, and the clock starts from the LATER of consummation, disclosure delivery, and two copies of the notice per entitled consumer.",
        heading: "Signed — and you can still change your mind",
        body: "You've signed, and by law you can cancel until the end of Friday, September 25 — three business days from the later of signing, getting your disclosures, and getting this notice. Anyone with an ownership interest in the home can cancel, not only whoever signed the note, and one of you canceling cancels it for everyone. Nothing can be paid out until that window closes, and the notice below says exactly what to do.",
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
        body: "Your mortgage funded on September 28, once your cancellation window had closed. We're handing your account to the company that will collect your payments, and your first payment date will appear here once they're set up.",
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
        heading: "We can't approve this",
        body: "You're owed a written explanation with the specific reasons — by law, within 30 days of the day your application was complete, which makes yours due by September 26. Here are the reasons as we recorded them: the debt-to-income ratio is 51%, above this program's limit of 45%. The formal notice isn't ready yet, and we'll put it here when it is.",
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
        body: "The reasons are your debt-to-income ratio at 51%, against this program's limit of 45%. Your notice is dated September 26 and you can read it here. A credit report was part of this decision, and the notice tells you which bureau and how to get your file from them free of charge.",
        action: "Read your notice",
      },
      {
        id: "incomplete_closed",
        pill: "Lapsed",
        tone: "neutral",
        terminal: true,
        meaning:
          "Reg B 1002.9(c) — a notice of incomplete application was delivered and the response window lapsed. Separately reportable, and never recorded as a denial or a withdrawal.",
        heading: "Closed because we didn't hear back",
        body: "We asked for your paystubs on August 12 and didn't hear back by September 2, so this application is closed. That isn't a decision about your credit and we haven't recorded it as a denial. The credit check we already ran stays on your credit file, the way any credit check does. Starting again is quick — most of what we hold is still current, and we'll say exactly what's gone stale.",
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
        body: "We've stopped every retrieval and switched off any monitoring tied to this application. Withdrawing stops the work; it doesn't erase the file. We keep the record until September 2028 because the law requires it, and you can see exactly what we hold.",
        action: "See what we hold",
      },
      {
        id: "canceled",
        pill: "Canceled",
        tone: "neutral",
        terminal: true,
        meaning:
          "We stopped it, for a reason that is not a credit decision — a duplicate file, an out-of-footprint property, a licensing gap. Cancellation after substantive evaluation is flagged for compliance review, so it cannot be used to avoid a notice.",
        heading: "We closed this application",
        body: "You started a second application for the same property on August 30, so we've closed this one to keep them from getting tangled. That's our doing, not a decision about your credit, and we haven't recorded it as one. The newer application carries on unaffected.",
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
        body: "You started this in June and it never became an application, so we've closed it. We didn't look anything up about you, so there's no trace of it anywhere else. Starting again means doing it from the beginning — about fifteen minutes.",
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
          "Two numbers don't match on one predicate. The engine holds the derived figure rather than picking one quietly.",
        heading: "Two sources disagree",
        body: "Your paystub says $8,200 a month and your employer's records say $7,950. We're not going to pick one quietly. Someone here is looking at it, and until they've finished we won't put a number on what you can borrow. If you know why they differ — a raise in July, a month of overtime — telling us will help whoever looks at it.",
        action: "Tell us why they differ",
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
        heading: "Don't send a payment yet",
        body: "Grander has your account and is finishing the setup. There's nothing to send yet — your first payment isn't due until November 1, and we'll show you where to send it well before then.",
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
        body: "$408,220 at 5.99%. Your next payment of $2,847 is due October 1, and Grander collects it. We re-check your rate against the market every month, and we'll put something here when it's worth your time.",
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
        body: "42 Oak Street at 6.875%. Another company handles your payments, not us — we check every month whether you could do better, and we'll say so here when you could. You can switch that off whenever you like.",
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
        body: "From January 1 your mortgage will be serviced by Cardinal Servicing instead of Grander. Your rate, your balance and your payment don't change. Keep paying Grander until December 31, then Cardinal. If you send Grander a payment by mistake in the first 60 days, it can't be charged a late fee or reported as late, as long as it arrives by its due date. The due dates themselves don't move.",
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
        body: "This mortgage was paid off on March 14, 2029 and the lien has been released. Nothing further is owed on it, and anything left in your escrow account comes back to you within 20 business days.",
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
        body: "This one was paid off on March 14, 2029 by the mortgage you refinanced into, which took your rate from 6.875% to 5.99%.",
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
        body: "Your mortgage moved to Cardinal Servicing on January 1, so you pay them now and your statements come from them. We can keep watching your rate if you want us to.",
        action: "Keep watching my rate",
      },
      {
        id: "loan_charged_off",
        pill: "Charged off",
        tone: "danger",
        terminal: true,
        meaning:
          "Terminal loss after foreclosure, short sale or deed in lieu. Different retention and reporting, and it starts the party's seasoning clocks.",
        heading: "Closed without being paid in full",
        body: "The property was sold in 2029 and this account was closed. If you're thinking about borrowing again, there are waiting periods, and how long depends on how this one ended. What that means for you is here.",
        action: "See where you stand",
      },
      {
        id: "loan_matured",
        pill: "Term ended",
        tone: "ok",
        terminal: true,
        meaning: "Term completed and satisfied.",
        heading: "You reached the end of the term",
        body: "The last payment was due October 1, 2055 and the mortgage is satisfied. The lien has been released, and anything left in your escrow account comes back to you within 20 business days.",
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
        tone: "neutral",
        terminal: false,
        meaning:
          "A monthly review found a material opportunity. Accepting creates a NEW application while the old loan keeps being paid — which is why the home screen has to hold more than one thing.",
        heading: "You could be paying about $240 less a month",
        body: "Your loan is at 6.875% and we'd quote around 5.99% today, on a fresh 30-year term. Part of that $240 is the lower rate and part is the term starting over, which is worth knowing before you count it all as money saved. That's worked out from your own loan's numbers and our current rate sheet — we haven't run your credit for it. It's an estimate, not an offer. Applying would take about ten minutes, and we'd reuse eleven things we already hold.",
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
        body: "Your bank needs you to sign in again, so we couldn't finish this month's check. This isn't a result — it's a check we weren't able to run, and we'd rather say that than show you a number we made up.",
        action: "Reconnect your bank",
      },
    ],
  },
] as const;

/** Flattened, for counting and for tests. */
export const ALL_STATES: readonly StateEntry[] = STATE_GROUPS.flatMap((g) => g.states);
