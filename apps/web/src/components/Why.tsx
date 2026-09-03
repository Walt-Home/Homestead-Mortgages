/**
 * "Why do you need this?" — one line, collapsed.
 *
 * The old screens explained themselves in paragraphs the borrower had to read
 * past to reach the form. The explanation still has to be available, because
 * asking for a social security number without saying why is how you lose
 * people. It just does not get to be the first thing on the screen.
 *
 * A native <details> rather than a state-toggled div: it is keyboard
 * accessible, it works before hydration, and it is the element this is for.
 */

export function Why({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="super-link-quiet cursor-pointer list-none text-sm">
        Why do you need this?
      </summary>
      <p className="mt-2 max-w-measure-prose text-sm text-ink-soft">{children}</p>
    </details>
  );
}
