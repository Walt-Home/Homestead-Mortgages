/**
 * Screen 1's retrieval, screen 2's screening, and the affordability gate.
 *
 * The four-screen flow's premise is that a borrower types six fields and we
 * fetch the rest. This module is "the rest": address autocomplete, the
 * assessor record, an AVM, a flood determination, OFAC and the lien search.
 *
 * Two of these run before any consent exists, and that is deliberate rather
 * than sloppy — see the guard commentary on the ports. The split is: anything
 * keyed on an *address* is unguarded, anything keyed on a *person* is not.
 *
 * Every retrieval writes an append-only snapshot, the same as the four
 * original connectors. Nothing here updates one.
 */

import { Router } from "express";
import { z } from "zod";
import { GUIDELINES, ESCROW_ASSUMPTION, monthlyPrincipalAndInterest } from "@hm/underwriting";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import {
  assertFileAccess,
  loadLoanFile,
  recordEvent,
  recordSnapshot,
} from "../services/repository.js";
import { AddressNotFoundError } from "@hm/connectors";
import { connectors } from "../services/connectors.js";
import { screenAndRecord } from "../services/screening.js";
import { tokenFor } from "../services/authorization.js";
import { prisma } from "@hm/db";
import { config } from "../config.js";

export const propertyRouter = Router();
export const propertyFileRouter = Router();

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().length(2),
  postalCode: z.string().min(5),
});

async function requireFile(id: string, userId: string) {
  await assertFileAccess(id, userId, "write");
  const file = await loadLoanFile(id);
  if (!file) throw new AppError(404, "Loan file not found", "NOT_FOUND");
  return file;
}

/* ── Autocomplete ───────────────────────────────────────────────────────── */

/**
 * Not file-scoped, because it runs while the borrower is typing the address
 * that will *create* the file. Still behind `requireAuth` — everything under
 * /api is.
 */
propertyRouter.get(
  "/suggest",
  asyncRoute(async (req, res) => {
    const query = z.string().max(200).catch("").parse(req.query.q);
    const suggestions = await connectors().propertyData.suggestAddresses(query);
    res.json({ suggestions });
  }),
);

/**
 * The assessor record for a candidate address, before a file exists.
 *
 * Screen 1 shows this as a confirmable summary card, so it has to be
 * retrievable at address-selection time rather than on submit — a card the
 * borrower is asked to confirm cannot arrive after the thing it confirms.
 */
propertyRouter.post(
  "/lookup",
  asyncRoute(async (req, res) => {
    const address = addressSchema.parse(req.body);
    const propertyData = connectors().propertyData;
    try {
      const [record, valuation, flood] = await Promise.all([
        propertyData.lookupRecord(address),
        propertyData.estimateValue(address),
        propertyData.determineFlood(address),
      ]);
      res.json({
        record: record.data,
        valuation: valuation.data,
        flood: flood.data,
        provider: record.provider,
      });
    } catch (err) {
      // Not an error the borrower caused, and not one that should stop them.
      // Screen 1 falls back to asking the two things the record would have
      // told us, and the flow continues.
      if (err instanceof AddressNotFoundError) {
        throw new AppError(404, err.message, "ADDRESS_NOT_FOUND");
      }
      throw err;
    }
  }),
);

/* ── The affordability gate ─────────────────────────────────────────────── */

const affordabilitySchema = z.object({
  valueOrPrice: z.number().positive(),
  downPayment: z.number().min(0),
  statedMonthlyIncome: z.number().positive(),
  occupancy: z
    .enum(["primary_residence", "second_home", "investment"])
    .default("primary_residence"),
  annualPropertyTax: z.number().min(0).optional(),
  monthlyAssociationDues: z.number().min(0).optional(),
});

/**
 * Screen 1's "before we spend money on a credit pull" check.
 *
 * This is NOT an underwriting decision and must never be rendered as one. It
 * runs on a stated, unverified income and a housing payment with no liabilities
 * in it, because on screen 1 there is no credit report — so the real DTI can
 * only be worse than this number, never better. That asymmetry is the whole
 * reason it is safe to stop someone here: a file this rejects cannot be
 * rescued by data we have not pulled yet.
 *
 * It reuses `monthlyPrincipalAndInterest` and `ESCROW_ASSUMPTION` from the
 * decision engine rather than restating them. Two formulas for one payment is
 * how a gate starts disagreeing with the decision it is gating.
 */
