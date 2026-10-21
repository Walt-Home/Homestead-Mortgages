# Testing on staging

The team's guide. Staging is public behind a Google sign-in, so **use test
data only**: no real Social Security number, no real ID, no real bank.

## Where

| What                 | Where                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ |
| The borrower app     | https://staging.app.supermortgage.com                                                |
| The ops console      | https://staging.servicing.supermortgage.com/console                                  |
| What is real today   | https://staging.app.supermortgage.com/api/health, under `providers`                  |
| The engine's view    | add `?debug=1` to any file URL (requirement ids, blocked roots; never for borrowers) |
| The property vendors | https://staging.app.supermortgage.com/demo/property, as anyone signed in             |

## Sign in

1. Any Google account.
2. At "Add a second step", type `000000`. On staging that passes with no
   authenticator app, and the screen says so. An authenticator app works too.
3. Sign in **as yourself** to walk the five screens. The sample borrowers on
   the sign-in page are read-only: good for looking at a state, no good for
   connecting anything.

## The five screens, with what to type

| Screen              | What to use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Property        | Any real US address. Autocomplete is Google, the record and the estimate are CoreLogic's. The flood zone is never determined.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2 · About you       | ID: Stripe's page runs in **test mode** and offers sample outcomes; pick the verified one, upload nothing real. The date of birth comes back only where `STRIPE_IDENTITY_RESULTS_KEY_SANDBOX` is set; elsewhere the screen asks for it, and `npm run identity:dob -- vs_...` says which. SSN: any nine digits, say `078-05-1120`. **Phone: a number that could ring, say `415-745-2130`.** A 555 number is refused later by Plaid, and the bank screen will send you back here to fix it. Citizenship, marital status, military service and language all start on "Choose one" and must be answered; a married person on a Texas, California or other community-property property is asked their spouse's name; the E-SIGN box starts unticked. |
| 3 · Your bank       | Plaid's sandbox, the consumer report. Press **Add new account**, search **First Platypus Bank**, pick the plain one, sign in as `user_bank_income` with password `{}` (the two braces). Confirm "Share your report". Do not pick the saved Tartan Bank account or `user_good`: both return Plaid's default data, which has no usable income.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4 · A few questions | Answer honestly for the person you are pretending to be. "I rent it" asks for the rent, and under it the bank's own figure appears as a line you can take with one tap or wave off ("Not my rent"): the w2 sandbox user shows $2,150 a month to OAKRIDGE PROPERTY MGMT. The field is never filled for you. Start a second application with the same sign-in and screen 1 offers the income you gave last time, and screen 2 the phone, the same way; the review screen shows the income you gave beside what your bank shows; "owned a home" asks two more.                                                                                                                                                                                     |
| 5 · Review          | Read the figures, sign once. The signature covers the application and the 4506-C, and the decision follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The bank screen's **income figure reads $0** on every real file, with a
caption saying what the report found. That is not the connection failing:
the engine counts only income whose continuance has been decided, and no
step decides it yet. Debt-to-income stays pending for the same reason, and
the decision ends **Referred**. That is the expected ending today.

## The property record, live

`/demo/property` is screen 1's lookup on its own: type an address, pick
the one Google offers, and read the county record and the estimate
CoreLogic answers, with the raw response beneath. It touches no file, so a
sample borrower's session can use it too.

- **Pick a real building.** Google also offers house numbers it has guessed
  between two it knows, and CoreLogic holds no record for those. "No record
  for that address" is a true answer, not a fault.
- A parcel that is not a home (an office, a monument) is refused rather than
  guessed onto an application, and the notice says so.
- The flood zone reads "not determined" everywhere. No flood vendor is wired.
- CoreLogic is on a trial key, about 100 records and 25 estimates a day for
  everyone together, so a lookup that stops answering late in the day is the
  cap.

## Plaid test users

Plaid's default user has no usable income. These three are ours, built for
what each screen asks, and each has been walked through Plaid Check and
the app. The files are in `data/plaid-sandbox-users/`.

