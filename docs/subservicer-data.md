# What a subservicer holds

A subservicer runs the system of record for the loans it services, so it holds
everything about them: every transaction, every call and letter, every
document, every outside feed, and every clock a regulation starts. This page
lists that data, says where each piece comes from, and marks how much of it
the servicing app models, our RL environments generate, and a partner's tape
gives us today. It is the reference for building synthetic data that looks
like a subservicer's, before we hold a real one.

It was written on 22 October 2026, after the sprint standup of that day asked
whether the Gym can be built correctly without a subservicer's data, and how
precise synthetic data would have to be. It draws on three kinds of source:

- **The rules.** Regulation X's servicing file (12 CFR 1024.38(c)(2)), Fannie
  Mae's guides on the loan file (Selling Guide A2-4.1) and on servicing
  transfers (Servicing Guide F-1-11), and the rules for each feed below. Each
  was fetched and read; the list of sources is at the end.
- **The servicing app's own model.** Its 177 migrations create 865 tables (862
  remain after migration 0134 drops three), servicing and origination
  together, and the servicing ones are catalogued here by domain. Its spec
  registers 322 notice codes, 248 of them in the servicing sections 1 to 19
  (`apps/servicing/spec/registry/notices.json`), and 2,097 timer rows covering
  1,824 distinct timers, 1,367 of the rows in the servicing sections
  (`spec/registry/timers.json`).
- **The servicing app's sample transfer.**
  `apps/servicing/fixtures/transfer-batch-demo` is a synthetic 100-loan
  servicing transfer with a column dictionary for the main tape that gives
  illustrative MISMO v3.6 paths (`LAYOUT.md`).

## The short version

- **The rules fix most of a subservicer's data.** Regulation X requires a
  servicer to keep five things that together make the servicing file: a
  schedule of every transaction, the security instrument, any notes its staff
  made of communications with the borrower, where applicable a report of the
  data fields its systems hold for the loan, and what the borrower sent about
  errors and loss mitigation. Fannie Mae's transfer rules list what moves with
  a loan when servicing changes hands. Both are public.
- **The servicing app models nearly all of it,** as tables and fake vendor
  connections. The gaps are narrower: no investor but Fannie Mae and private
  books, a sample transfer much thinner than Fannie Mae requires, and vendor
  file layouts of the servicing app's own design. Its runtime produces less:
  six of its cycles have no runner
  (`src/domain/operations-runtime/cycles.ts:285-286`, `:289-290`, `:294-295`),
  and a boarded loan gets no periodic statement, ARM change or Metro 2 record
  (statements-1, arm-15 and metro2-1 in docs/servicing-engine-defects.md).
- **Some things only a real subservicer can show:** its system's own field
  names and reports, how its staff write call notes, and how uneven its data
  really is. Some layouts are not public: Metro 2 (its guide goes only to
  eligible furnishers), MISMO's transfer dataset (licensed) and e-OSCAR's
  codes (registered furnishers only).
- **A partner's tape today carries a monthly snapshot,** not the history. It
  has seven servicing fields and 118 profiled tape columns, 110 of them kept,
  and no transaction, contact, letter or document.

## Where the data comes from

Every item below has one of four sources:

| Code | Source                                                                          | Example                                                        |
| ---- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| T    | Arrives with the servicing transfer: the boarding tape and the transfer package | Note terms, payment history, escrow lines, the images manifest |
| S    | Created while servicing the loan                                                | A receipt's allocation, a call note, a notice, a timer         |
| V    | Comes from an outside vendor or system                                          | A tax bill, a flood determination, a bankruptcy docket event   |
| D    | Derived from other records                                                      | The ledger, the installment schedule, a Metro 2 record         |

### The two data layers

The data rate card (Servicer Data Value / Rate Card v1, 21 October 2026)
splits a servicer's data into two layers, and the split matters for synthetic
data, because the second layer is the one no tape carries.

| Layer           | What it holds                                                                                                                               | Rate-card events in it                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Loan tape**   | The loan's terms, balances, status and pay history as of each month, as a servicer exports them                                             | A year of servicing history; an ARM adjustment or PMI cancellation; a payoff or refinance       |
| **Subservicer** | Everything that happened inside the servicing system: each transaction, contact, letter, request, workout, escrow analysis and vendor event | An escrow shortage or surplus; an inbound contact resolved; a payoff quote or retention contact |

## The data, domain by domain

Table names are the servicing app's, with the migration that creates them
(`0003` is `apps/servicing/db/migrations/0003_cashiering.sql`). "Key fields"
names the fields a synthetic loan has to get right, not every column. A
table here is one the servicing app models, not one its runtime always fills,
or fills correctly, for a boarded loan: nothing writes `payment_holds`
(cashiering-18), `arm_schedule` stays empty (arm-15), `regx_ei_windows` is
projected wrongly (ei-2), and the escrow-analysis, remittance and
custodial-reconciliation cycles have no runner
(`apps/servicing/src/domain/operations-runtime/cycles.ts:285`, `:289`, `:290`;
none is in `runners.ts:247-261`). Each ID is an entry in
docs/servicing-engine-defects.md.

### 1. Loan terms and identifiers

