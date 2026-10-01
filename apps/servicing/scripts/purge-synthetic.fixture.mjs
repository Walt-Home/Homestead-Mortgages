/**
 * The uploads a person makes, for purge-synthetic.test.mjs: written through his
 * runtime the way the console's tape desk writes them, never marked synthetic.
 *
 *   RX-…    a transfer batch boarded under the demo's own servicer numbers, so it
 *           reuses the seed's synthetic "Supermortgage" and transferor parties
 *   RANL-…  a partner book under a partner of its own
 *   RBNL-…  a partner book under the seed's FAKE demo partner, by name
 *
 * Both books are the demo book with new loan numbers and no MINs, so their
 * borrowers are the demo's borrowers again: the case of a real tape that names a
 * person the seed also made up.
 *
 * Run under type stripping (it imports his .ts): DATABASE_URL names the database.
 */

const src = new URL("../src/", import.meta.url).href;
const load = (path) => import(new URL(path, src).href);

const { connect } = await load("infra/db/client.ts");
const { loadOverriddenRegistry } = await load("domain/timer-overrides.ts");
const { loadConfig } = await load("runtime/config.ts");
const { createLogger } = await load("runtime/log.ts");
const { Runtime } = await load("runtime/app.ts");
const { boardTransferBatch } = await load("runtime/transfers.ts");
const { generateDemoBatch, DEMO_BATCH } = await load("domain/boarding/demo-batch.ts");
const { registerReprojectionReactor } = await load("domain/operations-runtime/installments.ts");
const { encodeTransferBatch } = await load("domain/boarding/tape-codec.ts");
const { importPartnerBook } = await load("runtime/partner-book.ts");
const { demoBook } = await load("domain/partner-book/fixtures/partner-book-demo.ts");
const { writeXlsx } = await load("infra/files/xlsx.ts");
const { loadDemoClock } = await load("runtime/demo-clock.ts");
const { buildPorts } = await load("domain/operations-runtime/posture-35-12/real-ports.ts");
const { rateFeedFromEnv } = await load("infra/integrations/rates.ts");
const { fakeReviewersFromEnv } = await load("infra/integrations/reviewers.ts");

const logger = createLogger("text");
const config = loadConfig();
const db = connect(config.databaseUrl);
const clock = await loadDemoClock(db, { logger });
const built = await buildPorts({
  integrations: config.integrations,
  environment: config.environment,
  db,
  logger,
});
const runtime = new Runtime({
  db,
  databaseUrl: config.databaseUrl,
  registry: loadOverriddenRegistry(),
  rateFeed: rateFeedFromEnv(process.env, logger),
  reviewers: fakeReviewersFromEnv(process.env, logger),
  logger,
  clock,
  environment: config.environment,
  env: process.env,
  ports: built.ports,
});
registerReprojectionReactor(runtime);
const person = { kind: "human", id: "ops@homestead.test" };

const batch = generateDemoBatch(777, {
  prefix: "RX",
  fnma_base: 4_400_000_000,
  min_sequence_base: 7_000_000,
});
const boarded = await boardTransferBatch(
  runtime,
  { ...DEMO_BATCH, batch_id: "B-REAL-TEST", seed: 777 },
  encodeTransferBatch(batch, batch.coborrowers),
  person,
  {},
);
console.log(`fixture batch ${boarded.status} ${boarded.loans.boarded}`);

function book(prefix) {
  const b = demoBook();
  const rows = b.tapeRows.map((r, i) =>
    i === 0
      ? r
      : r.map((v) =>
          typeof v === "string" && /^\d{18}$/.test(v)
            ? null
            : typeof v === "string" && /^[A-Z]{2}-\d+$/.test(v)
              ? `${prefix}${v}`
              : v,
        ),
  );
  const supplement = b.supplement.replace(/^([A-Z]{2}-\d+)/gm, `${prefix}$1`);
  return {
    tape: writeXlsx(rows, "M3"),
    supplement: new Uint8Array(Buffer.from(supplement, "utf8")),
  };
}
const partners = [
  ["RA", { legal_name: "Real Test Partner LLC", nmlsr_id: "445566" }],
  ["RB", { legal_name: "Partner Bank (FAKE demo)", nmlsr_id: "123456" }],
];
for (const [prefix, partner] of partners) {
  const b = book(prefix);
  const r = await importPartnerBook(
    runtime,
    {
      partner,
      as_of_date: "2026-09-15",
      profile: "m3-v1",
      tape: { filename: `${prefix}.xlsx`, content: b.tape },
      supplement: { filename: `${prefix}.csv`, content: b.supplement },
    },
    person,
  );
  console.log(`fixture book ${prefix} ${r.status} ${r.loans_created}`);
}
await db.end();
