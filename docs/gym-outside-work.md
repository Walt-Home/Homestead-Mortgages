# Outside work for the Gym

Drafts for Joe to send; none has been sent. They come from Building the Gym
on synthetic servicing data (22 October 2026) and What a subservicer holds
(`docs/subservicer-data.md`). Sections 1 and 3 were rewritten on 27 October
2026 for Putting Gym jobs in front of partners: no partner's data reaches a
model until counsel and the partner agree. The old question 4, validation
with a partner, is now counsel's questions 2 and 7. Replace [Name] before
sending.

## 1. Questions for counsel

**Subject:** Before a partner's loan data reaches an AI model: twelve questions

[Name],

We want your view before any partner's loan data reaches an AI model. The
first job we want to test reads the monthly loan tape a mortgage servicer
sends us and suggests problems for our staff to check before they load it. It
reviews 7 in 8 of our practice tapes fully right. Whether that holds on real
tapes is the next test, and it needs your answer first. Four questions held
over from our earlier list, on public data and AI voice calls, are at the end.

**What we would do**

- Our partners are mortgage servicers. Each sends a monthly tape of the loans
  it services: terms, balances, payment status, the property, one borrower's
  name. We read it to watch the loans and to offer refinances. No model reads
  it today.
- The model is DeepSeek-V4.1-Flash, an open model. Google's Vertex AI serves
  it as a managed service, called in our own Google Cloud project. The
  alternative is to run the open weights on our own machines in that project.
- The model would see the tape's cells, but no name, date of birth or e-mail
  address.
- It suggests. A staff member confirms or dismisses each finding and decides
  whether to load. It changes nothing and writes to nobody.
- We keep every run and every staff decision. We train no model on a
  partner's data.

**A partner's data and the model**

1. **Sending it.** May we send loan-level data from a partner's tape to a
   model Google hosts as a managed service, in our own project? Is it
   different if we run the model ourselves there? We have not reviewed
   Google's terms for this use. What must they say?
2. **Whose consent.** Fannie Mae owns the loan records (Selling Guide
   A2-4.1-02), and the master servicer signs Fannie Mae's Data Access
   Authorization (Form 101) with its subservicer (Servicing Guide A2-1-07).
   Is the partner's consent enough? Who else must agree when the partner is a
   subservicer, or when another investor owns the loans?
3. **Data we already hold.** We hold each partner's tapes to watch its book.
   Does sending what we already hold to a model need anything new?
4. **The agreement.** What must our agreement with a partner say: purpose, no
   training, security, retention, deletion, and who else handles the data?
5. **Records.** For each run we plan to keep the tape's digest, the model and
   prompt version, the tokens used, each suggestion, and each staff decision
   with name and time, never edited. What must we keep, for how long, and
   what must we not keep? May we keep the tape files for the test?
6. **A person approves.** Does a suggestion a staff member approves change
   anything: our liability, what we tell the partner or its borrowers, or
   how an examiner would see it?
7. **Testing on real data.** We first proposed that any check on real loans
   run in the partner's environment and return only aggregates. This test
   runs in ours, on tapes the partner already sends us. Is that acceptable?
   How should the agreement limit it to checking, never training?

**Calls and contact records**

8. **Recordings and transcripts.** Two later jobs read a partner's call
   recordings or transcripts, agent notes and contact logs. May a partner send
   them to us, and may a model read them? Must the recording notice the
   borrower heard cover us? Do states that require every party's consent to a
   recording change the answer?
9. **AI voice as live contact.** Regulation X 1024.39(a) requires live
   contact with a delinquent borrower, or good-faith efforts, by day 36. Can a
   disclosed, two-way AI voice call with a human handoff count? Does it count
   as quality right party contact (Servicing Guide D2-2-01)? Our servicing
   app's spec counts it only in a sandbox until a legal opinion and the
   partner's sign-off are filed.

**Public data for our synthetic loans**