| What                | Key fields                                                                                                                                                               | Source       | Changes                                                                                                                               | Tables                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity and status | Fannie Mae, servicer and prior-servicer loan numbers, MIN and MERS registration, lien, status, boarding date, default status at boarding                                 | T, then S    | Status on life events                                                                                                                 | `loans` (0001)                                                               |
| Note terms          | Amortization, note rate, P&I, escrow payment, interest method, remittance type, late-charge percent, grace days and cap, remaining term, deferred and forborne principal | T, then S    | On an ARM change, modification, SCRA cap, recast or escrow change; a new row per change, the prior one closed by setting its end date | `loan_terms` (0001)                                                          |
| ARM terms           | Index, margin, initial, periodic and lifetime caps, floor, lookback, change dates, frequency, rounding, interest-only end                                                | T, V (index) | Each change date                                                                                                                      | `loan_terms`, `arm_schedule`, `arm_adjustments`, `arm_index_captures` (0009) |
| Schedule            | Each installment's due date, interest, principal, escrow and status                                                                                                      | D            | On every terms change                                                                                                                 | `loan_installments` (0003, 0142)                                             |
| Servicing settings  | Time zone, state, lockbox, channels, late-charge and NSF settings                                                                                                        | S            | Rarely                                                                                                                                | `loan_servicing_configs` (0142)                                              |

### 2. Parties, contact and consent

| What                       | Key fields                                                                                                                                                                                                                      | Source                                       | Changes                                                               | Tables                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Borrowers                  | Legal name, taxpayer number (encrypted, last four), date of birth, language, deceased date, SCRA status, role and whether primary                                                                                               | T                                            | Rare                                                                  | `borrowers`, `loan_borrowers` (0001)                                              |
| Other parties              | Successors in interest, authorized third parties, attorneys, housing counselors, with authorization documents, scope and expiry                                                                                                 | T, S                                         | Event-driven                                                          | `parties`, `loan_parties` (0001, 0005, 0013)                                      |
| Phones and addresses       | Number, line type, TCPA voice and text consent, workplace restrictions, inconvenient hours, do-not-call, bad-number count; e-mail addresses and mobile numbers with bounces; postal addresses are in the party's contact record | T, S, V (line type, reassigned-number check) | On contact                                                            | `phone_numbers` (0013), `delivery_addresses` (0009), `contact_preferences` (0013) |
| Consents                   | E-SIGN, TCPA voice and text, marketing, autopay, AI voice, language; where each came from, evidence, revocation                                                                                                                 | T (unverified), S                            | On capture or revocation                                              | `consents` (0001, 0009, 0112)                                                     |
| Successors and assumptions | Potential successor, transfer type, determination, assumption and release of liability                                                                                                                                          | T, S                                         | On death or transfer                                                  | `sii_cases`, `assumptions` (0005)                                                 |
| Military status            | Active duty, service dates, certificate, capped rate, protection end                                                                                                                                                            | T, V (DMDC), S                               | On request or orders                                                  | `scra_verifications`, `scra_cases`, `scra_rate_periods` (0015)                    |
| Fair-lending data          | Ethnicity, race, sex, age at application, language; restricted and access-logged                                                                                                                                                | T                                            | Rarely: a new version on correction, assumption or ownership transfer | `borrower_fair_lending` (0001), `restricted_fl.fair_lending_data` (0022)          |
| Marketing limits           | Suppressions and do-not-call scrubs                                                                                                                                                                                             | S, V                                         | On request; periodic                                                  | `marketing_suppressions`, `dnc_scrubs` (0076)                                     |

### 3. Property and collateral

| What                         | Key fields                                                                                                                              | Source | Changes                                                                                                                                                                     | Tables                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Property                     | Address, county, tax parcel, type, units, occupancy, flood zone                                                                         | T      | Occupancy on inspection                                                                                                                                                     | `properties` (0001, 0011)                                                                         |
| Flood                        | Determination vendor, zone, special flood hazard area, community, map panel and date, life-of-loan flag, required coverage; map changes | T, V   | On remapping                                                                                                                                                                | `flood_determinations`, `flood_map_changes` (0011)                                                |
| Inspections and preservation | Kind, dates, occupancy result, condition, photos, cost; vacancy, work orders, bids, registrations                                       | V, S   | Ordered from day 90 of delinquency and done by day 120, then monthly while 90+ days delinquent, except for occupied homes with recent contact, payment or a performing plan | `property_inspections`, `inspection_schedules`, `preservation_*`, `property_registrations` (0011) |
| Valuations                   | Value, kind, valid-until; scheduled and actual LTV                                                                                      | V, D   | On request; monthly LTV                                                                                                                                                     | `mi_valuations`, `mi_ltv_snapshots` (0012)                                                        |

### 4. Investor, pool and remittance

