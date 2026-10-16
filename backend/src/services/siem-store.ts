/**
 * Local store of Web events from the SIEM API, for the pilot digest.
 *
 * The SIEM API keeps about 24 hours, so a digest over a pilot of a week or
 * more needs the events collected at least daily. Each collection resumes
 * from the last cursor when it's under 23 hours old, and otherwise starts
 * 24 hours back (less 10 minutes, so the request isn't refused). Events are
 * kept one JSON line each in data/siem/<tenant>/events-YYYY-MM-DD.jsonl, by
 * the day they were created, without repeats, for RETENTION_DAYS days. A run
 * that starts more than 24 hours after the last good one says events may be
 * missing.
 *
 * Collection runs on a timer while the server runs (startCollector, every
 * SIEM_COLLECT_HOURS hours, 6 by default) for tenants that opted in on the
 * pilot page, and from `npm run collect` for a scheduler such as cron, launchd
 * or Task Scheduler. Events can also be imported from a saved SIEM response,
 * and are marked as imported.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { TenantApi } from "../sophos/api/requester.js";
import { ReadOnlyApi, errorStatus } from "../sophos/api/requester.js";
import { getEvents } from "../sophos/api/siem.js";
import type { SiemEvent } from "../domain/digest.js";
import { readText, saveFile, withRetry } from "./safe-files.js";
import { log } from "../log.js";

const SECTION = "siem";
export const RETENTION_DAYS = 90;
const CURSOR_MAX_AGE_MS = 23 * 3600 * 1000;
const LOOKBACK_S = 24 * 3600 - 600;
const MAX_PAGES = 200;
const MAX_RUNS = 60;

/** Event types kept: Web Control violations, plus other web events so nothing web-related is thrown away. */
export function isWebEvent(e: { type?: string }): boolean {
  return /^Event::Endpoint::Web/.test(e.type ?? "");
}

export interface CollectRun {
  at: string;
  source: "api" | "import";
  ok: boolean;
  pages: number;
  fetched: number;
  web: number;
  added: number;
  started?: "cursor" | "from-date";
  gap?: string;
  error?: string;
}

export interface SiemState {
  tenantId: string;
  enabled: boolean;
  cursor?: string;
  cursorAt?: string;
  lastOkAt?: string;
  runs: CollectRun[];
}

function dir(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "siem", tenantId);
}

export async function loadState(dataDir: string, tenantId: string): Promise<SiemState> {
  const text = await readText(path.join(dir(dataDir, tenantId), "state.json"), SECTION).catch(() => null);
  return text ? (JSON.parse(text) as SiemState) : { tenantId, enabled: false, runs: [] };
}

async function saveState(dataDir: string, s: SiemState): Promise<void> {
  const d = dir(dataDir, s.tenantId);
  await fs.mkdir(d, { recursive: true });
  s.runs = s.runs.slice(-MAX_RUNS);
  await saveFile(path.join(d, "state.json"), JSON.stringify(s, null, 2), { section: SECTION, mode: 0o600 });
}

export async function setEnabled(dataDir: string, tenantId: string, enabled: boolean): Promise<SiemState> {
  const s = await loadState(dataDir, tenantId);
  s.enabled = enabled;
  await saveState(dataDir, s);
  return s;
}

/** A tenant whose saved collection setting couldn't be read, and why (with the file). */
export interface UnreadSetting {
  tenantId: string;
  error: string;
}

/**
 * Tenants with collection turned on. A tenant whose saved setting can't be
 * read or parsed is listed apart, with why, so one broken file doesn't stop
 * collection for the others.
 */
export async function enabledTenants(dataDir: string): Promise<{ enabled: string[]; unread: UnreadSetting[] }> {
  const root = path.join(dataDir, "siem");
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const enabled: string[] = [];
  const unread: UnreadSetting[] = [];
  for (const n of names) {
    if (!/^[0-9a-f-]{8,64}$/i.test(n)) continue;
    try {
      if ((await loadState(dataDir, n)).enabled) enabled.push(n);
    } catch (err) {
      unread.push({ tenantId: n, error: `${err instanceof Error ? err.message : String(err)} (${path.join(root, n, "state.json")})` });
    }
  }
  return { enabled, unread };
}

