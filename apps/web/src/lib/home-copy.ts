/**
 * Borrower words that belong to more than one screen.
 *
 * Separate from `states.ts`, which is the state catalog and also the gallery's
 * source: its bodies carry invented figures to illustrate a state, so whether
 * a string there may reach a borrower is a question about that field. Every
 * string here renders, and `home-copy.test.ts` holds all of them to the five
 * copy rules at once — which makes it a question about the file instead.
 *
 * The sample-file refusal is the first thing in it because three screens
 * already said it: screen 2, the bank screen and every connector step each
 * wrote a sentence out for the same error code, and the connector's is already
 * a second wording of it — "so it can't be changed" against "so it is
 * read-only". That drift is the argument for the file. All three are here, the
 * two that share a sentence share it in code, and choosing one wording for all
 * three is a copy decision, not this one.
 *
 * Its session-level twin is `PERSONA_READ_ONLY` in `auth.tsx`, beside the
 * session it talks about, and it stays there: a refusal aimed at the account
 * rather than at the file is answered where the account is.
 *
 * Three screens say something similar to a sample borrower BEFORE they press
 * anything. Each one names the control it is talking about — nothing to
 * connect, nothing here that can be changed — so each stays on the screen that
 * knows which control that is. `home-copy.test.ts` pins the set to those
 * three, so a fourth screen writing one is a failure rather than a discovery.
 *
 * Two of the three stand in for a control that is never rendered: the
 * connector step and the bank screen both put the button behind `!readOnly`.
 * Screen 1 does not. It renders Continue and disables it, then prints the
 * sentence underneath — a full-contrast control that explains why it cannot be
 * pressed, which is the shape this pattern exists to avoid. It is named here
 * as the outstanding one rather than described as though it were fixed,
 * because making screen 1 obey the rule changes what a sample borrower sees
 * and is not this commit's to decide.
 */

/** What a person is told when the file they pressed a button on is a sample. */
export const SAMPLE_FILE = "This is a sample file, so it is read-only.";

/**
 * The same refusal where there is somewhere to go with it.
 *
 * Screen 2 is where a tester most often meets this, and it is the one screen
 * whose refusal can point at the thing that would work — a file of their own,
 * which every signed-in person who is not a sample borrower can start.
 */
export const SAMPLE_FILE_START_YOUR_OWN = `${SAMPLE_FILE} Start your own to walk the flow.`;

/**
 * The connector steps' wording of the same refusal, moved and not rewritten.
 *
 * It says the file cannot be CHANGED, which is the true thing about a button
 * that pulls a bank or an employer: the refusal is about the write, not about
 * what the tester may read. Whether that difference earns a second sentence is
 * a question somebody can now ask by reading one file.
 */
export const SAMPLE_FILE_CANNOT_CHANGE =
  "This is a sample file, so it can't be changed. Start your own to try this.";