| What                        | Key fields                                                                                                                                                         | Source    | Changes                  | Tables                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Investor position           | Fannie Mae's last-paid-installment date, actual and scheduled UPB, non-interest-bearing balance, pass-through rate, note rate, P&I, remittance type, participation | T, V      | Monthly                  | `investor_loan_positions` (0006)                                                                                       |
| Loan activity reporting     | Event family and type, amounts, activity period, Fannie Mae's response                                                                                             | S, then V | Per transaction          | `investor_events` (0004, 0006)                                                                                         |
| Remittance                  | Prior UPB, interest and principal due, servicing fee, guarantee fee, collections, draft date, variance                                                             | S, V      | Monthly                  | `remittance_calculations`, `remittances`, `cash_positions`, `shortage_surplus` (0006)                                  |
| Advances                    | P&I, escrow and corporate advances, recoveries, stop-advance dates                                                                                                 | S         | Monthly while delinquent | `advances`, `advance_recoveries`, `sda_status` (0006), `servicer_advance_receivable` (0027)                            |
| Delinquency reporting       | Status and reason codes, forbearance type, imminent-default flag (Fannie Mae's monthly F-1-21 file, field for field)                                               | S, then V | Monthly                  | `delinquency_reports`, `delinquency_report_lines` (0006)                                                               |
| Custodial accounts and MERS | Account kind and last four, three-way reconciliation, subservicing arrangement; MIN snapshots naming servicer, subservicer, investor and note owner                | T, V      | Monthly or daily         | `custodial_accounts` (0001), `reconciliations` (0007), `subservicing_arrangements` (0021), `mers_min_snapshots` (0019) |

### 5. Payments and the ledger

| What                   | Key fields                                                                                                                                                                                                      | Source | Changes             | Tables                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Receipts               | Channel (lockbox, ACH, wire, portal, phone, card, bankruptcy trustee), instrument, amount, received and credited dates, designation, payer, bank last four, check and trace numbers, status, allocation outcome | S, V   | Every receipt       | `payments` (0003)                                                                                            |
| Allocation             | The installment each dollar went to, by bucket: interest, principal, escrow, late charge, NSF, fees, curtailment, suspense, deferred and forborne principal, advances                                           | S      | Every receipt       | `payment_allocations` (0003)                                                                                 |
| Reversals and returns  | Reason (returned item, misapplied, duplicate, servicer error, borrower request, court order), return code                                                                                                       | S, V   | On return           | `payment_reversals`, `ach_returns`, `ach_nocs` (0003)                                                        |
| Suspense               | Source, reason (partial, the $50 rule, unidentified, overpayment), aging, status                                                                                                                                | S      | Daily aging         | `suspense_items`, `suspense_actions` (0003)                                                                  |
| Fees                   | Late charge, NSF and other fees: assessed, grace end, waived, collected; counters of partials, 30-day lates and NSFs over 12 months                                                                             | S      | Monthly after grace | `fees`, `late_charge_suppressions`, `loan_counters` (0003)                                                   |
| Holds                  | Bankruptcy, post-referral foreclosure, error dispute, fraud, deceased estate, payoff pending, transfer cutover                                                                                                  | S      | On event            | `payment_holds` (0003)                                                                                       |
| Bank debit and lockbox | Enrollment and draft day; entry status and return code; lockbox batches, items, scanlines and match method                                                                                                      | S, V   | Daily files         | `autodraft_enrollments`, `ach_entries` (0003), `lockbox_batches`, `lockbox_items`, `ach_return_files` (0145) |
| The ledger             | Effective date, account (principal, deferred and forborne principal, interest due, escrow, escrow advance, corporate advance, late charges, suspense), amount, rule; append-only and balanced                   | D      | Every posting       | `ledger_entry_sets`, `ledger_lines` (0001), `ledger_accounts` (0024)                                         |

### 6. Escrow

| What                     | Key fields                                                                                                                                                                | Source                    | Changes                | Tables                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Account                  | Computation year, cushion, monthly escrow payment, shortage and deficiency installments                                                                                   | T, S                      | Annually               | `escrow_accounts` (0001, 0004)                                         |
| Lines                    | County, city, school and other taxes, hazard, flood, wind, earthquake, MI, HOA, ground rent; payee, annual amount, next due date, frequency, where the estimate came from | T, V                      | On a bill or renewal   | `escrow_lines` (0001, 0004)                                            |
| Bills                    | Tax year or policy term, installment, due, penalty and discount dates; delinquent taxes and tax-sale dates on non-escrowed loans                                          | V (tax service, carriers) | Per installment        | `escrow_bills`, `nonescrow_tax_checks` (0004)                          |
| Disbursements            | Payee, amount, due date, method, status, advance, check number, penalty                                                                                                   | S                         | On due dates           | `disbursements` (0004)                                                 |
| Analyses and statements  | Projection, low point, cushion, shortage, surplus, deficiency, new payment and its date; projected against actual                                                         | T, S                      | Each computation year  | `escrow_analyses`, `escrow_analysis_lines`, `escrow_statements` (0004) |
| Plans, waivers, interest | Shortage repayment, waivers, state-required interest and its 1099                                                                                                         | S                         | Annually or on request | `escrow_repayment_plans`, `escrow_waivers`, `escrow_interest_*` (0004) |

### 7. Delinquency and collections

| What                       | Key fields                                                                                                                                                                      | Source | Changes                 | Tables                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- | --------------------------------------------------------------------------------------- |
| Early-intervention windows | Live contact due by day 36, written notice by day 45, and whether each was met                                                                                                  | D      | Each delinquency        | `regx_ei_windows` (0013)                                                                |
| Contact attempts           | Planned attempts, cycle, good-faith effort, cease reason, callbacks                                                                                                             | S      | Daily while delinquent  | `contact_attempt_plans`, `good_faith_effort_records` (0013), `callback_requests` (0005) |
| Right-party contact        | Hardship reason (Fannie Mae's code), nature and dates, occupancy intent, ability to pay, stated income and expenses, when full payment resumes, what was committed, next action | S      | Per right-party contact | `qrpc_records` (0013)                                                                   |
| Promises to pay            | Amount, installments covered, due date, method, status                                                                                                                          | S      | Per promise             | `promises` (0013)                                                                       |
| Debt-collection law        | Debt-collector status, validation notice and dates, disputes, cease, attorney representation                                                                                    | T, S   | On boarding or contact  | `fdcpa_status`, `fdcpa_disputes`, `validation_notices` (0013)                           |
| Imminent default           | Hardship, reserves, Fannie Mae's decision; the solicitation package                                                                                                             | S, V   | On hardship             | `imminent_default_evaluations`, `solicitation_packages` (0013)                          |
| Monthly delinquency state  | Fannie Mae status, days delinquent, workout status, referral date, mark-to-market LTV, disaster flag                                                                            | D      | Monthly                 | `loan_delinquency_months` (0021)                                                        |

### 8. Communications

| What                                  | Key fields                                                                                                                                                                                                                    | Source | Changes           | Tables                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- | ------------------------------------------------------------------ |
| Calls, texts, e-mails, letters, chats | Direction, mode, time, result, whether live contact, the call note (narrative), transcript and recording, duration, language, the TCPA basis and quiet-hours check, AI and recording disclosures, agent, purpose; append-only | S      | Daily             | `contacts` (0005, 0013)                                            |
| Incoming mail and messages            | Channel, received date, the document, text, detected language, classification, the cases it opened                                                                                                                            | S      | Daily             | `inbound_communications` (0005)                                    |
| Notices                               | Template and version, recipients, address, payload, channel, status, sent date; delivery by mail or e-mail with tracking, opens and returns                                                                                   | S, V   | Per trigger       | `notices`, `notice_deliveries` (0009, 0164, 0166)                  |
| Statements and tax forms              | Monthly statement cycles and snapshots; 1098s; privacy notices                                                                                                                                                                | S      | Monthly; annually | `statement_cycles`, `statement_snapshots`, `tax_forms_1098` (0009) |
| Scripts and addresses                 | Call scripts; the designated address for errors and information requests                                                                                                                                                      | S      | Rarely            | `contact_scripts` (0043), `designated_addresses` (0005)            |

### 9. Requests, disputes and complaints

| What                   | Key fields                                                                                                                                                                                                                                  | Source         | Changes      | Tables                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ | --------------------------------------------------------------------- |
| Cases                  | Notice of error, request for information, qualified written request; received date and how, whether at the designated address, deadlines and extensions, determination, regulator and its due date, issue and sub-issue, root cause, remedy | S              | Event-driven | `cases` (0001, 0005), `case_assertions`, `case_request_items` (0005)  |
| Payoff requests        | Received date, channel, written or not, requester and authorization, good-through date, federal and state deadlines, every component of the quote                                                                                           | S              | On request   | `payoff_requests`, `payoff_statements` (0009), `payoff_quotes` (0018) |
| Credit and MI disputes | Dispute control number and codes; MI cancellation requests                                                                                                                                                                                  | S, V (e-OSCAR) | On request   | `credit_disputes` (0010), `mi_cases` (0012)                           |
| Complaints             | CFPB issue and sub-issue, uphold rate, remediation                                                                                                                                                                                          | S              | Monthly      | `complaint_taxonomy`, `complaint_analytics` (0005)                    |

### 10. Loss mitigation

| What                   | Key fields                                                                                                                              | Source | Changes              | Tables                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- | ------------------------------------------------------------------------------- |
| Applications           | Received, facially complete and complete dates, protection tier, acknowledgment, required documents, the prior servicer's received date | T, S   | Event-driven         | `lossmit_applications`, `lossmit_requirements` (0014)                           |
| Evaluations and offers | Hierarchy, option result, NPV inputs, terms, accept-by date, appeals; Fannie Mae's decision                                             | S, V   | Per application      | `lossmit_evaluations`, `lossmit_offers`, `lossmit_appeals`, `smdu_cases` (0014) |
| Workouts               | Forbearance and repayment plans, deferrals, modifications, trial plans and their payments                                               | T, S   | Monthly while active | `workout_plans`, `payment_deferrals`, `modifications`, `trial_plans` (0014)     |
| Liquidation            | Short sale offers and closings, deeds in lieu, dual-tracking holds                                                                      | S      | Per case             | `liquidation_cases`, `shortsale_*` (0014), `dil_cases` (0029)                   |

### 11. Bankruptcy, foreclosure and REO

| What           | Key fields                                                                                                                                                                                               | Source                         | Changes          | Tables                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| Bankruptcy     | Case number, chapter, petition date, trustee, attorney, 341 meeting, bar date, stay, plan, discharge or dismissal; docket events, proof of claim, pre- and post-petition ledgers, payment-change notices | T, V (court notices, PACER), S | Per docket event | `bankruptcy_*` (0016)                                                         |
| Foreclosure    | Firm, method, referral, first legal filing, judgment, sale scheduled and held, redemption; timeframes, delay credits, attorney invoices, litigation                                                      | T, V (attorney), S             | Milestone-driven | `foreclosure_*`, `attorney_referrals`, `sale_*` (0015)                        |
| REO and claims | Acquisition, deed, sale, expense claims, MI claim, liquidation                                                                                                                                           | S, V                           | Per case         | `reo_cases`, `expense_claims`, `mi_claims` (0017), `liquidation_facts` (0006) |

### 12. Credit reporting

| What                  | Key fields                                                                                                                                                                                                                                                            | Source | Changes                     | Tables                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| Metro 2 records       | Account status, payment rating, payment history profile, special comment, compliance condition, consumer information indicator, ECOA code, balance, amount past due, scheduled and actual payment, date of first delinquency, date of last payment, terms, K3, K4, L1 | D      | Monthly, as of the last day | `metro2_snapshots` (0010)                                                                 |
| Files and corrections | Cycles, files, bureau acknowledgments, overlays; corrections between cycles; disputes                                                                                                                                                                                 | S, V   | Monthly; on dispute         | `metro2_cycles`, `metro2_files`, `credit_reporting_corrections`, `eoscar_messages` (0010) |

### 13. Insurance and mortgage insurance

| What                              | Key fields                                                                                                                                                                               | Source                           | Changes                      | Tables                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Hazard and flood policies         | Kind, carrier, policy number, effective and expiration dates, coverage, deductible, premium, mortgagee clause; evidence and requirements                                                 | T, V (tracking vendor, carriers) | Annual renewal               | `insurance_policies`, `insurance_evidence`, `insurance_requirements` (0011)                      |
| Lapses and force-placed insurance | Deficiency, first and reminder notices, placement, charges, renewals, refunds                                                                                                            | S, V                             | On lapse                     | `insurance_deficiencies`, `fpi_cases`, `lpi_*` (0011)                                            |
| Claims                            | Loss date and cause, carrier claim number, proceeds held and released, repair inspections                                                                                                | V, S                             | On a loss                    | `insurance_claims`, `claim_disbursements` (0011)                                                 |
| Mortgage insurance                | Insurer, certificate, coverage, premium plan and rate, original value, scheduled 80% and 78% dates, midpoint; cancellation requests, terminations, disclosures, refunds, default reports | T, V, S                          | Monthly premium; fixed dates | `mi_policies`, `mi_schedules`, `mi_cases`, `mi_terminations` (0012), `mi_default_reports` (0036) |

### 14. Clocks and timers

| What                    | Key fields                                                                                                           | Source | Changes     | Tables                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ | ----------- | ----------------------------------------------------------------------------------- |
| Timers                  | Code, subject, anchor date, due date, status (armed, satisfied, breached, satisfied late, cancelled, needs a person) | D      | Daily sweep | `timers` (0001), `timer_definitions` (0026)                                         |
| Windows and escalations | Expected and due dates, breaches, state overlays, foreclosure timeframes, work items                                 | D      | Daily       | `case_milestone_expectations`, `breach_actions` (0210), `jurisdiction_rules` (0002) |

### 15. Documents

| What                 | Key fields                                                                                                                               | Source  | Changes              | Tables                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- | ----------------------------------------------------------------------------------- |
| Documents and images | Kind (note, mortgage, allonge, assignment, notice), hash, storage, who sent it, retention class, legal hold, pages, text                 | T, S, V | Append-only          | `documents` (0001 and later), `document_blobs` (0161), `document_access_log` (0162) |
| Custody              | Custodian, certification, where the note is; eNotes                                                                                      | T, V    | On release or return | `custody_records`, `enotes` (0019)                                                  |
| Retention            | Retention state, legal holds, data kept so the servicing file can be compiled within five days (for information from 10 January 2014 on) | D       | Continuous           | `record_objects`, `legal_holds`, `servicing_file_snapshots` (0022)                  |

### 16. Transfers

| What                  | Key fields                                                                                                                                                                                                              | Source | Changes           | Tables                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- | ------------------------------------------------------------------------ |
| The incoming transfer | Transfer type, sale, transfer and RESPA effective dates; files and their hashes; field mappings; data-quality results                                                                                                   | T      | Once per transfer | `transfer_batches`, `boarding_tapes`, `boarding_validations` (0002)      |
| The 60 days after     | The new servicer's notice within 15 days after (the old servicer's goes at least 15 days before), payments sent on time to the old servicer and forwarded, variances between the tape, the trial balance and Fannie Mae | S, V   | The 60-day window | `transfer_notice_runs`, `misdirected_payments`, `recon_variances` (0019) |
| The outgoing transfer | The servicing app's 34 deliverables, which cover F-1-11's 27 items and add tapes, images, consents and hand-off files; notices to outside parties                                                                       | S      | Once              | `transfer_out_deliverables`, `counterparty_notifications` (0019)         |

### 17. Audit and quality control

| What                 | Key fields                                                                                                  | Source | Changes           | Tables                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------ | ----------------- | -------------------------------------------------------------- |
| Events               | Type, time, who (kind, id, role), payload, cause; append-only                                               | S      | Every act         | `loan_events` (0001)                                           |
| Decisions and access | Rule, evidence, model and prompt version, approver; who read restricted data                                | S      | Continuous        | `agent_decisions`, `access_log` (0001), `staff_actions` (0127) |
| QC and exams         | Samples, findings, corrective actions, servicer performance metrics, fair-servicing results, OFAC screening | S      | Monthly to annual | `qc_*`, `exams` (0021), `fair_servicing_*` (0022)              |

## Outside feeds a subservicer receives

| Feed                         | What it carries                                                                                                                   | The rule behind it                                                                                                                                                                                                                                                            | In the servicing app                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Tax service                  | Tax bills, installments, due and penalty dates, delinquent taxes                                                                  | Servicing Guide B-1-01: pay before any penalty and keep accurate records                                                                                                                                                                                                      | Fake vendor with bills and delinquency search               |
| Flood                        | The standard determination form: zone, hazard area, community, map panel and date; map changes                                    | FEMA's form (OMB 1660-0040); Servicing Guide B-3-01: get coverage within 120 days of a remapping                                                                                                                                                                              | Fake vendor with determinations, monitoring and map changes |
| Insurance tracking           | Policies, expirations, evidence of coverage                                                                                       | Reg X 1024.37: notices before force-placing, cancel and refund within 15 days of proof                                                                                                                                                                                        | Fake tracking vendor                                        |
| Property inspections         | Occupancy, condition, vacancy certification                                                                                       | Servicing Guide D2-2-10: order from day 90, complete by day 120; then monthly, 20 to 35 days apart, while 90+ days delinquent, but not for an occupied home with contact or a full payment in the last 30 days or a performing plan; a final one within 35 days before a sale | Tables and schedule; no vendor connection                   |
| Bankruptcy                   | Case number, chapter, filing, dismissal and discharge dates; court notices                                                        | PACER's case search and the Bankruptcy Noticing Center                                                                                                                                                                                                                        | Fake PACER search and docket events                         |
| Military status              | Active duty on a date, left within 367 days, future call-up                                                                       | On a mortgage from before service: 50 USC 3937 caps interest at 6% during service and a year after; 3953 voids a sale or foreclosure in that time without a court order or the servicemember's waiver                                                                         | Fake DMDC lookup, single or batch                           |
| Credit bureaus               | Disputes (ACDVs) and the servicer's own corrections                                                                               | Servicing Guide C-4.1-01; FCRA 1681s-2(a)(2) (corrections) and 1681s-2(b) (disputes through a bureau)                                                                                                                                                                         | Fake e-OSCAR                                                |
| Bank debit and lockbox       | ACH entries, returns and change notices; lockbox batches                                                                          | Nacha's file format                                                                                                                                                                                                                                                           | Fake ACH, lockbox and bank-statement connections            |
| Fannie Mae (mostly outbound) | Sent: loan activity, monthly delinquency status, workouts, expense claims. Received: Fannie Mae's exception reports and decisions | Servicing Guide C-4.3-01 (loan activity), F-1-21 and D2-4-01 (delinquency status), F-1-22 and D2-4-02 (workouts), F-1-05 (expenses)                                                                                                                                           | Fake connections for each                                   |
| MERS                         | MIN registration and updates; the servicer and investor on record                                                                 | MERS member rules                                                                                                                                                                                                                                                             | MIN snapshots and transactions                              |

## What moves with a transfer, and what our sample has

Fannie Mae's Servicing Guide F-1-11 is the most complete public list of what a
servicer holds, because it is what the old servicer must hand the new one: tax
and flood service contracts; property-insurance and MI expiration dates and
premium frequencies; MI approvals and premium lists; bills unpaid at the
transfer; the bank-debit list; ARM details; **transaction and payment
histories for the life of each loan**; trial balances; custodial
reconciliations; three months of investor reports; ledger code definitions;
escrow analyses; delinquency and workout records, including modification
agreements; **customer correspondence, complaints and escalated cases**; title
policies; bankruptcy and foreclosure lists with each law firm; litigation;
address-confidentiality borrowers; and, for loans made from March 2023,
fair-lending data.

The servicing app's sample transfer has 12 files and falls short of that list
in at least these places:

- **Payment history covers 24 months, not the life of the loan** (99 loans at
  24 rows and one at 22, `src/domain/boarding/demo-batch.ts:149`). It has the
  date and amount received, but no fees, disbursements, advances, reversals or
  extra principal.
- **No correspondence file.** The boarding code accepts one
  (`boarding_tapes.kind` allows `correspondence`, migration 0002), but nothing
  reads it, so no prior call notes arrive.
- **No complaints, investor reports or ledger code definitions.**
- **No bank-debit list, custodial reconciliations or litigation records.** The
  boarding code accepts a `custodial_recon` file kind, but the sample has
  none.
- **The escrow analysis is a date and a balance,** not the analysis itself.
- **ARM details have no change frequency, floor or rounding**
  (`src/domain/boarding/tape-codec.ts:75-81`), and boarding drops the next
  change date the tape does carry (`src/runtime/transfers.ts:194-197`; arm-15
  in docs/servicing-engine-defects.md).
- **Loss mitigation is two columns,** the status and the date received, where
  Regulation X wants the state of the discussions and any agreements to move
  with the loan.
- **Tax and insurance arrive only as escrow lines** (an annual amount and a
  next due date). There is no tax-payment or delinquency status, no tax or
  flood service contract, and the hazard policy is one expiry-date column.

## What a partner sends us today

A partner's tape (`packages/shared/src/portfolio.ts` and the m3-v1 profile in
`packages/partner-book`) carries the loan-tape layer as of one month: parties
(one primary borrower's name, and a date of birth only when the supplement
carries one; no mailing address and no other parties), the property, the note
terms, a seven-field servicing snapshot (status, principal balance, escrow
balance, scheduled payment, current rate, next due date, days delinquent), and
up to 110 kept columns including pay strings, valuations, PMI fields,
foreclosure and bankruptcy flags and dates, and 12 months of cash flow. The
tape and the record contract have no field for a taxpayer number, phone or
e-mail. A partner's supplement file may carry them: the reader ignores them,
except that the tape desk uses the supplement's e-mail once, to mail the claim
link, and records where it went on the claim (`loan_claims.delivered_to`).
Columns marked as investor data stop at the profile. It carries none of the
subservicer layer: no transactions, contacts, letters, requests, escrow lines,
documents or timers. The last contact date and a contact-expected flag are the
only traces of a call.

