/**
 * What V1 underwrites, refused in the two routes that can be told otherwise.
 *
 * Conventional Fannie: a purchase, or a refinance that changes the rate or the
 * term and hands the borrower nothing. A cash-out refinance is out of scope —
 * later, not never — and until then nobody should be walked through a flow
 * whose end nobody intends to underwrite.
 *
 * There are three refusals and they are not redundant. `V1_LOAN_PURPOSES` in
 * `@hm/shared` is the list, screen 1 reads it so the choice is never offered,
 * this is what answers a request that arrives anyway, and `loan_files_v1_scope`
 * is what refuses the row however it got there. The database one is the
 * guarantee; this one exists so the answer is a sentence somebody can read
 * rather than a raw constraint violation, and so it arrives before an
 * application, a scenario and a rate quote have been written on the way.
 *
 * **The message is the borrower's**, and it is `CASH_OUT_NOT_YET` in
 * `@hm/shared` rather than a literal here, so the sentence the screen shows and
 * the sentence the route answers with cannot come apart.
 */

import { CASH_OUT_NOT_YET, isV1LoanPurpose, type LoanPurpose } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";

/** The code a client branches on, rather than parsing the sentence itself. */
export const OUT_OF_SCOPE_CODE = "LOAN_PURPOSE_OUT_OF_SCOPE";

/**
 * Refuse a purpose V1 does not underwrite.
 *
 * 422 and not 400: the request is well formed and the field holds a value the
 * column admits. What is wrong is the loan, and a client that re-sends it
 * unchanged gets the same answer.
 */
export function assertPurposeInScope(purpose: LoanPurpose): void {
  if (isV1LoanPurpose(purpose)) return;
  throw new AppError(422, CASH_OUT_NOT_YET, OUT_OF_SCOPE_CODE);
}
