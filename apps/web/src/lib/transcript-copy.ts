/**
 * The words on the tax-transcript branch.
 *
 * A catalog, like `outcomes.ts` and `home-copy.ts`, and it exists for the
 * reason those two do: these four sentences were literals inside
 * `ConnectPages.tsx`, where no rule could see them, and every one of them said
 * "your" about a retrieval the server resolves by name.
 *
 * Whose records this screen is about is the whole point of it. IRS Form 4506-C
 * names a single taxpayer, so a transcript pull is one person's — and while
 * "your" was unqualified the screen could be read as the household's on a
 * joint file. The branch is entered from a borrower's own screen and the pull
 * behind it is about the person who pressed it, which is what makes "your own"
 * true here rather than hopeful.
 *
 * Nothing below claims a vendor did anything. The IRS is not a vendor this
 * deployment may or may not have — it is who the form is addressed to, and
 * whether a transcript has actually been retrieved is said by the result block
 * rather than by these.
 */

export const TRANSCRIPT_COPY = {
  title: "Your tax transcripts",
  promise: "Two years of your own filed income, from the IRS directly.",
  detail:
    "This is the record every lender reconciles against. Having it now is what keeps a question from arriving three weeks before closing.",
  /**
   * What stands in the screen's place until the signature exists.
   *
   * It names the form as one taxpayer's, because the signature it asks for is
   * the reader's own and covers nothing of anybody else's on the file. A
   * borrower who signs here has authorized the release of their records and
   * not their co-borrower's, and the sentence that said only "authorized in
   * writing" left which of those it meant to the reader.
   */
  needsSignature:
    "The IRS will only release your transcripts to someone you have authorized in writing. Form 4506-C names one taxpayer, so it is yours to sign and it covers your records alone.",
} as const;
