/**
 * Saves rollback snapshots to data/snapshots/<tenant id>/ with an integrity
 * hash, lists them, and reads one back with its hash checked. Every save is
 * written to the audit log, because drops 2 and 3 restore from these files.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, validateSnapshot, type Snapshot } from "../domain/snapshot.js";
import { saveFile, readText } from "./safe-files.js";
import { auditOrWarn } from "./audit-log.js";

const SECTION = "snapshots";
const SAFE_ID = /^[0-9a-f-]{8,64}$/i;
const SAFE_FILE = /^[a-z0-9-]+_\d{8}-\d{6}\.json$/;

export function objectsHash(snapshot: Pick<Snapshot, "objects">): string {
  return createHash("sha256").update(canonicalJson(snapshot.objects)).digest("hex");
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tenant"
  );
}

function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tenantDir(dataDir: string, tenantId: string): string {
  if (!SAFE_ID.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "snapshots", tenantId);
}

export interface SavedSnapshot {
  file: string;
  path: string;
  bytes: number;
  hash: string;
}

export async function saveSnapshot(dataDir: string, snapshot: Snapshot): Promise<SavedSnapshot> {
  const hash = objectsHash(snapshot);
  const sealed: Snapshot = { ...snapshot, integrity: { algorithm: "sha256", objects: hash } };
  const dir = tenantDir(dataDir, snapshot.tenant.id);
  await fs.mkdir(dir, { recursive: true });
  const file = `${slug(snapshot.tenant.name)}_${stamp(snapshot.takenAt)}.json`;
  const full = path.join(dir, file);
  const text = JSON.stringify(sealed, null, 2) + "\n";
  await saveFile(full, text, { section: SECTION, mode: 0o600 });
  await auditOrWarn({
    tenantId: snapshot.tenant.id,
    tenantName: snapshot.tenant.name,
    action: "save-snapshot",
    resource: "snapshot",
    resourceId: file,
    ok: true,
    detail: { sha256: hash, counts: snapshot.counts, unreadSections: snapshot.unreadSections },
  });
  return { file, path: full, bytes: Buffer.byteLength(text), hash };
}

export async function listSnapshots(dataDir: string, tenantId: string): Promise<Array<{ file: string; bytes: number; savedAt: string }>> {
  const dir = tenantDir(dataDir, tenantId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; bytes: number; savedAt: string }> = [];
  for (const name of names.filter((n) => SAFE_FILE.test(n))) {
    const st = await fs.stat(path.join(dir, name));
    out.push({ file: name, bytes: st.size, savedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.file.slice(-20).localeCompare(a.file.slice(-20)));
}

/** The snapshot's file path, refusing anything outside the tenant's folder. */
export function snapshotPath(dataDir: string, tenantId: string, file: string): string {
  if (!SAFE_FILE.test(file)) throw new Error("Not a snapshot file name.");
  return path.join(tenantDir(dataDir, tenantId), file);
}

export interface LoadedSnapshot {
  snapshot: Snapshot;
  intact: boolean;
  problems: string[];
}

/** Reads a snapshot and checks its shape and hash. */
export async function loadSnapshot(dataDir: string, tenantId: string, file: string): Promise<LoadedSnapshot> {
  const text = await readText(snapshotPath(dataDir, tenantId, file), SECTION);
  if (text === null) throw new Error(`No snapshot named ${file}.`);
  const snapshot = JSON.parse(text) as Snapshot;
  const check = validateSnapshot(snapshot);
  const problems = [...check.problems];
  const intact = !!snapshot.integrity && snapshot.integrity.objects === objectsHash(snapshot);
  if (!intact) problems.push("The integrity hash does not match the objects: the file was changed after it was saved.");
  return { snapshot, intact, problems };
}