propertyRouter.post(
  "/affordability",
  asyncRoute(async (req, res) => {
    const input = affordabilitySchema.parse(req.body);
    const loanAmount = Math.max(0, input.valueOrPrice - input.downPayment);
    const ltv = input.valueOrPrice === 0 ? 0 : (loanAmount / input.valueOrPrice) * 100;

    const pi = monthlyPrincipalAndInterest(
      loanAmount,
      config.defaultProduct.noteRate,
      config.defaultProduct.termMonths,
    );
    const taxes =
      input.annualPropertyTax !== undefined
        ? input.annualPropertyTax / 12
        : (input.valueOrPrice * ESCROW_ASSUMPTION.annualTaxRate) / 12;
    const insurance = (input.valueOrPrice * ESCROW_ASSUMPTION.annualInsuranceRate) / 12;
    const dues = input.monthlyAssociationDues ?? 0;
    const housingPayment = pi + taxes + insurance + dues;

    // Front-end ratio only. There are no liabilities on screen 1, so this is a
    // floor on the real DTI, not an estimate of it.
    const housingRatio = (housingPayment / input.statedMonthlyIncome) * 100;

    const ltvCeiling =
      input.occupancy === "investment"
        ? GUIDELINES.ltv.purchaseInvestmentMax
        : input.occupancy === "second_home"
          ? GUIDELINES.ltv.purchaseSecondHomeMax
          : GUIDELINES.ltv.purchasePrimaryMax;

    // Two independent ways screen 1 can already be unworkable.
    const overLtv = ltv > ltvCeiling;
    // The housing payment alone exceeding the back-end maximum means no
    // liability schedule can save it. Anything short of that is not ours to
    // call yet.
    const overRatio = housingRatio > GUIDELINES.ratios.maxDtiBack;

    const verdict =
      overLtv || overRatio
        ? "unworkable"
        : housingRatio > GUIDELINES.ratios.dtiCautionThreshold
          ? "tight"
          : "workable";

    res.json({
      verdict,
      loanAmount: Math.round(loanAmount),
      ltv: Math.round(ltv * 100) / 100,
      ltvCeiling,
      estimatedMonthlyPayment: Math.round(housingPayment),
      housingRatio: Math.round(housingRatio * 100) / 100,
      reasons: [
        ...(overLtv
          ? [
              `A ${Math.round(ltv)}% loan-to-value is above the ${ltvCeiling}% maximum for this occupancy. A larger down payment changes this.`,
            ]
          : []),
        ...(overRatio
          ? [
              `The housing payment alone is about ${Math.round(housingRatio)}% of the income entered, before any other debts. The maximum is ${GUIDELINES.ratios.maxDtiBack}%.`,
            ]
          : []),
      ],
    });
  }),
);

/* ── File-scoped retrieval ──────────────────────────────────────────────── */

/**
 * Persist the screen-1 retrieval against the file.
 *
 * Split from `/lookup` on purpose: the lookup runs against a candidate address
 * with no file to write to, and this runs once the borrower has confirmed the
 * card and the file exists.
 */
propertyFileRouter.post(
  "/:id/property-data",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);
    if (!file.property) {
      throw new AppError(409, "This file has no property yet.", "NO_PROPERTY");
    }

    const propertyData = connectors().propertyData;
    const address = file.property.address;
    let record, valuation, flood;
    try {
      [record, valuation, flood] = await Promise.all([
        propertyData.lookupRecord(address),
        propertyData.estimateValue(address),
        propertyData.determineFlood(address),
      ]);
    } catch (err) {
      // A file on an address we hold no record for is a legitimate file. It
      // just carries no property snapshots, and screen 4's prior-ownership
      // declaration stays clean rather than being asserted from nothing.
      if (err instanceof AddressNotFoundError) {
        throw new AppError(404, err.message, "ADDRESS_NOT_FOUND");
      }
      throw err;
    }

    await recordSnapshot(
      id,
      "property_record",
      record.provider,
      record.externalId,
      record.data,
      record.retrievedAt,
    );
    await recordSnapshot(
      id,
      "valuation",
      valuation.provider,
      valuation.externalId,
      valuation.data,
      valuation.retrievedAt,
    );
    await recordSnapshot(
      id,
      "flood",
      flood.provider,
      flood.externalId,
      flood.data,
      flood.retrievedAt,
    );
    await recordEvent(
      id,
      "connector_pull",
      record.provider,
      { kind: "property_record" },
      "APP-004",
    );

    res.status(201).json({
      record: record.data,
      valuation: valuation.data,
      flood: flood.data,
    });
  }),
);

/**
 * OFAC/SDN screening (CRD-010).
 *
 * This replaces the inline `sanctionsScreenClear: true` the credit route used
 * to assert. Asserting a screen you did not run is worse than not screening —
 * it puts a true value in the field an auditor would check.
 */
propertyFileRouter.post(
  "/:id/screening",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    // The snapshot, the column, the event and the hold are one act, and they
    // live in a service rather than here so that anything else that screens a
    // person writes the same four things.
    const { screening } = await screenAndRecord(prisma, file, connectors());
    res.status(201).json({ screening });
  }),
);

/**
 * Ownership and encumbrance search, keyed on the APN from the assessor record.
 *
 * Returns 409 rather than searching on an empty APN — "no liens found" is the
 * most dangerous possible rendering of "we did not look".
 */
