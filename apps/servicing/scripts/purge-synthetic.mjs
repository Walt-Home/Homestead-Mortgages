/**
 * Remove what `seed-demo` put in a servicing database, and everything that grew
 * from it, while keeping every tape a person uploaded.
 *
 *   node scripts/run.mjs purge-synthetic            plan only: prints what would go, changes nothing
 *   node scripts/run.mjs purge-synthetic --apply    the same plan, then deletes it in one transaction
 *
 * Ours, beside his tree: nothing under src/ or db/ is edited. His schema is
 * append-only by trigger (`forbid_mutation` and friends raise on any DELETE),
 * and nothing in his runtime removes a loan, so this is the one place rows
 * leave. It refuses to run against ENVIRONMENT=production, where 35.12 rule 6
 * says no synthetic row exists to remove.
 *
 * What counts as seed (the roots):
 *   transfer_batches.synthetic                         the 100-loan demo batch (35.12 rule 6 marks it)
 *   partner_book_imports.actor_id ~ seed-demo          the twelve-loan demo book
 *   loans boarded by those, unless a real import also touched them
 *   entity_records written by seed-demo                the entry demo's FAKE licences, roster, programmes, cost schedules
 *   loan_events by the seed-demo actor                 the commands the seed ran
 *   partner_users the seed invited                     the demo partner portal's admin
 *   parties.synthetic                                  only once nothing real is left pointing at them (below)
 *
 * From the roots the plan follows every foreign key downward (a row whose
 * parent goes, goes), and the subject columns that are not foreign keys —
 * timers.subject_id, loan_events.aggregate_id, entity_records.loan_id and the
 * like — so the escalations, timers, work items, notices and decisions the sweep
 * raised over the demo loans go with them. It then takes the parents that only
 * the doomed rows used (the demo loans' properties, their documents).
 *
 * What it never takes: a loan that is not a seed loan, or any row whose loan_id
 * names one; a party that is not synthetic; a batch that is not synthetic; an
 * import that a person made. A synthetic party a real tape was loaded under (the
 * demo partner, "Supermortgage", a demo borrower a real tape names again) is kept
 * and reported. If following the keys from the seed roots would ever reach a
 * protected row, nothing is deleted and the run exits non-zero naming the table.
 *
 * It takes the locks a delete needs: the tables it deletes from are locked from
 * the moment their triggers are switched off until COMMIT, so the service waits
 * for the minutes the deletes take. A sweep that writes a new row against a
 * doomed loan between the plan and the deletes fails the run (a foreign key or a
 * serialization error), and nothing is deleted; run it again.
 *
 * Global run history — sweep_runs, cycle_runs, daily reports, the demo clock —
 * is kept unless a row names a doomed id: it is the record of the platform's
 * days, not sample data.
 */

import pg from "pg";

const SEED_ACTOR = "%seed-demo%";

/** The rows that must never be deleted, per table: a predicate over the table's own columns. */
const PROTECTED = {
  loans: "t.id NOT IN (SELECT s.id FROM _purge_seed_loans s)",
  parties: "NOT t.synthetic",
  transfer_batches: "NOT t.synthetic",
  partner_book_imports: `t.actor_id NOT LIKE '${SEED_ACTOR}'`,
};

/**
 * Parents a doomed row may leave behind with no one else pointing at them. Only
 * these tables: their rows exist for a loan and have no meaning without one.
 * Anything else a doomed row references (templates, depositories, the
 * Supermortgage LLC party the migrations write) is shared configuration.
 */
const ORPHAN_TABLES = [
  "properties",
  "documents",
  "document_blobs",
  "borrowers",
  "cases",
  "applications",
  "ledger_entry_sets",
];

/**
 * Rows of a loan-scoped table (one with a loan_id column) that belong to no loan
 * and name a doomed id only inside their payload: the commands the entry demo
 * ran, the pricing decisions over its FAKE rate sheet, the escalation over a
 * dead job whose unit was the demo's custodial account. Matched by the uuids and
 * record ids their whole row mentions. Tables without a loan_id (the daily
 * reports, the queue snapshots) are run history and are not read this way.
 */
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The columns that say what a row is ABOUT, read as references where they are not foreign keys: a row
 * whose subject goes, goes. Not every uuid column: cycle_runs.receipt_id points a shared daily run at its
 * summary, and a run that covered kept loans must not go with a receipt.
 */
