# Outside work for the Gym

Drafts for Joe to send; none has been sent. They come from Building the Gym
on synthetic servicing data (22 October 2026) and What a subservicer holds
(`docs/subservicer-data.md`). Sections 1 and 3 were rewritten on 27 October
2026 for When our AI tools reach partners' loans: no partner's data reaches a
model until counsel and the partner agree. The old question 4, validation
with a partner, is now counsel's questions 2 and 7. Fill every bracket before
sending; the dates assume the e-mails go out on 2 November 2026.

## 1. Questions for counsel

**Subject:** Before a servicer's loan data reaches an AI model: twelve
questions

[Name],

We are Supermortgage, a trade name of Tomorrow OS Inc. Mortgage servicers,
our partners, send us a tape: a spreadsheet of the loans they service. We
watch those loans and offer the servicer's homeowners a refinance. [Attach
the partner agreement.]

We want your view before any partner's loan data reaches an AI model. The
first tool we want to test reads a partner's tape and suggests problems for
our staff to check before they add it to our records. We tested it on 200
synthetic tapes of made-up loans with planted problems. On 175 (7 in 8) it
found every problem and made the right call: add the tape, add it after a
correction, or hold it. A passing answer could also flag up to two things
beyond the planted problems. Whether that holds on real tapes is the next
test, and it needs your answer first.

Questions 1 to 7 decide that test, and we would like your answers by
[16 November]. Questions 8 to 12, on call records and the public data behind
our synthetic loans, can wait.

**What we would do**

- A tape carries each loan's number, terms, balances, rates, 12 months of
  payment history, the property address and the primary borrower's name. A
  partner may add a supplement with dates of birth and e-mail addresses. No
  model reads either today.
- The model is DeepSeek-V4.1-Flash, published by DeepSeek, a company based
  in China. Google serves it on Vertex AI as a managed model, and we would
  call it from our own Google Cloud project. Requests go to Google; nothing
  we run calls DeepSeek. Google's endpoint is global, not pinned to a U.S.
  region. Tell us if it must be.
- The other choice is to run an open model on servers in that project. The
  open weights we hold are an earlier release, DeepSeek-V4-Flash-0731, which
  we have not tested.
- The model would see the tape with the borrower's name masked: loan
  numbers, property addresses, balances, rates and payment history. It would
  never see the supplement.
- It suggests. A staff member confirms or dismisses each finding and decides
  whether to add the tape. The model changes nothing and writes to nobody.
  When it is wrong, it either misses a problem, which leaves the tape checked
  as it is today, by our software alone, or flags one that is not there,
  which staff dismiss.
- We keep a record of every run and every staff decision. We train no model
  on a partner's data.

**A partner's data and the model**

1. **Sending it.** May we send loan-level data from a partner's tape to a
   model Google hosts, called from our own project? Is it different if we
   run a model on our own servers there? We have not reviewed Google's terms
   for this use, including what Google may keep. What must they say?
2. **Whose consent.** Fannie Mae owns the loan records (Selling Guide
   A2-4.1-02). Its Servicing Guide (A2-1-07) has a master servicer and its
   subservicer execute a Data Access Authorization, Form 101, before the
   subservicer reaches Fannie Mae's systems for those loans. Is the partner's
   consent enough for our use? Who else must agree when the partner is a
   subservicer, or when another investor owns the loans?
3. **Data we already hold.** We keep the loan-level facts read from each
   partner's tapes, not the files, to watch its book and offer refinances.
   Is that nonpublic personal information under the Gramm-Leach-Bliley Act?
   If so, under which exception do we receive it today, and does sending it
   to a model Google hosts stay inside it?
4. **The agreement.** What must our agreement with a partner say: purpose,
   no training, security, retention, deletion, and who else handles the
   data?
5. **Records.** For each run we plan to keep a fingerprint (SHA-256) of the
   file, the model and the version of its instructions, how much text the
   model read and wrote, each suggestion, and each staff decision with name
   and time, never edited. These name loan numbers and cell values. What
   must we keep, for how long, and what must we not keep? May we keep the
   tape files for the test?
6. **A person approves.** Does a suggestion a staff member approves change
   anything: our liability, what we tell the partner or its borrowers, or
   how an examiner would see it?
7. **Testing on real data.** The test runs in our environment, on tapes the
   partner already sends us, not in the partner's environment. Is that
   acceptable? How should the agreement limit it to checking, never
   training?

**Calls and contact records**

8. **Recordings and transcripts.** Two later tools read a partner's call
   recordings or transcripts, agent notes and contact logs. May a partner
   send them to us, and may a model read them? Must the recording notice the
   borrower heard cover us? Do states that require every party's consent to
   a recording change the answer?
9. **AI voice as live contact.** Regulation X, 12 CFR 1024.39(a), requires
   live contact with a delinquent borrower, or good-faith efforts to reach
   one, by day 36. If we placed these calls for a servicer with a disclosed,
   two-way AI voice and a hand-off to a person, would they count as live
   contact, and as quality right party contact under Fannie Mae's Servicing
   Guide (D2-2-01)? What consent does the Telephone Consumer Protection Act
   require for an AI voice? Our servicing software's specification counts
   an AI call as live contact only in testing, until a written legal opinion
   and the servicer's sign-off are on file.

**Public data for our synthetic loans**

We also build synthetic servicing data, a commercial product for training
and testing AI models. None of a partner's loans goes into it.

