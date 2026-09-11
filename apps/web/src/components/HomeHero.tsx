/**
 * The hero from supermortgage.com, on the public landing page and nowhere else.
 *
 * The headline and sub are Doug's, verbatim. It used to render for a signed-in
 * person too, over their own file collapsed into a summary in the smallest
 * type on the screen — so somebody coming back to find out whether they had
 * been approved was re-pitched instead. `/` now renders their application, and
 * the slot below stays a slot because the action is the one thing this
 * component never owned.
 *
 * **Do not put it back on the signed-in route.** The page that replaced it is
 * supposed to look bare: a person with nothing left to do should see a page
 * with nothing on it, not a promise of the greatest mortgage ever offered
 * under a pill saying their application was declined. `.super-cta` lost its
 * only consumer in this app with the same change and stays in the brand
 * package for the marketing surface it was drawn for.
 *
 * `flex-1` because this page sits inside the app shell's flex column: the hero
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