const SUBJECT_COLUMNS = new Set([
  "loan_id",
  "application_id",
  "subject_id",
  "aggregate_id",
  "unit_id",
  "source_id",
  "entity_id",
  "party_id",
  "partner_id",
  "partner_party_id",
  "borrower_id",
  "holder_ref",
  "recipient_party_ids",
  "import_id",
  "batch_id",
  "job_id",
  "escalation_id",
  "timer_id",
  "work_item_id",
  "notice_id",
  "case_id",
  "custodial_account_id",
  "partner_user_id",
  "item_ids",
  "scope_key",
]);

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

export async function purgeSynthetic(client, { apply = false, log = console.log } = {}) {
  const env = process.env.ENVIRONMENT ?? "nonprod";
  if (env === "production")
    throw new Error("purge-synthetic: refusing to run with ENVIRONMENT=production");

  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    const meta = await loadMeta(client);
    const plan = new Planner(client, meta);
    await plan.init();

    // 1. The roots.
    await client.query(`CREATE TEMP TABLE _purge_seed_loans (id uuid PRIMARY KEY) ON COMMIT DROP`);
    await client.query(
      `
      INSERT INTO _purge_seed_loans
      SELECT tbl.loan_id FROM transfer_batch_loans tbl JOIN transfer_batches b ON b.id = tbl.batch_id
       WHERE b.synthetic AND tbl.loan_id IS NOT NULL
      UNION
      SELECT l.id FROM loans l JOIN transfer_batches b ON b.id = l.boarding_batch_id WHERE b.synthetic
      UNION
      SELECT f.loan_id FROM partner_book_facts f JOIN partner_book_imports i ON i.id = f.import_id
       WHERE i.actor_id LIKE $1 AND f.loan_id IS NOT NULL
      ON CONFLICT DO NOTHING`,
      [SEED_ACTOR],
    );
    // A seed loan a person's upload also carried (same servicer loan number, same partner) is theirs now.
    const shared = await client.query(
      `
      DELETE FROM _purge_seed_loans s USING (
        SELECT f.loan_id FROM partner_book_facts f JOIN partner_book_imports i ON i.id = f.import_id WHERE i.actor_id NOT LIKE $1
        UNION SELECT tbl.loan_id FROM transfer_batch_loans tbl JOIN transfer_batches b ON b.id = tbl.batch_id WHERE NOT b.synthetic
        UNION SELECT l.id FROM loans l JOIN transfer_batches b ON b.id = l.boarding_batch_id WHERE NOT b.synthetic
      ) r WHERE r.loan_id = s.id RETURNING s.id`,
      [SEED_ACTOR],
    );

    await plan.root("transfer_batches", "synthetic");
    await plan.root("partner_book_imports", `actor_id LIKE '${SEED_ACTOR}'`);
    await plan.root("loans", "id IN (SELECT id FROM _purge_seed_loans)");
    await plan.root("loan_events", `actor_id LIKE '${SEED_ACTOR}'`);
    await plan.root("partner_users", `invited_by_actor LIKE '${SEED_ACTOR}'`);
    await plan.root("agent_decisions", `approved_by LIKE '${SEED_ACTOR}'`);
    await plan.root(
      "entity_records",
      `updated_by LIKE '${SEED_ACTOR}' OR (kind, id) IN (SELECT kind, id FROM entity_records WHERE updated_by LIKE '${SEED_ACTOR}')`,
    );
    await plan.close();
    const breach = await plan.protectedHit();
    if (breach)
      throw new Error(
        `purge-synthetic: following the seed roots reaches a protected row in ${breach}; nothing deleted`,
      );

    // 2. Synthetic parties, in groups: a group goes if dooming it reaches nothing protected; a group that
    //    does is split in half until each party that a kept row depends on stands alone and is kept.
    const kept = [];
    const tryGroup = async (group) => {
      plan.commitSince(); // what exists now survives a rollback to this savepoint
      await client.query("SAVEPOINT party");
      await plan.root("parties", `id IN (${group.map((p) => `'${p.id}'`).join(", ")})`);
      await plan.close();
      const hit = await plan.protectedHit();
      if (!hit) {
        await client.query("RELEASE SAVEPOINT party");
        plan.commitSince();
        return true;
      }
      await client.query("ROLLBACK TO SAVEPOINT party");
      await client.query("RELEASE SAVEPOINT party");
      plan.forgetSince();
      if (group.length === 1) {
        kept.push({ ...group[0], reason: `a kept row in ${hit} depends on it` });
        return false;
      }
      const half = Math.ceil(group.length / 2);
      const a = await tryGroup(group.slice(0, half));
      const b = await tryGroup(group.slice(half));
      return a || b;
    };
    for (let round = 0; ; round++) {
      // A party kept once stays kept: what it was kept for (a real loan, a real batch) does not go.
      const candidates = (
        await client.query(
          `SELECT id::text, party_type::text, legal_name FROM parties p WHERE synthetic AND NOT ${plan.isDoomed("parties", "p")} ORDER BY party_type <> 'borrower', created_at`,
        )
      ).rows.filter((p) => !kept.some((k) => k.id === p.id));
      const progressed = candidates.length > 0 && (await tryGroup(candidates));
      // 3. Parents only the doomed rows used.
      const orphans = await plan.orphans(ORPHAN_TABLES);
      if (orphans) {
        await plan.close();
        const hit = await plan.protectedHit();
        if (hit)
          throw new Error(
            `purge-synthetic: an orphaned parent leads to a protected row in ${hit}; nothing deleted`,
          );
      }
      if (!progressed && !orphans) break;
      if (round > 20) throw new Error("purge-synthetic: the plan did not settle in 20 rounds");
    }

    const counts = await plan.counts();
    const total = counts.reduce((n, c) => n + c.rows, 0);
    log(`purge-synthetic ${apply ? "apply" : "plan"}: ${total} rows in ${counts.length} tables`);
    for (const c of counts) log(`  ${c.table.padEnd(40)} ${c.rows}`);
    for (const id of shared.rows) log(`kept loan ${id.id}: a person's upload also carries it`);
    for (const p of kept) log(`kept party ${p.id} (${p.party_type}, ${p.legal_name}): ${p.reason}`);

    if (!apply) {
      await client.query("ROLLBACK");
      log("purge-synthetic: plan only, nothing changed (pass --apply to delete)");
      return { applied: false, total, counts, kept, shared: shared.rows.length };
    }

    await plan.delete();
    await client.query("COMMIT");
    log(`purge-synthetic: deleted ${total} rows`);
    return { applied: true, total, counts, kept, shared: shared.rows.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

async function loadMeta(client) {
  const tables = (
    await client.query(`
    SELECT c.oid::int AS oid, c.relname AS name
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition`)
  ).rows;
  const fks = (
    await client.query(`
    SELECT c.conrelid::int AS child, c.confrelid::int AS parent,
           array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ccols,
           array(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS pcols
      FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)
  ).rows;
  const cols = (
    await client.query(`
    SELECT a.attrelid::int AS oid, a.attname AS name, format_type(a.atttypid, NULL) AS type, a.attnotnull AS notnull
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`)
  ).rows;
  const pks = (
    await client.query(`
    SELECT i.indrelid::int AS oid, a.attname AS name, format_type(a.atttypid, NULL) AS type
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      JOIN pg_class c ON c.oid = i.indrelid
     WHERE i.indisprimary AND i.indnatts = 1 AND c.relnamespace = 'public'::regnamespace`)
  ).rows;
  const byOid = new Map(tables.map((t) => [t.oid, t.name]));
  const fkCols = new Set(fks.flatMap((f) => f.ccols.map((c) => `${f.child}.${c}`)));
  // A row's own `id` is never read this way: entity_records keys the demo partner's configuration by the
  // party's uuid (`partners/<party id>`), and that must not make the party itself a seed row.
  const soft = cols.filter(
    (c) =>
      byOid.has(c.oid) &&
      SUBJECT_COLUMNS.has(c.name) &&
      !fkCols.has(`${c.oid}.${c.name}`) &&
      ["uuid", "uuid[]", "text", "text[]"].includes(c.type),
  );
  const notNull = new Set(cols.filter((c) => c.notnull).map((c) => `${c.oid}.${c.name}`));
  for (const f of fks) f.nullable = f.ccols.every((c) => !notNull.has(`${f.child}.${c}`));
  const loanScoped = [
    ...new Set(cols.filter((c) => c.name === "loan_id" && byOid.has(c.oid)).map((c) => c.oid)),
  ].map((oid) => ({
    oid,
    application: cols.some((c) => c.oid === oid && c.name === "application_id"),
  }));
  return {
    loanScoped,
    byOid,
    oidOf: new Map(tables.map((t) => [t.name, t.oid])),
    fks: fks.filter((f) => byOid.has(f.child) && byOid.has(f.parent)),
    soft,
    pk: new Map(pks.filter((p) => byOid.has(p.oid)).map((p) => [p.oid, p])),
  };
}

/**
 * The doomed rows, per table, as ctids in a temp table of their own. Inside one
 * REPEATABLE READ transaction that deletes nothing until the end, a ctid names
 * one row for the whole plan.
 */
class Planner {
  constructor(client, meta) {
    this.c = client;
    this.m = meta;
    this.made = new Set();
    this.pending = new Set();
    this.dirty = new Set();
    this.ids = -1;
  }
  async init() {
    await this.c.query(`CREATE TEMP TABLE _purge_ids (v text PRIMARY KEY) ON COMMIT DROP`);
    // The ids each loan-less row of a loan-scoped table mentions, read once: the rows do not move until the deletes.
    await this.c.query(
      `CREATE TEMP TABLE _purge_mentions (oid int, rid tid, v text) ON COMMIT DROP`,
    );
    for (const { oid, application } of this.m.loanScoped) {
      await this.c
        .query(`INSERT INTO _purge_mentions SELECT DISTINCT ${oid}, t.ctid, trim(both '"' from m[1]) FROM ${qi(this.m.byOid.get(oid))} t,
        regexp_matches(to_jsonb(t)::text, '${UUID_RE}|"[A-Za-z]+-[A-Za-z0-9.-]+"', 'g') m WHERE t.loan_id IS NULL${application ? " AND t.application_id IS NULL" : ""}`);
    }
    await this.c.query(`CREATE INDEX ON _purge_mentions (v)`);
    await this.c.query(
      `CREATE TEMP TABLE _purge_er_mentions (kind text, id text, v text) ON COMMIT DROP`,
    );
    if (this.m.oidOf.has("entity_records")) {
      await this.c
        .query(`INSERT INTO _purge_er_mentions SELECT DISTINCT e.kind, e.id, kv.value FROM entity_records e,
        jsonb_each_text(CASE WHEN jsonb_typeof(e.data) = 'object' THEN e.data ELSE '{}'::jsonb END) kv WHERE length(kv.value) BETWEEN 8 AND 64`);
      await this.c.query(`CREATE INDEX ON _purge_er_mentions (v)`);
    }
  }
  d(oid) {
    return `_purge_d_${oid}`;
  }
  async ensure(oid) {
    if (this.made.has(oid)) return;
    await this.c.query(`CREATE TEMP TABLE ${this.d(oid)} (rid tid PRIMARY KEY) ON COMMIT DROP`);
    this.made.add(oid);
    this.pending.add(oid);
  }
  /** Temp tables made since the last savepoint vanish on rollback; forget them too. */
  forgetSince() {
    for (const oid of this.pending) this.made.delete(oid);
    this.pending.clear();
    this.dirty = new Set();
    this.ids = -1;
  }
  softByTable() {
    if (!this.soft) {
      this.soft = new Map();
      for (const s of this.m.soft) this.soft.set(s.oid, [...(this.soft.get(s.oid) ?? []), s]);
    }
    return this.soft;
  }
  commitSince() {
    this.pending.clear();
  }
  isDoomed(table, alias) {
    const oid = this.m.oidOf.get(table);
    return this.made.has(oid)
      ? `EXISTS (SELECT 1 FROM ${this.d(oid)} d WHERE d.rid = ${alias}.ctid)`
      : "false";
  }
  async add(oid, sql, params = []) {
    await this.ensure(oid);
    const r = await this.c.query(
      `INSERT INTO ${this.d(oid)} ${sql} ON CONFLICT DO NOTHING`,
      params,
    );
    if (r.rowCount) this.dirty.add(oid);
    return r.rowCount ?? 0;
  }
  async root(table, where) {
    const oid = this.m.oidOf.get(table);
    if (oid === undefined) return 0;
    return this.add(oid, `SELECT ctid FROM ${qi(table)} WHERE ${where}`);
  }
  /** The ids of every doomed row with a one-column primary key, as text, for the id-shaped columns to match. */
  async refreshIds() {
    for (const oid of this.made) {
      const pk = this.m.pk.get(oid);
      if (!pk || !(pk.type === "uuid" || pk.type === "text")) continue;
      // entity_records' text ids are names ("L-AZ-PARTNER"); only distinctive ones are matched elsewhere.
      const guard =
        pk.type === "text"
          ? ` AND length(t.${qi(pk.name)}) >= 8 AND t.${qi(pk.name)} LIKE '%-%'`
          : "";
      await this.c.query(
        `INSERT INTO _purge_ids SELECT t.${qi(pk.name)}::text FROM ${qi(this.m.byOid.get(oid))} t JOIN ${this.d(oid)} d ON d.rid = t.ctid WHERE t.${qi(pk.name)} IS NOT NULL${guard} ON CONFLICT DO NOTHING`,
      );
    }
    // entity_records has a composite key; its ids name the record in loan_events.aggregate_id and timers.subject_id.
    const er = this.m.oidOf.get("entity_records");
    if (this.made.has(er))
      await this.c.query(
        `INSERT INTO _purge_ids SELECT DISTINCT t.id FROM entity_records t JOIN ${this.d(er)} d ON d.rid = t.ctid WHERE length(t.id) >= 8 AND t.id LIKE '%-%' ON CONFLICT DO NOTHING`,
      );
  }
  /**
   * For a match by id or by mention (not a foreign key): never a row of a kept loan. A kept loan's refinance
   * review that names the demo's FAKE rate sheet is the kept loan's history, and stays.
   */
  notKeptLoan(oid) {
    return this.m.loanScoped.some((x) => x.oid === oid)
      ? ` AND (t.loan_id IS NULL OR t.loan_id::text IN (SELECT s.id::text FROM _purge_seed_loans s))`
      : "";
  }
  /** Follow foreign keys and id-shaped columns until nothing more is added. */
  async close() {
    for (;;) {
      let added = 0;
      // Only edges out of a table that gained rows since the last pass can add anything.
      const dirty = this.dirty;
      this.dirty = new Set();
      for (const f of this.m.fks) {
        if (!dirty.has(f.parent)) continue;
        const on = f.ccols.map((c, i) => `c.${qi(c)} = p.${qi(f.pcols[i])}`).join(" AND ");
        added += await this.add(
          f.child,
          `SELECT c.ctid FROM ${qi(this.m.byOid.get(f.child))} c JOIN ${qi(this.m.byOid.get(f.parent))} p ON ${on} JOIN ${this.d(f.parent)} d ON d.rid = p.ctid`,
        );
      }
      const before = this.ids;
      await this.refreshIds();
      this.ids = (await this.c.query(`SELECT count(*)::int AS n FROM _purge_ids`)).rows[0].n;
      if (this.ids !== before) {
        for (const [oid, names] of this.softByTable()) {
          const any = names
            .map((n) =>
              n.type.endsWith("[]")
                ? `i.v = ANY (t.${qi(n.name)}::text[])`
                : `i.v = t.${qi(n.name)}::text`,
            )
            .join(" OR ");
          added += await this.add(
            oid,
            `SELECT t.ctid FROM ${qi(this.m.byOid.get(oid))} t JOIN _purge_ids i ON ${any} WHERE true${this.notKeptLoan(oid)}`,
          );
        }
      }
      if (this.ids !== before) {
        for (const { oid } of this.m.loanScoped) {
          added += await this.add(
            oid,
            `SELECT m.rid FROM _purge_mentions m JOIN _purge_ids i ON i.v = m.v WHERE m.oid = ${oid}`,
          );
        }
      }
      // entity_records naming a doomed party, loan or application anywhere in their data: the demo partner's configuration.
      const er = this.m.oidOf.get("entity_records");
      if (er !== undefined && this.ids !== before) {
        added += await this.add(
          er,
          `SELECT t.ctid FROM entity_records t WHERE (t.kind, t.id) IN (SELECT m.kind, m.id FROM _purge_er_mentions m JOIN _purge_ids i ON i.v = m.v)${this.notKeptLoan(er)}`,
        );
        if (this.made.has(er))
          added += await this.add(
            er,
            `SELECT t.ctid FROM entity_records t WHERE (t.kind, t.id) IN (SELECT e.kind, e.id FROM entity_records e JOIN ${this.d(er)} d ON d.rid = e.ctid)${this.notKeptLoan(er)}`,
          );
      }
      if (added === 0) return;
    }
  }
  /** Rows of ORPHAN_TABLES a doomed row references and no kept row does. Returns how many were added. */
  async orphans(tables) {
    let added = 0;
    for (const name of tables) {
      const oid = this.m.oidOf.get(name);
      if (oid === undefined) continue;
      const incoming = this.m.fks.filter((f) => f.parent === oid);
      const fromDoomed = incoming.filter((f) => this.made.has(f.child));
      if (fromDoomed.length === 0) continue;
      const on = (f) => f.ccols.map((c, i) => `c.${qi(c)} = p.${qi(f.pcols[i])}`).join(" AND ");
      // Candidates: the parents doomed rows point at, not yet doomed themselves.
      await this.c.query(
        `DROP TABLE IF EXISTS _purge_cand; CREATE TEMP TABLE _purge_cand (rid tid PRIMARY KEY) ON COMMIT DROP`,
      );
      for (const f of fromDoomed) {
        await this.c
          .query(`INSERT INTO _purge_cand SELECT DISTINCT p.ctid FROM ${qi(name)} p JOIN ${qi(this.m.byOid.get(f.child))} c ON ${on(f)}
          JOIN ${this.d(f.child)} d ON d.rid = c.ctid WHERE NOT ${this.isDoomed(name, "p")} ON CONFLICT DO NOTHING`);
      }
      // Struck: any a kept row still points at.
      for (const f of incoming) {
        if (!(await this.c.query(`SELECT 1 FROM _purge_cand LIMIT 1`)).rowCount) break;
        const kept = this.made.has(f.child)
          ? ` AND NOT EXISTS (SELECT 1 FROM ${this.d(f.child)} d WHERE d.rid = c.ctid)`
          : "";
        await this.c.query(
          `DELETE FROM _purge_cand x USING ${qi(name)} p WHERE p.ctid = x.rid AND EXISTS (SELECT 1 FROM ${qi(this.m.byOid.get(f.child))} c WHERE ${on(f)}${kept})`,
        );
      }
      const synthetic =
        name === "borrowers"
          ? " AND (p.party_id IS NULL OR p.party_id IN (SELECT id FROM parties WHERE synthetic))"
          : "";
      added += await this.add(
        oid,
        `SELECT p.ctid FROM ${qi(name)} p JOIN _purge_cand x ON x.rid = p.ctid WHERE true${synthetic}`,
      );
    }
    return added;
  }
  async protectedHit() {
    // The invariant above all: no row that belongs to a loan which is not a seed loan.
    for (const { oid } of this.m.loanScoped) {
      if (!this.made.has(oid)) continue;
      const table = this.m.byOid.get(oid);
      const r = await this.c
        .query(`SELECT count(*)::int AS n FROM ${qi(table)} t JOIN ${this.d(oid)} d ON d.rid = t.ctid
        WHERE t.loan_id IS NOT NULL AND t.loan_id::text NOT IN (SELECT s.id::text FROM _purge_seed_loans s)`);
      if (r.rows[0].n > 0) return `${table} (${r.rows[0].n} rows of kept loans)`;
    }
    for (const [table, keep] of Object.entries(PROTECTED)) {
      const oid = this.m.oidOf.get(table);
      if (!this.made.has(oid)) continue;
      const r = await this.c.query(
        `SELECT count(*)::int AS n FROM ${qi(table)} t JOIN ${this.d(oid)} d ON d.rid = t.ctid WHERE ${keep}`,
      );
      if (r.rows[0].n > 0) return `${table} (${r.rows[0].n})`;
    }
    return null;
  }
  async counts() {
    const out = [];
    for (const oid of this.made) {
      const r = await this.c.query(`SELECT count(*)::int AS n FROM ${this.d(oid)}`);
      if (r.rows[0].n > 0) out.push({ table: this.m.byOid.get(oid), rows: r.rows[0].n });
    }
    return out.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
  }
  /**
   * Delete, children before parents. The append-only triggers are switched off
   * for the tables touched and back on before COMMIT, inside the same
   * transaction (ALTER TABLE is transactional), so no other session ever sees
   * them off. Foreign keys stay enforced: a missed child fails the statement.
   */
  async delete() {
    const doomed = [];
    for (const oid of this.made)
      if ((await this.c.query(`SELECT 1 FROM ${this.d(oid)} LIMIT 1`)).rowCount) doomed.push(oid);
    const names = doomed.map((oid) => this.m.byOid.get(oid));
    for (const n of names) await this.c.query(`ALTER TABLE ${qi(n)} DISABLE TRIGGER USER`);
    // Each table's deletes are checked as they happen, not at COMMIT, so a miss names its table.
    await this.c.query("SET CONSTRAINTS ALL IMMEDIATE");
    // Every deleted parent row makes Postgres look for children in each table that references it; where
    // the referencing column has no index that is a scan of the whole child table per deleted row, which
    // turns the 80,000 events of a swept demo into hours. An index for the length of the transaction,
    // dropped before COMMIT, makes each look a probe.
    const indexed = new Set(
      (
        await this.c.query(`
      SELECT i.indrelid::int AS oid, array(SELECT a.attname FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace`)
      ).rows.flatMap((r) => r.cols.map((_, n) => `${r.oid}:${r.cols.slice(0, n + 1).join(",")}`)),
    );
    const temp = [];
    for (const f of this.m.fks) {
      if (!doomed.includes(f.parent) || indexed.has(`${f.child}:${f.ccols.join(",")}`)) continue;
      const name = `_purge_ix_${temp.length}`;
      await this.c.query(
        `CREATE INDEX ${name} ON ${qi(this.m.byOid.get(f.child))} (${f.ccols.map(qi).join(", ")})`,
      );
      indexed.add(`${f.child}:${f.ccols.join(",")}`);
      temp.push(name);
    }
    // Children before parents. Tables that point at each other (loans.boarding_batch_id and the batch's
    // own rows) are a cycle no order satisfies: when the order sticks, a nullable key between two of the
    // stuck tables is cleared on the doomed rows only (the triggers that would refuse the UPDATE are off),
    // one edge at a time, until the order moves again.
    const edges = this.m.fks.filter(
      (f) => f.child !== f.parent && doomed.includes(f.child) && doomed.includes(f.parent),
    );
    const cut = new Set();
    let left = doomed;
    while (left.length) {
      const live = edges.filter((f) => !cut.has(f) && left.includes(f.child));
      const ready = left.filter((oid) => !live.some((f) => f.parent === oid));
      if (ready.length) {
        for (const oid of ready)
          await this.c.query(
            `DELETE FROM ${qi(this.m.byOid.get(oid))} t USING ${this.d(oid)} d WHERE d.rid = t.ctid`,
          );
        left = left.filter((oid) => !ready.includes(oid));
        continue;
      }
      const edge = live.find((f) => f.nullable && left.includes(f.parent));
      if (!edge)
        throw new Error(
          `purge-synthetic: a cycle of NOT NULL keys among ${left.map((o) => this.m.byOid.get(o)).join(", ")}`,
        );
      const set = edge.ccols.map((c) => `${qi(c)} = NULL`).join(", ");
      // An UPDATE writes a new row version at a new ctid; the plan follows it in the same statement.
      const d = this.d(edge.child);
      await this.c
        .query(`WITH u AS (UPDATE ${qi(this.m.byOid.get(edge.child))} t SET ${set} FROM ${d} d WHERE d.rid = t.ctid RETURNING d.rid AS old, t.ctid AS new),
        gone AS (DELETE FROM ${d} x USING u WHERE x.rid = u.old) INSERT INTO ${d} SELECT new FROM u`);
      cut.add(edge);
    }
    // Deferred checks queued by the deletes run now, so the triggers can be switched back on.
    await this.c.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const name of temp) await this.c.query(`DROP INDEX ${name}`);
    for (const n of names) await this.c.query(`ALTER TABLE ${qi(n)} ENABLE TRIGGER USER`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await purgeSynthetic(client, { apply: argv.includes("--apply") });
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