10. **Agency loan-level data.** May we fit our delinquency, cure, payoff and
    other rates to Fannie Mae's Single-Family Loan Performance data and
    Freddie Mac's Single-Family Loan-Level Dataset? As we read their terms,
    both allow internal use only, and a product relying on them needs
    consent or a license. Does it matter that only fitted rates would ship,
    never loan rows? On what terms? We use neither today.
11. **Freddie Mac's weekly mortgage rates (PMMS).** We use the 2016 to 2026
    weekly rates as published, with attribution, as the terms allow. We
    would like to use the same rates, moved forward ten years, as the rates
    in a made-up 2026 to 2036 timeline, labeled as shifted. The terms
    prohibit alteration. Is a labeled shift an alteration?
12. **FEMA disaster declarations (OpenFEMA).** Since 23 October we have
    counted FEMA's declarations per month since 2016, to time disasters in
    the synthetic data. We cite the source and say FEMA does not endorse the
    product, as its terms ask. Does our use need anything more?

**What we will and will not do with a partner's data**

- Run the model only in our own Google Cloud project, only on tapes the
  partner sends us, and only after you and the partner agree.
- Mask the borrower's name before the model reads a tape, and never send it
  the supplement. It will see property addresses.
- Never train a model on it, let the model act on a tape or a loan, or let
  it write to a partner or a homeowner.

Joe Biggica
[Title], Supermortgage (Tomorrow OS Inc.)
[Phone]

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

**Subject:** Your OK to test a tape-review assistant, and some blank layouts

[Name],

We would like your OK to test an AI assistant on the tapes you send us. It
helps our staff find problems in a tape before they add it to our records: a
renamed column, dates or codes a spreadsheet changed, a month sent twice, or
a payment that may have posted to a neighboring loan number, which we would
ask you about. We tested it on 200 synthetic tapes of made-up loans with
planted problems. On 175 (7 in 8) it found every problem and made the right
call. The next test needs real tapes, which is why we ask now.

We would run it first in a trial where it only records and nobody acts on
it, and we would show you what it found on each of your tapes. Saying no
changes nothing about what we do for you today, and the test costs you
nothing [confirm].

**The assistant**

- The model is DeepSeek-V4.1-Flash, published by DeepSeek, a company based
  in China. Google hosts it on Vertex AI, and we call it from our own Google
  Cloud account. Requests go to Google; nothing we run calls DeepSeek. We are
  asking our counsel to review Google's terms, including what Google may
  keep.
- It would see your tape with the borrower's name masked: loan numbers,
  property addresses, balances, rates and payment history. It would never see
  your supplement with dates of birth and e-mail addresses.
- It suggests. Our staff confirm or dismiss each finding and decide whether
  to add your tape.

**What we ask**

1. **Your consent.** May we run it on your tapes, as a trial first? Who signs
   for this: legal, compliance or privacy? We will send them a one-page
   consent.
2. **Who owns the loans.** Who owns the loans on your tapes: Fannie Mae,
   Freddie Mac, Ginnie Mae or others? Where you subservice for another
   servicer, that servicer may need to agree too. Who is it?
3. **Your past tapes.** We don't keep your tape files, only what we read from
   them. For the test, please resend the files for [months] and let us keep
   them until the test ends on [date]. We delete them then. [Leave out for a
   partner that has not sent a tape.]
4. **Your habits.** How often do you send a tape, and as one file or several?
   What do your tapes do on purpose that could look like an error to us, such
   as two-digit years?
5. **A contact** who can answer questions about a tape during the test.

**How long, and what we keep.** The test runs [eight weeks] from your OK.
When it ends we delete your files. We keep the record of findings and staff
decisions, which names loan numbers and cell values, for [the period our
counsel sets].

**Blank layouts**

6. Our synthetic data is a commercial product, for training and testing AI
   models for servicing. Your documents would shape its layouts and rules.
   None of your data or documents would be in it, and we would not name you
   [confirm]. Where a document carries loan-level data, send the blank layout
   or leave it out:
   - data dictionaries for the tape and each extract;
   - transaction, comment, call disposition and call reason codes;
   - the call QA scorecard and your complaint taxonomy;
   - letter and statement templates;
   - monthly oversight reports from your servicing system (for example MSP's
     P-195);
   - policy pages on partials, suspense, cushions and spreading shortages.

   Send only what your system's vendor lets you share. Tell us if any of
   these needs an NDA first.

**For later; no answer needed now**

7. Would you send call recordings or transcripts, agent notes, and contact
   logs: calls, letters, texts, e-mails, dialer attempts, promises to pay and
   complaints? In what form: recordings with the agent and the borrower on
   separate channels, or transcripts with speakers labeled; logs as files
   with their layout? How often? We would ask our counsel and yours first.

**What we will and will not do with your data**

- Run the assistant only in our own Google Cloud account, on tapes you send,
  after our counsel and you have agreed.
- Mask borrower names before the model reads a tape, and never send it your
  supplement.
- Keep a record of every suggestion and staff decision, and show you the
  results.
- Never train a model on your data, let the assistant add, hold or change a
  tape or a loan, or let it write to you or a homeowner.
- Never put your borrowers' data in our synthetic data, or show it to
  another partner.

A check of our synthetic data against your real loans would be a separate
agreement, run in your environment, returning only totals, never a loan's
data.

Joe Biggica
[Title], Supermortgage (Tomorrow OS Inc.)
[Phone]