## Where each domain stands

| Domain                       | Sample transfer                                               | Our environments generate                                                                                         | A partner's tape carries                                            |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Loan terms and identifiers   | Yes, but no ARM change frequency, floor or rounding           | Yes                                                                                                               | Yes                                                                 |
| Parties and contact          | Names, taxpayer number, phone, e-mail, consents, fair lending | Partly: Metro 2 consumer flags                                                                                    | One primary borrower's name; a date of birth from the supplement    |
| Property and collateral      | Address, occupancy, parcel and flood flags                    | Partly: value, type, occupancy                                                                                    | Address, county, type, occupancy and valuations; no parcel or flood |
| Investor and remittance      | Trial balance, Fannie Mae position, MERS                      | Partly: the payoff's split                                                                                        | Advance balances and accrued interest; investor columns dropped     |
| Payments and the ledger      | 24 months, installment level                                  | Yes, in short windows                                                                                             | A snapshot, pay strings, 12 months of cash flow                     |
| Escrow                       | Lines, balance, last analysis                                 | Yes                                                                                                               | Balance and advances                                                |
| Delinquency and collections  | Derived from history                                          | As an input only                                                                                                  | Days, status, last contact date                                     |
| Communications               | No                                                            | Notice dates only (Flex Mod, loss mitigation, ARM)                                                                | Last contact date and a contact-expected flag                       |
| Requests and disputes        | No                                                            | Payoff and MI requests only                                                                                       | No                                                                  |
| Loss mitigation              | Three loans in process                                        | Yes                                                                                                               | A modification flag                                                 |
| Bankruptcy, foreclosure, REO | Four loans                                                    | Referral and sale dates, deeds in lieu and short sales (Metro 2), a sale date (loss mitigation), holds (payments) | Flags and dates                                                     |
| Credit reporting             | No                                                            | Yes                                                                                                               | No                                                                  |
| Insurance and MI             | Expiry date, MI flag and certificate                          | MI yes; hazard and flood only as escrow premiums                                                                  | PMI fields                                                          |
| Clocks and timers            | Anchors only                                                  | Deadlines inside some environments                                                                                | No                                                                  |
| Documents                    | A manifest without files                                      | No                                                                                                                | No                                                                  |
| Transfers                    | Yes                                                           | The 60-day shield and a prior servicer's hand-off                                                                 | Status only                                                         |
| Audit and QC                 | No                                                            | No                                                                                                                | No                                                                  |

