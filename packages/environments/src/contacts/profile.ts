/**
 * Who a borrower is to the contact center, drawn once per loan from its own
 * stream: language, telephone numbers and their consents, e-mail and the
 * portal, a spouse who is not on the note, the last four of each taxpayer
 * number, and how the borrower talks on the phone. Every draw is made every
 * time, in one order, so a pin moves only what it names.
 *
 * Every share is a design choice with no public source, named here. The
 * one figure read off the history is debt-collector status: the FDCPA
 * reaches a servicer that obtained the loan when it was already in default,
 * read here as 30 or more days delinquent at the month-end before the
 * transfer.
 */

import { addMonths } from "@hm/kernel/calendar";
import type { LoanLife } from "../life/simulate.js";
import type { Rng } from "../rng.js";
import type { ContactProfile, PhoneOnFile, ProfilePins } from "./types.js";

/** Spanish as the borrower's language: more often with a Spanish surname, as a stand-in for the HMDA ethnicity field the draw lacks. */
const SPANISH_SHARE = 0.04;
const SPANISH_SHARE_HISPANIC_SURNAME = 0.4;
const HISPANIC_SURNAMES = new Set(["Garcia", "Martinez"]);
/** A second number on file, a third, and the chance one of them no longer works or now belongs to somebody else. */
const SECOND_PHONE_SHARE = 0.55;
const THIRD_PHONE_SHARE = 0.15;
const DISCONNECTED_SHARE = 0.07;
const REASSIGNED_SHARE = 0.05;
const MOBILE_SHARE = 0.75;
/** A mobile number given for the loan is consent to autodialed calls about it (FCC ACA ruling, 2008); some borrowers revoked it at origination. */
const VOICE_CONSENT_ON_MOBILE = 0.9;
const SMS_CONSENT_SHARE = 0.35;
const EMAIL_ON_FILE_SHARE = 0.85;
const PAPERLESS_SHARE_OF_EMAIL = 0.45;
const PORTAL_SHARE = 0.45;
/** A single borrower with a spouse who is not on the note, and the share of those who authorized the servicer to talk to them. */
const SPOUSE_SHARE = 0.35;
const SPOUSE_AUTHORIZED_SHARE = 0.3;
const STYLES: readonly (readonly [ContactProfile["style"], number])[] = [
  ["brief", 0.4],
  ["chatty", 0.3],
  ["anxious", 0.15],
  ["irritated", 0.15],
];
const SPOUSE_GIVEN = [
  "Chris",
  "Alex",
  "Jordan",
  "Sam",
  "Taylor",
  "Pat",
  "Robin",
  "Jamie",
  "Morgan",
  "Casey",
];
const MAIL_HOSTS = ["mail.example", "inbox.example", "post.example"];

const digits4 = (r: Rng) => String(r.int(0, 9999)).padStart(4, "0");

export function drawProfile(r: Rng, life: LoanLife, pins: ProfilePins = {}): ContactProfile {
  const d = life.draw;
  const b1 = d.parties[0]!;
  const uLang = r.next();
  const nPhones =
    1 + (r.chance(SECOND_PHONE_SHARE) ? 1 : 0) + (r.chance(THIRD_PHONE_SHARE) ? 1 : 0);
  const phoneDraws = [0, 1, 2].map(() => ({
    mobile: r.chance(MOBILE_SHARE),
    last4: digits4(r),
    uStatus: r.next(),
    voice: r.chance(VOICE_CONSENT_ON_MOBILE),
  }));
  const sms = r.chance(SMS_CONSENT_SHARE);
  const email = r.chance(EMAIL_ON_FILE_SHARE);
  const paperless = r.chance(PAPERLESS_SHARE_OF_EMAIL);
  const portal = r.chance(PORTAL_SHARE);
  const hasSpouse = r.chance(SPOUSE_SHARE);
  const spouseAuthorized = r.chance(SPOUSE_AUTHORIZED_SHARE);
  const spouseName = `${r.pick(SPOUSE_GIVEN)} ${b1.surname}`;
  const ssn = [digits4(r), digits4(r)];
  const style = r.weighted(STYLES);
  const host = r.pick(MAIL_HOSTS);

  const spanishShare = HISPANIC_SURNAMES.has(b1.surname)
    ? SPANISH_SHARE_HISPANIC_SURNAME
    : SPANISH_SHARE;
  const phones: PhoneOnFile[] = phoneDraws.slice(0, nPhones).map((p, i) => ({
    id: `${d.loan_id}-PH${i + 1}`,
    kind: p.mobile ? "mobile" : "landline",
    last4: p.last4,
    // The primary number always works; a later one may not.
    status:
      i === 0
        ? "good"
        : p.uStatus < DISCONNECTED_SHARE
          ? "disconnected"
          : p.uStatus < DISCONNECTED_SHARE + REASSIGNED_SHARE
            ? "reassigned"
            : "good",
    tcpa_voice: p.mobile && p.voice,
  }));
  const tin = life.transfer_in_on;
  const monthBefore = tin ? addMonths(tin, -1).slice(0, 7) : null;
  const atTransfer = monthBefore ? life.months.find((m) => m.month === monthBefore) : undefined;
  const single = d.parties.length === 1;
  return {
    language: pins.language ?? (uLang < spanishShare ? "es" : "en"),
    phones,
    sms_consent: pins.sms_consent ?? (sms && phones[0]!.kind === "mobile"),
    email_on_file: email,
    email: email ? `${b1.given_name.toLowerCase()}.${b1.surname.toLowerCase()}@${host}` : null,
    paperless: email && paperless,
    portal_user: pins.portal_user ?? (portal && email),
    spouse:
      pins.spouse !== undefined
        ? pins.spouse
        : single && hasSpouse
          ? { name: spouseName, authorized: spouseAuthorized }
          : null,
    ssn_last4: d.parties.map((_, i) => ssn[i]!),
    style,
    debt_collector: atTransfer !== undefined && atTransfer.days_delinquent >= 30,
  };
}