| User            | Who they are                                                   | What the bank screen finds                                                                                |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `w2`            | Salaried, rents, one steady paycheck                           | $8,500/mo salary found, 13 months of rent at $2,150, a utility; income reads as verified, no payroll step |
| `gig`           | Drives for Uber and DoorDash, rents                            | Two gig streams found, about $3,800/mo together; estimated, so the payroll step appears                   |
| `large-deposit` | Salaried, rents, with $25,000 and $12,000 arriving unexplained | Salary found, and both deposits flagged as unsourced                                                      |

Two ways to use one, both at **First Platypus Bank** in Link:

- **Paste it.** Run `npm run plaid:sandbox-user w2` (or `gig`,
  `large-deposit`); it copies the user to your clipboard. In Link, the
  username is `user_custom` and the password is what you paste.
- **Save it once.** In Plaid's dashboard, Build → Sandbox → Users → Create,
  paste the file's contents and give it a username such as `user_sm_w2`.
  From then on that username with any password opens it, for everyone.

Plaid's own `user_bank_income` (password `{}`) is a fourth: three streams
of mixed income, good for a quick look.

## Co-borrowers

Name one on screen 2 with a **supermortgage.com or trywalt.ai** address.
The invitation is e-mailed; any other address is answered "not delivered",
because staging writes only to our own domains. The invitee takes the link
with their own Google sign-in, `000000` again, and walks their own half.

## The sample borrowers

Pick one on the sign-in page to see a state without walking to it.

| Sample              | What it shows                                                                   |
| ------------------- | ------------------------------------------------------------------------------- |
| Maya Okafor         | Stopped at the bank screen                                                      |
| Ben Castillo        | Bank connected, the work is ours                                                |
| Priya and Dev Raman | Two borrowers, approved with conditions; Dev's own sign-in is listed under hers |
| Tom Nguyen          | A counteroffer                                                                  |
| Aisha Bello         | Declined                                                                        |
| Grander import      | A watched mortgage from a servicer's tape, with a refinance offer on it         |
| Lena Fischer        | Withdrawn                                                                       |
| Marcus Hale         | Funded                                                                          |
| Omar Haddad         | On hold                                                                         |

Every write as a sample is refused, in the same words everywhere. If one
succeeds, that is the most important bug you can find.

## The console

An admin invites you from the console; your sign-in is a code to that
e-mail, then a password you set. The tape desk loads a servicer's book from
a spreadsheet and runs its first review; the servicers page manages a
servicer's team and billing. A servicer's own people sign in on the same
page and see the portal, never the console.

## The environments

The Supermortgage Gym, https://claude.ai/artifact/LKEDiyPJyoQ4UwijqwpNw6
(ask Joe to share it), is the training environments in a browser page. Pick
one, draw a training task, work it with the tools a model gets, and grade
your answer field by field against the engine. Then watch the reference
solve the same task, or read a model's recorded attempts. Every loan is
synthetic, held-out tasks are never shown, and nothing you type leaves the
page. Locally, `npm run env:gym -w @hm/environments` builds it and serves it
at http://localhost:8765.

If you and the engine disagree on a task, check the rulebook's wording
first. Then say which environment, the seed and index, and the field.

## What is real and what is made up

| Real on staging                                        | Made up (a fixture)                                       |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Sign-in, Google plus the second step                   | Credit: the "Sample credit · 742" banner                  |
| ID check, Stripe in test mode                          | Payroll: "confirm your employer" answers instantly        |
| Property: Google Places, CoreLogic record and estimate | IRS transcripts                                           |
| Bank: Plaid consumer report, sandbox                   | E-sign                                                    |
| Average prime offer rate, from the CFPB                | OFAC screening, lien search                               |
| Mail, Resend, to our own domains only                  | Pricing: every loan is quoted 6.25%                       |
| The servicing app and the daily review                 | Desktop Underwriter: the fixture answers, nothing is sent |
| Invoicing, Stripe sandbox                              | The flood determination                                   |

Every screen says which it is running against; the words "sample" and
"test mode" on a screen are these rows.

## When something looks wrong

Say which screen, what you typed, and what it said. The words are as much
under test as the code: if a sentence reads as a failure when it is not,
or promises something the table above says is made up, that is a bug.