## What this means for synthetic data

The data falls into three kinds.

1. **Fixed by rule, so we can synthesize and grade it exactly.** The clocks in
   Regulation X (days 36, 45, 120; the 30-day evaluation; the 37, 45 and 90
   days before a sale), Fannie Mae's F-1-21 codes, the flood form, the PACER
   fields, the inspection intervals, the escrow arithmetic of 1024.17, the
   monthly statement's required items (Regulation Z 1026.41), and every figure
   the servicing app's engines compute.
2. **Public in meaning but not in layout.** Metro 2 (its guide goes only to
   eligible furnishers), MISMO's servicing transfer dataset (licensed) and
   e-OSCAR's codes (registered furnishers). We can synthesize to their public
   meaning, but should get the specifications before claiming our files match
   them. The DMDC military-status batch layout is free with an account on its
   site.
3. **Only a real subservicer can show it.** Its system's field names and
   reports (the subservicer-oversight presentation below mentions MSP and
   P-195 delinquency reports), how its staff write call notes, and how uneven
   its data is: missing fields, late files, codes used inconsistently. This
   needs a sample under terms counsel approves, used to check our synthetic
   data and never to train on.

A ten-year history of one loan needs only event types the servicing app
already stores: receipts by lockbox and bank debit, a bounced debit, late
charges, a missed payment and the early-intervention calls and letters that
follow, a borrower's call and its note, yearly escrow analyses and tax bills,
an insurance lapse, a flood remap, an ARM change, an error notice or
information request, a credit dispute, a bankruptcy, a military-status check,
inspections once 90 days delinquent, a loss-mitigation application and
modification, and a servicing transfer with its 60-day shield. The plan for
generating these histories is separate. Running the servicing app does not
produce one: nothing in its runtime acts as the borrower, so what the borrower
does has to be injected, and some of what the servicer does never comes on its
own. The yearly escrow analysis and the ARM change are cycles with no runner
(`src/domain/operations-runtime/cycles.ts:285`, `:294`; neither is in
`runners.ts:247-261`), and a boarded ARM has no change schedule for one to read
(arm-15 in docs/servicing-engine-defects.md).

