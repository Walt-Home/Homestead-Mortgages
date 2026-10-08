#!/usr/bin/env node
/**
 * Plaid sandbox users for the team to test with, as data.
 *
 * Plaid's default sandbox user has no usable income, so a walk on it ends
 * with nothing in the income tile. These three are custom users: a
 * configuration Plaid's sandbox turns into accounts and a year of
 * transactions, written so that Plaid Check finds what each is for — salary
 * lines read "EMPLOYER Direct Dep" and arrive as money in (negative, in
 * Plaid's sign convention), rent and utilities recur on the same day each
 * month, and `roll_dates_forward` keeps the newest line on the day the
 * account is linked, so the files never go stale.
 *
 *   node scripts/plaid-sandbox-users.mjs build     writes data/plaid-sandbox-users/*.json
 *   npm run plaid:sandbox-user w2                   prints one, and copies it on a Mac
 *
 * Two ways to use one in Link, at First Platypus Bank: paste the file's
 * contents as the password for the username `user_custom`; or save it once in
 * Plaid's dashboard (Build → Sandbox → Users → Create) under a username of
 * its own, after which that username with any password opens it. Each was
 * walked through Plaid Check and the adapter's mapping on 8 October 2026;
 * what each shows is in docs/testing.md.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../data/plaid-sandbox-users");

/** A date `daysAgo` before the anchor; the anchor is rolled forward by Plaid at link time. */
const ANCHOR = new Date("2026-10-08T00:00:00Z");
const day = (daysAgo) =>
  new Date(ANCHOR.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const tx = (daysAgo, amount, description) => ({
  date_transacted: day(daysAgo),
  date_posted: day(daysAgo),
  amount,
  description,
  currency: "USD",
});
/** One a month on about the same day, newest first. */
const monthly = (description, amount, months, start) =>
  Array.from({ length: months }, (_, m) => tx(start + 30 * m, amount, description));
/** Twice a month, the 3rd and the 18th or so. */
const semimonthly = (description, amount, months) =>
  Array.from({ length: months }, (_, m) => [
    tx(3 + 30 * m, amount, description),
    tx(18 + 30 * m, amount, description),
  ]).flat();
/** A deterministic wobble, so a gig payout varies the way a real one does. */
function wobble(seed) {
  let x = seed;
  return (lo, hi) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return Math.round((lo + (x / 2147483648) * (hi - lo)) * 100) / 100;
  };
}

const USERS = {
  /** A salaried renter: one steady paycheck, rent on time all year, a utility and a phone. */
  w2: {
    roll_dates_forward: true,
    override_accounts: [
      {
        type: "depository",
        subtype: "checking",
        starting_balance: 18400,
        currency: "USD",
        meta: {
          name: "Everyday Checking",
          official_name: "Northwind Everyday Checking",
          mask: "4412",
        },
        transactions: [
          ...semimonthly("NORTHWIND LABS Direct Dep", -4250, 13),
          ...monthly("OAKRIDGE PROPERTY MGMT RENT", 2150, 13, 2),
          ...monthly("PACIFIC GAS AND ELECTRIC", 142.17, 13, 9),
          ...monthly("VERIZON WIRELESS", 95, 13, 12),
          ...monthly("TRADER JOES", 184.36, 13, 15),
          ...monthly("TRANSFER TO SAVINGS", 1500, 13, 20),
        ],
      },
      {
        type: "depository",
        subtype: "savings",
        starting_balance: 62000,
        currency: "USD",
        meta: { name: "Savings", official_name: "High Yield Savings", mask: "7781" },
        transactions: [
          ...monthly("TRANSFER FROM CHECKING", -1500, 13, 20),
          ...monthly("INTEREST PAYMENT", -41.12, 13, 28),
        ],
      },
    ],
  },
  /** A gig earner who rents: two platforms paying weekly amounts that vary, rent, insurance, phone. */
  gig: (() => {
    const w = wobble(7);
    const payouts = [];
    for (let week = 0; week < 56; week++) {
      payouts.push(tx(2 + 7 * week, -w(520, 940), "UBER Direct Dep"));
      if (week % 2 === 0) payouts.push(tx(4 + 7 * week, -w(180, 420), "DOORDASH Direct Dep"));
    }
    return {
      roll_dates_forward: true,
      override_accounts: [
        {
          type: "depository",
          subtype: "checking",
          starting_balance: 3120,
          currency: "USD",
          meta: { name: "Checking", official_name: "Basic Checking", mask: "2210" },
          transactions: [
            ...payouts,
            ...monthly("CEDAR CREEK APARTMENTS RENT", 1850, 13, 1),
            ...monthly("T-MOBILE", 70, 13, 11),
            ...monthly("GEICO INSURANCE", 128.4, 13, 16),
          ],
        },
        {
          type: "depository",
          subtype: "savings",
          starting_balance: 4100,
          currency: "USD",
          meta: { name: "Savings", mask: "2211" },
          transactions: monthly("INTEREST PAYMENT", -3.1, 13, 28),
        },
      ],
    };
  })(),
  /** A salaried renter with two deposits nobody has explained: a mobile deposit and a Zelle from a person. */
  "large-deposit": {
    roll_dates_forward: true,
    override_accounts: [
      {
        type: "depository",
        subtype: "checking",
        starting_balance: 71250,
        currency: "USD",
        meta: { name: "Checking", official_name: "Premier Checking", mask: "9034" },
        transactions: [
          ...semimonthly("HARBORLIGHT MEDICAL Direct Dep", -5100, 13),
          ...monthly("WESTGATE REALTY RENT", 2400, 13, 2),
          ...monthly("CON EDISON", 168.9, 13, 8),
          tx(45, -25000, "MOBILE DEPOSIT"),
          tx(70, -12000, "ZELLE FROM MARGARET OKONKWO"),
        ],
      },
    ],
  },
};

const arg = process.argv[2];
if (arg === "build") {
  mkdirSync(dir, { recursive: true });
  for (const [name, user] of Object.entries(USERS)) {
    const text = JSON.stringify(user, null, 2) + "\n";
    writeFileSync(resolve(dir, `${name}.json`), text);
    const count = user.override_accounts.reduce((n, a) => n + (a.transactions?.length ?? 0), 0);
    console.log(
      `${name}: ${user.override_accounts.length} accounts, ${count} transactions, ${text.length} bytes`,
    );
  }
} else if (arg && Object.hasOwn(USERS, arg)) {
  const compact = JSON.stringify(JSON.parse(readFileSync(resolve(dir, `${arg}.json`), "utf8")));
  process.stdout.write(compact + "\n");
  if (process.platform === "darwin") {
    try {
      execFileSync("pbcopy", { input: compact });
      console.error(`copied: paste it as the password for user_custom at First Platypus Bank`);
    } catch {
      /* no clipboard; it was printed */
    }
  }
} else {
  console.error(`usage: plaid-sandbox-users.mjs build | ${Object.keys(USERS).join(" | ")}`);
  process.exit(2);
}