function dayOf(e: SiemEvent): string {
  const when = String(e.created_at ?? e.when ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(when) ? when.slice(0, 10) : "undated";
}

async function dayFiles(dataDir: string, tenantId: string): Promise<string[]> {
  const names = await fs.readdir(dir(dataDir, tenantId)).catch(() => [] as string[]);
  return names.filter((n) => /^events-(\d{4}-\d{2}-\d{2}|undated)\.jsonl$/.test(n)).sort();
}

async function readDay(file: string): Promise<SiemEvent[]> {
  const text = await readText(file, SECTION).catch(() => null);
  const out: SiemEvent[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SiemEvent);
    } catch {
      // A line cut off by a crash is skipped; the rest of the day still counts.
    }
  }
  return out;
}

/** Appends events not already stored, by id. Returns how many were added. */
export async function storeEvents(dataDir: string, tenantId: string, events: SiemEvent[], mark?: Record<string, unknown>): Promise<number> {
  const d = dir(dataDir, tenantId);
  await fs.mkdir(d, { recursive: true });
  const byDay = new Map<string, SiemEvent[]>();
  for (const e of events.filter(isWebEvent)) {
    if (!e.id) continue;
    const list = byDay.get(dayOf(e)) ?? [];
    list.push(mark ? { ...e, ...mark } : e);
    byDay.set(dayOf(e), list);
  }
  let added = 0;
  for (const [day, list] of byDay) {
    const file = path.join(d, `events-${day}.jsonl`);
    const seen = new Set((await readDay(file)).map((e) => e.id));
    const fresh = list.filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
    if (!fresh.length) continue;
    await withRetry(SECTION, "append events", () => fs.appendFile(file, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 }));
    added += fresh.length;
  }
  return added;
}

async function prune(dataDir: string, tenantId: string, now: number): Promise<void> {
  const cutoff = new Date(now - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const n of await dayFiles(dataDir, tenantId)) {
    const day = n.slice(7, 17);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) await fs.unlink(path.join(dir(dataDir, tenantId), n)).catch(() => undefined);
  }
}

/** One collection from the SIEM API. Read only. */
export async function collect(dataDir: string, client: TenantApi, tenantId: string, now = Date.now()): Promise<CollectRun> {
  const api = new ReadOnlyApi(client);
  const state = await loadState(dataDir, tenantId);
  const run: CollectRun = { at: new Date(now).toISOString(), source: "api", ok: false, pages: 0, fetched: 0, web: 0, added: 0 };
  const fromDate = Math.floor(now / 1000) - LOOKBACK_S;
  const useCursor = !!state.cursor && !!state.cursorAt && now - Date.parse(state.cursorAt) < CURSOR_MAX_AGE_MS;
  if (state.lastOkAt && now - Date.parse(state.lastOkAt) > 24 * 3600 * 1000) {
    run.gap = `The last collection was ${state.lastOkAt}; events from then until ${new Date(fromDate * 1000).toISOString()} may be missing, because the SIEM API keeps about 24 hours.`;
  }
  try {
    let q: { cursor?: string; fromDate?: number } = useCursor ? { cursor: state.cursor } : { fromDate };
    run.started = useCursor ? "cursor" : "from-date";
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await getEvents(api, tenantId, q);
      } catch (err) {
        // A cursor Sophos no longer takes: start again from the date, once.
        if (q.cursor && run.pages === 0 && errorStatus(err) === 400) {
          q = { fromDate };
          run.started = "from-date";
          continue;
        }
        throw err;
      }
      run.pages++;
      const items = page.items ?? [];
      run.fetched += items.length;
      const web = items.filter(isWebEvent);
      run.web += web.length;
      run.added += await storeEvents(dataDir, tenantId, web);
      cursor = page.next_cursor ?? cursor;
      if (!page.has_more || !page.next_cursor || run.pages >= MAX_PAGES) break;
      q = { cursor: page.next_cursor };
    }
    if (cursor) {
      state.cursor = cursor;
      state.cursorAt = new Date(now).toISOString();
    }
    run.ok = true;
    state.lastOkAt = run.at;
    await prune(dataDir, tenantId, now);
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
    log.emit("warn", SECTION, `SIEM collection failed: ${run.error}`, { tenant: tenantId });
  }
  state.runs.push(run);
  await saveState(dataDir, state);
  return run;
}

