import { spawn, type ChildProcess } from "node:child_process";
import { DUMP_NAME, RESTIC_HOST, RESTIC_TAG, parsePgUrl, retentionArgs, scrub, sameDatabase, type PgConnection, type Retention } from "./config.js";

// Runs pg_dump | restic without any temporary file: the dump streams straight
// into an encrypted restic repository. Every command is a fixed argv (never a
// shell); credentials travel in the environment of that one process only.

export interface Tools { pgDump: string; pgRestore: string; restic: string }
export const tools = (): Tools => ({
  pgDump: process.env.DBBACKUP_PG_DUMP || "pg_dump",
  pgRestore: process.env.DBBACKUP_PG_RESTORE || "pg_restore",
  restic: process.env.DBBACKUP_RESTIC || "restic",
});

export interface RepoAccess { repo: string; env: Record<string, string> }

export interface Outcome { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const CAP = 1 << 20;

function base(env: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env };
  if (process.env.RESTIC_CACHE_DIR) e.RESTIC_CACHE_DIR = process.env.RESTIC_CACHE_DIR;
  if (process.env.TMPDIR) e.TMPDIR = process.env.TMPDIR;
  return e;
}

export function resticEnv(access: RepoAccess): Record<string, string> {
  return { ...access.env, RESTIC_REPOSITORY: access.repo };
}

function collect(child: ChildProcess, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    child.stdout?.on("data", (d) => { if (stdout.length < CAP) stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr = (stderr + d.toString()).slice(-64_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const done = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); };
    child.on("error", (e) => { stderr += String(e.message); done(-1); });
    child.on("close", (code) => done(code));
  });
}

/** One process, no input. */
export function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<Outcome> {
  const child = spawn(cmd, args, { env: base(env), stdio: ["ignore", "pipe", "pipe"] });
  return collect(child, timeoutMs);
}

/** `producer | consumer`. If either side fails the other is stopped. */
export async function pipeline(
  producer: { cmd: string; args: string[]; env: Record<string, string> },
  consumer: { cmd: string; args: string[]; env: Record<string, string> },
  timeoutMs: number,
): Promise<{ producer: Outcome; consumer: Outcome }> {
  const a = spawn(producer.cmd, producer.args, { env: base(producer.env), stdio: ["ignore", "pipe", "pipe"] });
  const b = spawn(consumer.cmd, consumer.args, { env: base(consumer.env), stdio: ["pipe", "pipe", "pipe"] });
  a.stdout!.pipe(b.stdin!);
  b.stdin!.on("error", () => { /* consumer exited early: its exit code tells why */ });
  const pa = collect(a, timeoutMs), pb = collect(b, timeoutMs);
  pa.then((o) => { if (o.code !== 0) b.kill("SIGTERM"); });
  pb.then((o) => { if (o.code !== 0) a.kill("SIGTERM"); });
  const [producerOut, consumerOut] = await Promise.all([pa, pb]);
  return { producer: producerOut, consumer: consumerOut };
}

export async function toolVersions(): Promise<{ pgDump: string | null; restic: string | null }> {
  const t = tools();
  const first = (o: Outcome) => (o.code === 0 ? o.stdout.trim().split("\n")[0] : null);
  const [pg, rs] = await Promise.all([run(t.pgDump, ["--version"], {}, 15_000), run(t.restic, ["version"], {}, 15_000)]);
  return { pgDump: first(pg), restic: first(rs) };
}

/** Initialises the repository when it does not exist yet. */
export async function ensureRepo(access: RepoAccess): Promise<void> {
  const env = resticEnv(access);
  const probe = await run(tools().restic, ["cat", "config", "--no-lock"], env, 60_000);
  if (probe.code === 0) return;
  const missing = probe.code === 10 || /does not exist|Is there a repository at|unable to open config file/i.test(probe.stderr);
  if (!missing) throw new Error(scrub(probe.stderr || "cannot open repository", secretsOf(access)));
  const init = await run(tools().restic, ["init"], env, 120_000);
  if (init.code !== 0) throw new Error(scrub(init.stderr || "cannot initialise repository", secretsOf(access)));
}

export function secretsOf(access: RepoAccess, extra: string[] = []): string[] {
  return [...Object.values(access.env), ...extra].filter((v) => v && v.length >= 4);
}

export interface BackupResult { snapshotId: string; bytesAdded: number; dumpBytes: number; tablesFound: number; warnings: string[] }

/** Tables in a `pg_restore --list` listing: `… TABLE public name owner` lines only,
 * not the `TABLE DATA` entries that follow each of them. */
export function countTables(listing: string): number {
  return listing.split("\n").filter((l) => /\sTABLE\s(?!DATA\b)\S+\s+\S+/.test(l)).length;
}

/** Counts the TABLE entries of the dump stored in a snapshot by streaming it
 * through `pg_restore -l`: proves the archive is readable end to end. */
export async function verifySnapshot(access: RepoAccess, snapshotId: string, timeoutMs = 30 * 60_000): Promise<number> {
  const t = tools();
  const res = await pipeline(
    { cmd: t.restic, args: ["dump", snapshotId, DUMP_NAME], env: resticEnv(access) },
    { cmd: t.pgRestore, args: ["--list"], env: {} },
    timeoutMs,
  );
  if (res.producer.code !== 0) throw new Error("cannot read snapshot: " + scrub(res.producer.stderr, secretsOf(access)));
  if (res.consumer.code !== 0) throw new Error("dump is not a readable PostgreSQL archive: " + scrub(res.consumer.stderr, secretsOf(access)));
  return countTables(res.consumer.stdout);
}