## Gaps in the servicing app

- **Investors.** Only Fannie Mae and private books are modeled: the investor
  program list allows `fnma_mbs`, `fnma_portfolio`, two private kinds and
  `other` (migration 0021, `investor_programs`), and nothing in
  `src/domain/investor` mentions Freddie Mac. Freddie Mac, Ginnie Mae (FHA,
  VA, USDA) and their rules are absent, while a partner's tape can carry FHA,
  VA and USDA loans (the agency column itself is dropped at the profile).
- **The prior servicer's correspondence** is accepted as a file kind but never
  read.
- **HOA dues** are entered by hand; there is no feed.
- **Inspections** have tables and a schedule but no vendor connection.
- **Vendor layouts** are the servicing app's own design, not a real vendor's.
- **Six cycles have no runner:** the annual escrow analysis, daily loan
  activity reporting, remittance, custodial reconciliation, ARM changes and MI
  changes (`src/domain/operations-runtime/cycles.ts:285-286`, `:289-290`,
  `:294-295`; none is in the runner map, `runners.ts:247-261`), which the app
  marks as not landed (`cycles.ts:9-11`, `service.ts:96`). The month-end
  ledger close waits on the reconciliation (`cycles.ts:302`), so it is
  blocked too.
- **The runtime does less than the engines model.** For a boarded loan it
  opens no statement cycle (statements-1), writes no ARM schedule (arm-15),
  sets up no mortgage insurance policy, schedule or Homeowners Protection Act
  clock (pmi-15), links the borrower to no party, so no statement, Form 1098
  or Metro 2 record reaches them (boarding-2), and drops a joint loan's
  co-borrower (boarding-3). For every loan it never stops late charges in
  forbearance or bankruptcy (cashiering-18), takes a paid late charge again
  from later payments (cashiering-19), never ends a forbearance plan at its
  term (lossmit-1), leaves the loan out of every Metro 2 file (metro2-1), lets
  a paid installment's early-intervention clocks breach (ei-1), misstates the
  early-intervention windows (ei-2), quotes the borrower's own payoff requests
  from the wrong inputs (payoff-19), and cannot post a payoff or a ledger line
  over its HTTP tool routes (http-1). Each is in
  docs/servicing-engine-defects.md.

