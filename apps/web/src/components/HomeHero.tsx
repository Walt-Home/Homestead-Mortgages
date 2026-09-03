/**
 * The hero from supermortgage.com, shared by the public landing page and the
 * signed-in front door.
 *
 * The headline and sub are Doug's, verbatim. What differs between the two
 * pages is only the action — a stranger signs in, somebody signed in starts an
 * application — so that is the slot and nothing else is duplicated.
 *
 * `flex-1` because both pages sit inside the app shell's flex column: the hero
 * absorbs the slack, which drops the street to just above the footer the way
 * the prototype does.
 */

export function HomeHero({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-9 px-6 py-16 text-center sm:py-24">
      <h1 className="super-h1 super-enter text-ink">The Greatest Mortgage Ever Offered</h1>

      {/*
        The prototype's sub ends in a "Learn more" link. Ours does not, yet.
        It pointed at /brand, which is the design-system reference — somebody
        who reads "lowest rates guaranteed" and clicks it lands on a color
        palette. The link comes back when there is a product page behind it.
      */}
      <p className="super-sub super-enter super-enter-1">
        Automatically refinances when interest rates drop, with lowest rates guaranteed.
      </p>

      <div className="super-enter super-enter-2 flex flex-col items-center gap-4">{children}</div>
    </section>
  );
}
