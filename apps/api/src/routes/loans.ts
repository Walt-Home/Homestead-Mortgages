/**
 * A mortgage, to the person it belongs to.
 *
 * The first loan route. It answers two things about one loan and keeps them
 * apart: what the servicer's tape last said about it — the newest
 * `servicing_observations` row, ours — and what the servicing platform has
 * concluded about it since, read live through the `servicing` port when the
 * servicer is wired that deep. The two are different sources with different
 * dates, and a card that blended them would show a balance from one beside
 * a verdict from the other as if they were one reading.
 *
 * Whose it is: `assertLoanAccess`, which answers a stranger and a loan that
 * does not exist in the same words. The live read is keyed on the servicer's
 * loan number and reaches nobody's person, which is why the port is
 * unguarded; this route is where "whose" is decided, and it is decided
 * before anything is asked.
 *
 * The live half never fails the card. A platform that is down or refuses is
 * reported as `unavailable` with its reason beside a card that still shows
 * the tape, because "we could not ask" and "there is nothing" are different
 * answers and the screen has to be able to say which.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "@hm/db";
import type { ServicingRecord } from "@hm/shared";
import { asyncRoute } from "../middleware/error-handler.js";
import { connectors } from "../services/connectors.js";
import { toDomainLoanState } from "../services/loan-transition.js";
import { assertLoanAccess } from "../services/loans.js";

export const loanRouter = Router();

/** `bigint` cents leave as decimal strings; nothing else changes. */
const jsonSafe = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;

/** The mortgages the signed-in person stands on, oldest first. Nobody else's, and nothing about the platform yet. */
loanRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const loans = await prisma.loan.findMany({
      where: { parties: { some: { party: { users: { some: { id: req.user!.id } } } } } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        servicerLoanNumber: true,
        noteRateBps: true,
        originalPrincipalCents: true,
        propertyLine1: true,
        propertyCity: true,
        propertyState: true,
        propertyPostalCode: true,
        servicer: { select: { slug: true, displayName: true, integrationDepth: true } },
      },
    });
    res.json(
      jsonSafe({
        loans: loans.map((l) => ({
          id: l.id,
          state: toDomainLoanState(l.status),
          servicerLoanNumber: l.servicerLoanNumber,
          servicer: l.servicer,
          noteRateBps: l.noteRateBps,
          originalPrincipalCents: l.originalPrincipalCents,
          property: {
            line1: l.propertyLine1,
            city: l.propertyCity,
            state: l.propertyState,
            postalCode: l.propertyPostalCode,
          },
        })),
      }),
    );
  }),
);

type Live =
  | {
      readonly status: "fetched";
      readonly provider: string;
      readonly retrievedAt: string;
      readonly record: ServicingRecord;
    }
  | { readonly status: "not_held" }
  | { readonly status: "not_wired"; readonly integrationDepth: string }
  | { readonly status: "unavailable"; readonly reason: string };

loanRouter.get(
  "/:id/servicing",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const loan = await assertLoanAccess(prisma, id, req.user!.id);

    const [servicer, observed] = await Promise.all([
      loan.servicerId
        ? prisma.servicer.findUnique({
            where: { id: loan.servicerId },
            select: { slug: true, displayName: true, integrationDepth: true },
          })
        : null,
      prisma.servicingObservation.findFirst({
        where: { loanId: loan.id },
        orderBy: [{ asOf: "desc" }, { recordedAt: "desc" }],
        select: {
          asOf: true,
          status: true,
          principalBalanceCents: true,
          escrowBalanceCents: true,
          scheduledPaymentCents: true,
          currentRatePct: true,
          nextPaymentDueOn: true,
          delinquencyDays: true,
          recordedAt: true,
        },
      }),
    ]);

    let live: Live;
    const wired =
      servicer !== null &&
      (servicer.integrationDepth === "API" || servicer.integrationDepth === "SUBSERVICED");
    if (!servicer || !loan.servicerLoanNumber || !wired) {
      live = { status: "not_wired", integrationDepth: servicer?.integrationDepth ?? "NONE" };
    } else {
      try {
        const port = connectors().servicing;
        // The id the row remembers is passed only when the platform that
        // minted it is the one the registry holds today; an id from another
        // provider is not a hint, it is a different system's name.
        const remembered =
          loan.servicingProvider === port.capabilities.provider && loan.servicingExternalId
            ? loan.servicingExternalId
            : undefined;
        const r = await port.fetchRecord({
          servicerSlug: servicer.slug,
          servicerLoanNumber: loan.servicerLoanNumber,
          ...(remembered ? { externalLoanId: remembered } : {}),
        });
        // Written behind the read, so the next one — and a batch — goes
        // straight to the id. A cache of a name, not a fact about the loan:
        // no ledger row, and nothing a persona's read-only session is
        // refused for, because nothing the person sees changes.
        if (
          r &&
          (loan.servicingProvider !== r.provider || loan.servicingExternalId !== r.externalId)
        ) {
          await prisma.loan.update({
            where: { id: loan.id },
            data: { servicingProvider: r.provider, servicingExternalId: r.externalId },
          });
        }
        live = r
          ? { status: "fetched", provider: r.provider, retrievedAt: r.retrievedAt, record: r.data }
          : { status: "not_held" };
      } catch (err) {
        live = { status: "unavailable", reason: err instanceof Error ? err.message : "unknown" };
      }
    }

    res.json(
      jsonSafe({
        loan: {
          id: loan.id,
          state: toDomainLoanState(loan.status),
          servicerLoanNumber: loan.servicerLoanNumber,
          noteRateBps: loan.noteRateBps,
          originalPrincipalCents: loan.originalPrincipalCents,
          property: {
            line1: loan.propertyLine1,
            city: loan.propertyCity,
            state: loan.propertyState,
            postalCode: loan.propertyPostalCode,
          },
        },
        servicer,
        observed: observed
          ? {
              ...observed,
              asOf: observed.asOf.toISOString().slice(0, 10),
              nextPaymentDueOn: observed.nextPaymentDueOn?.toISOString().slice(0, 10) ?? null,
              currentRatePct: observed.currentRatePct?.toFixed(3) ?? null,
            }
          : null,
        live,
      }),
    );
  }),
);