export async function forgetSnapshot(access: RepoAccess, snapshotId: string): Promise<void> {
  await run(tools().restic, ["forget", snapshotId], resticEnv(access), 120_000);
}

export async function performBackup(access: RepoAccess, source: PgConnection, retention: Retention, opts: { timeoutMs?: number } = {}): Promise<BackupResult> {
  const t = tools();
  const secrets = secretsOf(access, [source.env.PGPASSWORD ?? ""]);
  await ensureRepo(access);

  // -Z0: restic compresses and deduplicates better than pg_dump's own zlib.
  const res = await pipeline(
    { cmd: t.pgDump, args: ["--format=custom", "--compress=0", "--no-sync"], env: source.env },
    { cmd: t.restic, args: ["backup", "--stdin", "--stdin-filename", DUMP_NAME, "--tag", RESTIC_TAG, "--host", RESTIC_HOST, "--json"], env: resticEnv(access) },
    opts.timeoutMs ?? 2 * 3_600_000,
  );

  let snapshotId = "", bytesAdded = 0, dumpBytes = 0;
  for (const line of res.consumer.stdout.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.message_type === "summary") { snapshotId = m.snapshot_id ?? ""; bytesAdded = Number(m.data_added ?? 0); dumpBytes = Number(m.total_bytes_processed ?? 0); }
    } catch { /* progress lines */ }
  }

  // restic happily snapshots a truncated stream, so a failed pg_dump must
  // remove the snapshot it produced instead of leaving a bad "latest" backup.
  if (res.producer.code !== 0) {
    if (snapshotId) await forgetSnapshot(access, snapshotId);
    const why = res.producer.timedOut ? "pg_dump timed out" : scrub(res.producer.stderr, secrets) || `pg_dump exited with ${res.producer.code}`;
    throw new Error("pg_dump failed: " + why);
  }
  if (res.consumer.code !== 0 || !snapshotId) {
    throw new Error("restic backup failed: " + (scrub(res.consumer.stderr, secrets) || `exit ${res.consumer.code}`));
  }

  let tablesFound = 0;
  try {
    tablesFound = await verifySnapshot(access, snapshotId);
    if (tablesFound < 1) throw new Error("the archive lists no tables");
  } catch (error) {
    await forgetSnapshot(access, snapshotId);
    throw new Error("verification failed, snapshot removed: " + (error instanceof Error ? error.message : String(error)));
  }

  const warnings: string[] = [];
  const forget = await run(t.restic, ["forget", "--prune", "--host", RESTIC_HOST, "--tag", RESTIC_TAG, ...retentionArgs(retention)], resticEnv(access), 30 * 60_000);
  if (forget.code !== 0) warnings.push("retention failed: " + scrub(forget.stderr, secrets, 300));
  return { snapshotId, bytesAdded, dumpBytes, tablesFound, warnings };
}

export interface SnapshotInfo { id: string; time: string; sizeBytes: number | null }

export async function listSnapshots(access: RepoAccess): Promise<SnapshotInfo[]> {
  const out = await run(tools().restic, ["snapshots", "--json", "--no-lock", "--host", RESTIC_HOST, "--tag", RESTIC_TAG], resticEnv(access), 90_000);
  if (out.code !== 0) throw new Error(scrub(out.stderr, secretsOf(access)) || "cannot list snapshots");
  const raw = JSON.parse(out.stdout || "[]") as Array<{ short_id: string; time: string; summary?: { total_bytes_processed?: number } }>;
  return raw.map((s) => ({ id: s.short_id, time: s.time, sizeBytes: s.summary?.total_bytes_processed ?? null })).sort((a, b) => b.time.localeCompare(a.time)).slice(0, 60);
}

/** Restores a snapshot into ANOTHER database. Refuses the live (source) one. */
export async function restoreInto(access: RepoAccess, snapshotId: string, target: PgConnection, live: PgConnection): Promise<{ warnings: string[] }> {
  if (sameDatabase(target, live)) throw new Error("Refusing to restore over the live database. Use a new database or a Neon branch.");
  const t = tools();
  const secrets = secretsOf(access, [target.env.PGPASSWORD ?? ""]);
  const res = await pipeline(
    { cmd: t.restic, args: ["dump", snapshotId, DUMP_NAME], env: resticEnv(access) },
    // --clean --if-exists makes a retry on a half-restored scratch database safe.
    { cmd: t.pgRestore, args: ["--no-owner", "--no-acl", "--clean", "--if-exists", "--dbname", target.database], env: target.env },
    2 * 3_600_000,
  );
  if (res.producer.code !== 0) throw new Error("cannot read snapshot: " + scrub(res.producer.stderr, secrets));
  if (res.consumer.code !== 0) throw new Error("pg_restore reported errors: " + scrub(res.consumer.stderr, secrets));
  return { warnings: [] };
}

/** Removes every snapshot (and the data they hold) from a repository. */
export async function purgeRepository(access: RepoAccess): Promise<number> {
  const ids = (await listSnapshots(access).catch(() => [])).map((s) => s.id);
  if (!ids.length) return 0;
  const out = await run(tools().restic, ["forget", "--prune", ...ids], resticEnv(access), 30 * 60_000);
  if (out.code !== 0) throw new Error(scrub(out.stderr, secretsOf(access)) || "cannot purge repository");
  return ids.length;
}