## Sources

Fetched and read on 22 October 2026, except where marked.

- **Regulation X:** 12 CFR 1024.17, .33, .35, .37, .38 (and its official
  interpretation), .39, .40, .41, at
  consumerfinance.gov/rules-policy/regulations/1024/. 1024.36 was not read.
- **Regulation Z:** 12 CFR 1026.41, the periodic statement.
- **Fannie Mae Selling Guide:** A2-4.1-01 (establishing loan files), A2-4.1-02
  (ownership and retention of loan files and records).
- **Fannie Mae Servicing Guide:** A2-1-07 (subservicing), A2-5-01, B-1-01
  (escrow), B-3-01 (flood), C-4.1-01 (credit reporting), C-4.3-01 (investor
  reporting), D2-2-01 and D2-2-02 (borrower contact), D2-2-10 (inspections),
  F-1-11 (servicing transfers), F-1-21 (delinquency reporting). D2-4-01,
  D2-4-02, F-1-05 and F-1-22 (delinquency, workout and expense reporting) are
  named from the Guide's table of contents and were not read.
- **MISMO:** the Servicing Transfer Catalog and the Loan Boarding Data Segment
  of the Industry Transfer of Servicing Dataset (pages read; field lists are
  licensed, to members through MISMO Connect and to others through MISMO's
  license form, and were not seen).
