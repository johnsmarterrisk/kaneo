// Operon fork addition (Tables task 2, fork-discipline row 18): upstream Kaneo PR
// #1542's custom-field migration lands in this fork as `0051`, not upstream's `0045`
// (the fork's own `0045_external_link_unique` already holds that slot). These cases
// prove the renumbered migration on two real databases of its own: an empty one, and
// one migrated to `0050` and populated before `0051` runs, so an upgrade keeps every
// existing record. They use their own `_test` databases, never the shared one the
// other suites truncate.
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(currentDir, "../../apps/api/drizzle");

type JournalEntry = { idx: number; when: number; tag: string };
type Journal = { entries: JournalEntry[] };

const journal: Journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
);

const CUSTOM_FIELD_TAG = "0051_fantastic_princess_powerful";

function databaseUrlFor(suffix: string) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const base = url.pathname.replace(/^\//, "").replace(/_test$/, "");
  url.pathname = `/${base}_${suffix}_test`;
  return url.toString();
}

async function recreateDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`refusing to recreate non-test database ${name}`);
  }
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function migrateTo(connectionString: string, folder: string) {
  const pool = new Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

/** A copy of the migrations folder whose journal stops at `lastTag`. */
function truncatedMigrationsFolder(lastTag: string) {
  const dir = mkdtempSync(join(tmpdir(), "operon-tables-migration-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const cut = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cut < 0) throw new Error(`journal has no ${lastTag}`);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut + 1) }),
  );
  return dir;
}

async function appliedMigrations(client: Client) {
  const result = await client.query<{ created_at: string }>(
    'SELECT created_at FROM drizzle."__drizzle_migrations" ORDER BY id',
  );
  return result.rows.map((row) => Number(row.created_at));
}

const createdDatabases: string[] = [];
const createdFolders: string[] = [];

afterAll(async () => {
  for (const url of createdDatabases) await dropDatabase(url);
  for (const dir of createdFolders)
    rmSync(dir, { recursive: true, force: true });
});

describe("Tables migration 0051 (upstream #1542, renumbered)", () => {
  it("is journal entry 51, tagged 0051, and no other entry shares its number", () => {
    const entry = journal.entries.find((e) => e.tag === CUSTOM_FIELD_TAG);
    expect(entry?.idx).toBe(51);
    expect(journal.entries.at(-1)?.tag).toBe(CUSTOM_FIELD_TAG);
    // The fork's own 0045 holds that slot; upstream's number must not come back.
    expect(
      journal.entries
        .filter((e) => e.tag.startsWith("0045_"))
        .map((e) => e.tag),
    ).toEqual(["0045_external_link_unique"]);
    const numbers = journal.entries.map((e) => e.tag.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.startsWith(String(i).padStart(4, "0"))).toBe(true);
    });
    // Upstream's own history is not monotonic in `when`, but drizzle's migrator applies
    // only entries newer than the last applied one, so 0051 must postdate every entry
    // before it or an existing installation would silently skip it.
    const earlier = journal.entries.slice(0, -1).map((e) => e.when);
    expect(entry?.when).toBeGreaterThan(Math.max(...earlier));
  });

  it("migrates an empty database to 0051 with every journal entry applied in order", async () => {
    const url = databaseUrlFor("tables_mig_empty");
    createdDatabases.push(url);
    await recreateDatabase(url);
    await migrateTo(url, migrationsFolder);

    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const applied = await appliedMigrations(client);
      expect(applied).toHaveLength(52);
      expect(applied).toEqual(journal.entries.map((e) => e.when));

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('custom_field_definition', 'custom_field_value')
         ORDER BY table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual([
        "custom_field_definition",
        "custom_field_value",
      ]);
    } finally {
      await client.end();
    }
  });

  it("upgrades a populated 0050 database to 0051 and keeps every record", async () => {
    const url = databaseUrlFor("tables_mig_upgrade");
    createdDatabases.push(url);
    await recreateDatabase(url);

    const at0050 = truncatedMigrationsFolder(
      "0050_operon_project_field_labels",
    );
    createdFolders.push(at0050);
    await migrateTo(url, at0050);

    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      expect(await appliedMigrations(client)).toHaveLength(51);

      await client.query(`
        INSERT INTO "user" (id, name, email, email_verified) VALUES
          ('u-1', 'Ada', 'ada@example.test', true),
          ('u-2', 'Grace', 'grace@example.test', true);
        INSERT INTO workspace (id, name, slug, created_at) VALUES
          ('w-1', 'Smarter Risk', 'smarter-risk', now());
        INSERT INTO workspace_member (id, workspace_id, user_id, role, joined_at) VALUES
          ('wm-1', 'w-1', 'u-1', 'owner', now()),
          ('wm-2', 'w-1', 'u-2', 'member', now());
        INSERT INTO project (id, workspace_id, slug, name) VALUES
          ('p-1', 'w-1', 'MKT', 'Marketing'),
          ('p-2', 'w-1', 'OPS', 'Operations');
        INSERT INTO task (id, project_id, title, number, operon_idempotency_key, social_revision) VALUES
          ('t-1', 'p-1', 'Plain task', 1, NULL, 0),
          ('t-2', 'p-1', 'Keyed task one', 2, 'desk:thread-1', 3),
          ('t-3', 'p-2', 'Keyed task two', 1, 'desk:thread-2', 0);
        INSERT INTO operon_project_field_labels (project_id, description_label, due_date_label) VALUES
          ('p-1', 'Brief', 'Publish by');
      `);

      const snapshot = async () => ({
        users: (await client.query('SELECT id, email FROM "user" ORDER BY id'))
          .rows,
        workspaces: (
          await client.query("SELECT id, slug FROM workspace ORDER BY id")
        ).rows,
        members: (
          await client.query(
            "SELECT id, workspace_id, user_id, role FROM workspace_member ORDER BY id",
          )
        ).rows,
        projects: (
          await client.query(
            "SELECT id, workspace_id, slug FROM project ORDER BY id",
          )
        ).rows,
        tasks: (
          await client.query(
            "SELECT id, project_id, title, number, operon_idempotency_key, social_revision::text FROM task ORDER BY id",
          )
        ).rows,
        labels: (
          await client.query(
            "SELECT project_id, description_label, due_date_label FROM operon_project_field_labels ORDER BY project_id",
          )
        ).rows,
      });

      const before = await snapshot();
      expect(before.tasks).toHaveLength(3);
      expect(before.tasks.filter((t) => t.operon_idempotency_key)).toHaveLength(
        2,
      );
      expect(before.tasks.some((t) => Number(t.social_revision) > 0)).toBe(
        true,
      );

      await migrateTo(url, migrationsFolder);

      expect(await snapshot()).toEqual(before);
      expect(await appliedMigrations(client)).toEqual(
        journal.entries.map((e) => e.when),
      );

      // The new tables work against the preserved rows, and cascade as upstream built them.
      await client.query(`
        INSERT INTO custom_field_definition (id, project_id, name, type) VALUES ('f-1', 'p-1', 'Topic', 'text');
        INSERT INTO custom_field_value (id, task_id, field_id, value) VALUES ('v-1', 't-2', 'f-1', 'Risk tips');
      `);
      await client.query(
        "DELETE FROM custom_field_definition WHERE id = 'f-1'",
      );
      const values = await client.query("SELECT id FROM custom_field_value");
      expect(values.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