/** Stores events from a saved SIEM response ({items}) or a plain array, marked as imported. */
export async function importEvents(dataDir: string, tenantId: string, payload: unknown, label: string): Promise<CollectRun> {
  const p = payload as { items?: unknown; events?: unknown } | unknown[];
  const list = (Array.isArray(p) ? p : Array.isArray(p?.items) ? p.items : Array.isArray(p?.events) ? p.events : null) as SiemEvent[] | null;
  if (!list) throw new Error("Expected a SIEM events response (with items) or a list of events.");
  const state = await loadState(dataDir, tenantId);
  const web = list.filter((e) => e && typeof e === "object" && isWebEvent(e));
  const run: CollectRun = { at: new Date().toISOString(), source: "import", ok: true, pages: 1, fetched: list.length, web: web.length, added: 0 };
  run.added = await storeEvents(dataDir, tenantId, web, { _imported: label.slice(0, 80) || "import" });
  state.runs.push(run);
  await saveState(dataDir, state);
  return run;
}

/** Stored events created on or after `sinceDay` (YYYY-MM-DD), or all of them. */
export async function readEvents(dataDir: string, tenantId: string, sinceDay?: string): Promise<SiemEvent[]> {
  const out: SiemEvent[] = [];
  for (const n of await dayFiles(dataDir, tenantId)) {
    const day = n.slice(7, -6);
    if (sinceDay && day !== "undated" && day < sinceDay) continue;
    out.push(...(await readDay(path.join(dir(dataDir, tenantId), n))));
  }
  return out;
}

export interface StoreSummary {
  days: Array<{ day: string; events: number; imported: number }>;
  total: number;
  imported: number;
  state: SiemState;
}

export async function storeSummary(dataDir: string, tenantId: string): Promise<StoreSummary> {
  const days: StoreSummary["days"] = [];
  for (const n of await dayFiles(dataDir, tenantId)) {
    const ev = await readDay(path.join(dir(dataDir, tenantId), n));
    days.push({ day: n.slice(7, -6), events: ev.length, imported: ev.filter((e) => e._imported).length });
  }
  return {
    days,
    total: days.reduce((a, d) => a + d.events, 0),
    imported: days.reduce((a, d) => a + d.imported, 0),
    state: await loadState(dataDir, tenantId),
  };
}

/** Collects for every opted-in tenant every `hours` hours while the server runs. 0 turns it off. */
export function startCollector(dataDir: string, hours: number, contextFor: (tenantId: string) => { client: TenantApi; tenantId: string; summary?: { displayName: string } }): void {
  if (!(hours > 0)) return;
  const tick = async () => {
    // A tenant whose saved setting can't be read or parsed is skipped, with a warning naming it; the others are still collected.
    let tenants: Awaited<ReturnType<typeof enabledTenants>>;
    try {
      tenants = await enabledTenants(dataDir);
    } catch (err) {
      log.emit("warn", SECTION, `No SIEM collection this time: the collection settings couldn't be read. ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const u of tenants.unread) {
      let name = "this tenant";
      try {
        name = contextFor(u.tenantId).summary?.displayName ?? name;
      } catch {
        // A tenant the credential doesn't reach goes by its id, which the log line carries.
      }
      log.emit("warn", SECTION, `No SIEM collection for ${name}: its saved collection setting couldn't be read. ${u.error}`, { tenant: u.tenantId });
    }
    for (const t of tenants.enabled) {
      try {
        const ctx = contextFor(t);
        const run = await collect(dataDir, ctx.client, ctx.tenantId);
        // A run that failed was logged, with why, as it ended.
        if (run.ok) log.emit("info", SECTION, `Collected SIEM web events: ${run.added} new of ${run.web}`, { tenant: t });
      } catch (err) {
        log.emit("warn", SECTION, `No SIEM collection: ${err instanceof Error ? err.message : String(err)}`, { tenant: t });
      }
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), hours * 3600_000).unref();
}