propertyFileRouter.post(
  "/:id/liens",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);
    const apn = z.string().min(1).safeParse(req.body?.apn);
    if (!apn.success) {
      throw new AppError(
        409,
        "A lien search needs the APN from the property record. Run the property lookup first.",
        "NO_APN",
      );
    }

    const result = await connectors().liens.searchLiens(
      file,
      await tokenFor(file, "public_record_liens"),
      apn.data,
    );
    await recordSnapshot(
      id,
      "lien_search",
      result.provider,
      result.externalId,
      result.data,
      result.retrievedAt,
    );
    await recordEvent(id, "connector_pull", result.provider, { kind: "lien_search" }, "UW-005");

    res.status(201).json({ liens: result.data });
  }),
);

/**
 * Read the document, before a borrower row exists.
 *
 * Joe's `/identity-verification` records a verification against a borrower,
 * which is the right shape for APP-001 — but screen 2 scans the ID *first* and
 * uses what is on it to fill in the name, date of birth and address, so there
 * is no borrower to attach it to yet. This reads the document for that
 * prefill; the verification proper is still recorded afterwards.
 *
 * Unguarded, like the property lookups: it runs before APP-005 exists, and
 * guarding it would make the authorization unobtainable.
 */
propertyFileRouter.post(
  "/:id/identity-document",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await requireFile(id, req.user!.id);

    const identity = connectors().identity;
    const session = await identity.createVerificationSession(file, "prefill");
    const result = await identity.getVerification(session.verificationId);

    /*
     * A hosted vendor cannot answer this synchronously, and treating that as a
     * failure made screen 2 impassable.
     *
     * Stripe returns "pending" the instant a session is created — the borrower
     * has not been to Stripe yet. The old code demanded "verified" here and
     * threw DOCUMENT_UNREADABLE otherwise, which under a real vendor fired
     * every single time: the scan never succeeded, `identity` was never set,
     * and the Continue button it gates stayed disabled forever. With the
     * fixture it never fired, because a fixture verifies in place.
     *
     * So: 202 and the URL, and the borrower goes and does the check.
     */
    if (!result || result.status !== "verified") {
      if (session.verificationUrl) {
        await prisma.loanFile.update({
          where: { id },
          data: { identityPrefillVerificationId: session.verificationId },
        });
        res.status(202).json({ requiresRedirect: true, verificationUrl: session.verificationUrl });
        return;
      }
      throw new AppError(422, "We could not read that document.", "DOCUMENT_UNREADABLE");
    }

    res.status(201).json({
      requiresRedirect: false,
      documentName: result.documentName ?? null,
      documentDateOfBirth: result.documentDateOfBirth ?? null,
      documentAddress: result.documentAddress ?? null,
    });
  }),
);

/**
 * What the borrower's trip to the vendor produced.
 *
 * Reads the session id from the FILE, never from the request. The client knows
 * its own verification id, but honouring one it sent would let any file owner
 * read the outputs of any verification whose id they could obtain — a document
 * name, date of birth and home address belonging to somebody else.
 *
 * Unguarded for the same reason as the scan above: it runs before APP-005.
 */
propertyFileRouter.post(
  "/:id/identity-document/complete",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // requireFile is the ownership check; the domain LoanFile it returns does
    // not carry storage-only columns, so the id comes from the row.
    await requireFile(id, req.user!.id);
    const row = await prisma.loanFile.findUnique({
      where: { id },
      select: { identityPrefillVerificationId: true },
    });

    const verificationId = row?.identityPrefillVerificationId;
    if (!verificationId) {
      throw new AppError(404, "No document check is in progress.", "NO_PREFILL");
    }

    const result = await connectors().identity.getVerification(verificationId);
    if (!result) throw new AppError(404, "That verification was not found.", "NOT_FOUND");

    // "pending" is a real answer, not a failure — Stripe reviews a document
    // asynchronously, so landing back here before a result exists is normal.
    res.json({
      status: result.status,
      documentName: result.documentName ?? null,
      documentDateOfBirth: result.documentDateOfBirth ?? null,
      documentAddress: result.documentAddress ?? null,
      failureReason: result.failureReason ?? null,
    });
  }),
);

/**
 * A borrower's disagreement with the county record.
 *
 * Recorded, not applied. The assessor's file is the system of record for
 * underwriting, and letting a borrower silently overwrite square footage or
 * year built would turn a retrieved fact into a self-reported one — which is
 * the entire thing screen 1 exists to avoid.
 *
 * So this writes a `FileEvent` for a human to look at and changes nothing the
 * engine reads. It must never block the flow: a wrong bedroom count is not a
 * reason to stop somebody getting a Loan Estimate.
 */
const correctionSchema = z.object({
  note: z.string().max(2000).optional(),
  corrections: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

propertyFileRouter.post(
  "/:id/property-correction",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = correctionSchema.parse(req.body);
    await requireFile(id, req.user!.id);

    if (!input.note && !input.corrections) {
      throw new AppError(400, "Nothing to record.", "EMPTY_CORRECTION");
    }

    await recordEvent(
      id,
      "property_correction_suggested",
      "borrower",
      { note: input.note ?? null, corrections: input.corrections ?? {} },
      "APP-004",
    );

    res.status(201).json({ recorded: true });
  }),
);