10. **Agency loan-level data.** May we fit our delinquency, cure, payoff and
    other rates to Fannie Mae's Single-Family Loan Performance data and
    Freddie Mac's Single-Family Loan-Level Dataset? As we read them, both
    allow internal use only; a product relying on them needs consent or a
    license, and Freddie Mac's costs $27,562.50 a term. Does it matter that
    only fitted rates would ship, never loan rows? On what terms? We use
    neither today.
11. **Freddie Mac PMMS.** We use the 2016 to 2026 weekly rates as published,
    with attribution. We would like to replay them as 2026 to 2036, labeled as
    shifted. The terms prohibit alteration. Is a labeled shift an alteration?
12. **OpenFEMA declarations.** We now use them for disaster timing by month.
    The terms allow use "solely for statistical research or as a reporting
    record." Does our use fit?

**What we will and will not do with a partner's data**

- We will run the model only in our own Google Cloud project, only on data
  the partner sends us, and only after you and the partner agree.
- We will keep names, dates of birth and contact details from the model.
- We will not train any model on it, let the model act on a tape or a loan,
  or let it write to a partner or a homeowner.

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

**Subject:** Your OK to test a tape-review assistant, and a few files with no
borrower data

[Name],

We would like your OK to test an AI assistant on the monthly tapes you send
us. It helps our staff find problems in a tape before they load it: a renamed
column, dates or codes a spreadsheet changed, a month sent twice, a payment
that landed on the wrong loan. It reviews 7 in 8 of our practice tapes fully
right. The next test needs real tapes, which is why we ask now. We would run
it in shadow first: it reads and records, nobody acts on it, and we show you
the results before anything else. Separately, a few files with no borrower
data would help our practice data look like yours.

**The assistant**

1. **Your consent.** May we run it on your monthly tapes, in shadow first? Who
   on your side can agree in writing?
2. **Who owns the loans.** Which investors own the loans on your tapes? For
   Fannie Mae's, are you the master servicer or a subservicer? Fannie Mae owns
   its loan records, and a master servicer signs its Data Access Authorization
   (Form 101) with its subservicer, so the answer decides who else must
   agree.
3. **Your past tapes.** We keep what we read from each tape, not the file.
   Please resend the files of tapes you have sent, or let us keep copies,
   until the test ends. [Leave out for a partner that has not sent a tape.]
4. **Your habits.** What do your tapes do on purpose that could look like an
   error to us? For example, two-digit years, or one month sent as several
   files.
5. **A contact** who can answer questions about a tape during the test.

**Calls and contacts, for later**

6. Would you send call recordings or transcripts, agent notes, and contact
   logs: calls, letters, texts, e-mails, dialer attempts, promises to pay and
   complaints? In what form: recordings with the agent and the borrower on
   separate channels, or transcripts with speakers labeled; logs as files with
   their layout? How often? We would ask our counsel and yours first.

**Files with no borrower data**

7. Where a document carries loan-level data, send the blank layout or leave
   it out:
   - data dictionaries for the tape and each extract;
   - transaction, comment, call disposition and call reason codes;
   - the call QA scorecard and your complaint taxonomy;
   - letter and statement templates;
   - monthly oversight reports, such as MSP and P-195 delinquency reports;
   - policy pages on partials, suspense, cushions and spreading shortages.

   We will use these only to shape and check our synthetic data. Tell us if
   any of them needs an NDA first.

**What we will do with your data**

- Run the assistant only in our own Google Cloud project, on tapes you send.
- Keep borrower names, dates of birth and e-mail addresses from the model.
- Keep a record of every suggestion and every staff decision, and show you
  the results.
- Delete any file we keep for the test when it ends, or sooner if you ask.

**What we will not do**

- Train any model on your data.
- Let the assistant load, hold or change a tape or a loan, or write to you or
  a homeowner.
- Put your borrowers' data in our practice data, or show it to another
  partner.
- Start before our counsel and you have agreed.

A check of our synthetic data against your real loans would be a separate
agreement, run in your environment, returning only aggregates.

Joe
