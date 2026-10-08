# Testing on staging

The team's guide. Staging is public behind a Google sign-in, so **use test
data only**: no real Social Security number, no real ID, no real bank.

## Where

| What               | Where                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| The borrower app   | https://staging.app.supermortgage.com                                                |
| The ops console    | https://staging.servicing.supermortgage.com/console                                  |
| What is real today | https://staging.app.supermortgage.com/api/health, under `providers`                  |
| The engine's view  | add `?debug=1` to any file URL (requirement ids, blocked roots; never for borrowers) |

## Sign in

1. Any Google account.
2. At "Add a second step", type `000000`. On staging that passes with no
   authenticator app, and the screen says so. An authenticator app works too.
3. Sign in **as yourself** to walk the five screens. The sample borrowers on
   the sign-in page are read-only: good for looking at a state, no good for
   connecting anything.

## The five screens, with what to type

| Screen              | What to use                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Property        | Any real US address. Autocomplete is Google, the record and the estimate are CoreLogic's. The flood zone is never determined.                                                                                                                                                                                                                |
| 2 · About you       | ID: Stripe's page runs in **test mode** and offers sample outcomes; pick the verified one, upload nothing real. SSN: any nine digits, say `078-05-1120`. **Phone: a number that could ring, say `415-745-2130`.** A 555 number is refused later by Plaid, and the bank screen will send you back here to fix it.                             |
| 3 · A few questions | Answer honestly for the person you are pretending to be. "I rent it" asks for the rent; "owned a home" asks two more.                                                                                                                                                                                                                        |
| 4 · Your bank       | Plaid's sandbox, the consumer report. Press **Add new account**, search **First Platypus Bank**, pick the plain one, sign in as `user_bank_income` with password `{}` (the two braces). Confirm "Share your report". Do not pick the saved Tartan Bank account or `user_good`: both return Plaid's default data, which has no usable income. |
| 5 · Review          | Read the figures, sign once. The signature covers the application and the 4506-C, and the decision follows.                                                                                                                                                                                                                                  |

The bank screen's **income figure reads $0** on every real file, with a
caption saying what the report found. That is not the connection failing:
the engine counts only income whose continuance has been decided, and no
step decides it yet. Debt-to-income stays pending for the same reason, and
the decision ends **Referred**. That is the expected ending today.

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