- **Subservicer Oversight: Managing Your Subservicer Relationship,** a
  presentation by the consulting firm Richey May (16 April 2019), hosted by
  the Federal Home Loan Bank of Des Moines. It describes practice, not a rule.
- **Flood:** FDIC FIL-53-95 and FEMA's 2023 notices renewing the standard form
  (OMB 1660-0040): 88 FR 37259 and 88 FR 66491.
- **Bankruptcy:** the PACER Case Locator API guide (November 2024) and the
  Bankruptcy Noticing Center.
- **Military status:** 50 USC 3937 and 3953. The DMDC certificate's fields
  were seen only in court filings and are unverified; its batch layout is
  documented to account holders.
- **Credit reporting:** FCRA 15 USC 1681s-2(a)(2) and (b), e-OSCAR, and CDIA's
  Metro 2 overview (the format guide itself goes only to eligible furnishers).
- **Bank debit:** Nacha's ACH file overview. Return and correction codes, and
  the BAI2 balance-reporting and BAI lockbox formats, were seen only in
  secondary sources.
- **MERS:** the General Member Guide (February 2019) and the ServicerID
  lookup.
- **Ours:** the Sprint Standup notes of 22 October 2026, and the Servicer Data
  Value / Rate Card v1 of 21 October 2026.
