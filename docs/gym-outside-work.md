# Outside work for the Gym

Drafts for Joe to send in week one of phase 0, from Building the Gym on
synthetic servicing data (22 October 2026) and What a subservicer holds
(`docs/subservicer-data.md`).

## 1. Questions for counsel

We are building synthetic mortgage-servicing data, a commercial product for
training and testing AI models, with no borrower's data and Fannie Mae
conventional loans only.

1. **Agency loan-level data.** May we fit our delinquency, cure, payoff and
   other rates to Fannie Mae's Single-Family Loan Performance data and Freddie
   Mac's Single-Family Loan-Level Dataset? As we read them, both allow internal
   use only; a product relying on them needs consent or a license, and Freddie
   Mac's costs $27,562.50 a term. Does it matter that only fitted rates would
   ship, never loan rows? On what terms?
2. **Freddie Mac PMMS.** We want to replay its 2016 to 2026 weekly rates as 2026
   to 2036, labeled as shifted. The terms require attribution and prohibit
   alteration. Is a labeled shift an alteration?
3. **OpenFEMA declarations.** We would use them for disaster timing by county
   and season. The terms allow use "solely for statistical research or as a
   reporting record." Does our use fit?
4. **Validation with a partner.** A partner would run our comparison on its real
   loans, in its own environment, returning only aggregates. How should the
   agreement limit it to checking, never training, and set retention and
   deletion? Who must consent? Fannie Mae owns the loan records (Selling Guide
   A2-4.1-02), and the master servicer signs Fannie Mae's Data Access
   Authorization (Form 101) with its subservicer (Servicing Guide A2-1-07). Is
   the partner's consent enough?
5. **AI voice as live contact.** Regulation X 1024.39(a) requires live contact
   with a delinquent borrower, or good-faith efforts, by day 36. Can a
   disclosed, two-way AI voice call with a human handoff count? Does it count as
   quality right party contact (Servicing Guide D2-2-01)? Our servicing app's
   spec counts it only in a sandbox until a legal opinion and the partner's
   sign-off are filed
   (`apps/servicing/spec/sections/11-early-intervention-collections/11-1-live-contact.md:54`,
   `:155`).

Joe

## 2. Scope for a compliance reviewer

We grade AI models on servicing tasks over synthetic Fannie Mae conventional
loans, and want a practitioner to check the clocks and call rubric we encode.
Paths are under `apps/servicing/src/domain/` and
`apps/servicing/spec/sections/`.

**The early-intervention clocks.** We will port the servicing app's windows
engine (`early-intervention/windows.ts`) and add rules beside it. Please check:

- 1024.39(a): live contact or good-faith efforts by day 36, again for each due
  date while delinquent (`windows.ts:22`, `:67`).
- 1024.39(b): a written notice by day 45, canceled by payment by then, at most
  once in 180 days (`windows.ts:22`, `:83`).
- The principal-residence scope, and the bankruptcy, cease and discharge
  exemptions (`windows.ts:70`, `:125`, `:134`, `:72`).
- 1024.40: personnel assigned by day 45
  (`4-3-continuity-of-contact-assigned-personnel.md:30`).
- D2-2-02: outbound attempts by day 36, then every 7 days, stopping 60 or 30
  days before a sale (`11-1-live-contact.md:42`; `plan.ts:17`).
- Regulation F, for a debt collector: the presumptions against more than 7 calls
  in 7 days, a call within 7 days after a conversation, and contact outside 8
  a.m. to 9 p.m. local (`11-1-live-contact.md:46`).
- Our policy inside those rules: a day-17 first attempt and a good-faith minimum
  (`plan.ts:16`; `11-1-live-contact.md:112`), and the spec's 24 test cases
  (`:181-204`).

**The call rubric** comes from the collections spec's per-call decision record
and guardrails (`11-1-live-contact.md:158`) and evaluation suites (`:56`). It
checks that:

- identity is verified before any account detail, and the AI, recording and
  debt-collection disclosures are made (`:148-150`);
- the pre-dial checks pass: consent, line type, time zone, the Regulation F
  count, and the cease, bankruptcy, attorney and military flags;
- the call records which options the borrower heard;
- there are no threats, no negotiation of modification terms, and at most one
  voicemail per number per 7 days.

We propose these fail a call outright: a disclosure to an unverified caller,
collection language during a bankruptcy stay, "this won't hurt your credit," a
complaint voiced and not logged, and a wrong amount.

**One more reading.** The servicing app's mortgage-insurance engine drops late
payments caused by a disaster, such as forbearance months, from the Homeowners
Protection Act payment-history test (`pmi/cancellation.ts:65`, `:133`). Is that
right?

**What we need signed.** A dated memo marking each clock and rubric item
correct, corrected or out of scope, saying whether the fail-outright list is
complete and our policy choices sit inside the rules. AI voice as live contact
is for counsel.

**Time.** Four to six days over four to six weeks: a kickoff, two days on the
clocks, two on the rubric and 20 graded transcripts, and a sign-off.

Joe

## 3. Request to partners

Our synthetic servicing data, for training and testing AI models, should look
like a real servicer's. Please send only material that holds no borrower's data;
where a document carries loan-level data, send the blank layout or leave it out.

- Data dictionaries for the tape and each extract.
- Transaction, comment, call disposition and call reason codes.
- The call QA scorecard and your complaint taxonomy.
- Letter and statement templates.
- Monthly oversight reports, such as MSP and P-195 delinquency reports.
- Policy pages on partials, suspense, cushions and spreading shortages.

We will use these only to shape and check our synthetic data. Any check against
real loans would be a separate agreement, run in your environment, returning
only aggregates. Tell us if any item needs an NDA first.

Joe
