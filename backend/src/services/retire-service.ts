/**
 * Retiring Website Management tags, last, with a restore.
 *
 * Retiring takes a fresh rollback snapshot, then plans against it
 * (domain/promote.ts planRetire): each policy's tags.settings loses the
 * retired tags first, because a policy that names a tag with no entries
 * can't be written (500), then entries that carried only retired tags are
 * deleted and the rest patched. Every write is sent once, read back and
 * audited, and the record keeps each entry and setting as it was.
 *
 * A step Sophos refused stops the retire. One it accepted that the read-back
 * didn't confirm is kept as unconfirmed and the retire goes on, as a build
 * rollback goes on past a delete it couldn't confirm (category D); Restore
 * puts it back like any step that was sent. When that step is a policy's tag
 * change, the entries with those tags are still deleted or untagged, so the
 * record lists each policy that may still name a tag whose entries it took
 * (tagsMayRemain): a policy that names a tag with no entries can't be saved.
 *
 * Restore runs the other way round: entries first (deleted ones re-created
 * from the record, patched ones put back), then the policies' tags.settings,
 * so no policy names a tag before its entries exist. A re-created entry gets
 * a new id; the snapshot comparison matches Website Management by URL.
 *
 * The tool warns, and asks for a confirmation, while devices still depend on
 * the tags: devices that can't use profiles keep classic settings, and an
 * enabled classic policy with targets still uses its tags.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../sophos/tenant-context.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { getPolicy, listPolicies, patchPolicy, type Policy } from "../sophos/api/policies.js";
import { createLocalSite, deleteLocalSite, getLocalSite, listLocalSites, patchLocalSite, type LocalSite } from "../sophos/api/web-control.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { planRetire, type RetirePlan, type RetireStep } from "../domain/promote.js";
import { settingValue, targetCount, targetsOf, usesWebProfile, type InventoryTenant } from "../domain/inventory.js";
import { deviceEligibility } from "../domain/eligibility.js";
import { canonicalJson } from "../domain/snapshot.js";
import { auditedWrite, auditOrWarn } from "./audit-log.js";
import { auditedCreate } from "./build-service.js";
import { listSnapshots, loadSnapshot } from "./snapshot-store.js";
import { runReadiness } from "./readiness.js";
import { foundNote, readBack, sendChecked, type UnclearWriteError } from "./write-check.js";
import { readText, saveFile } from "./safe-files.js";

const SECTION = "retire";
const TAGS_KEY = "endpoint.web-control.tags.settings";
type TagSetting = Array<{ tag: string; action: string }>;

export interface TagRow {
  tag: string;
  entries: number;
  only: number;
  policies: Array<{ id: string; name: string; action: string; enabled: boolean; onProfile: boolean; targets: number }>;
}

export interface RetireOverview {
  tags: TagRow[];
  latestSnapshot: string | null;
  records: RetireRecord[];
}

export type DoneStep = RetireStep & {
  /** unconfirmed: Sophos accepted the step (or gave no clear answer and nothing could be read), but the read-back didn't confirm it. */
  status: "planned" | "done" | "unconfirmed" | "failed" | "restored" | "restore-failed";
  /**
   * What the read-back after the step's last write found ("not read: " and why when no read worked). Set only once Sophos
   * accepted that write, so a step with one was sent; a restore-failed step with one was sent but not confirmed.
   */
  readBack?: string;
  /**
   * Set with readBack when Sophos didn't answer the step's write with a success (a 5xx, no answer in time or a dropped
   * connection) and nothing could be read back: what it said. Without it, Sophos accepted the write.
   */
  answer?: string;
  error?: string;
  /** For a deleted or patched entry: the whole entry as it was. */
  entry?: LocalSite;
  /** For a re-created entry: its new id. */
  newId?: string;
};

export interface RetireRecord {
  id: string;
  tenantId: string;
  at: string;
  tags: string[];
  snapshotFile: string;
  status: "retired" | "partial" | "failed" | "restored" | "restore-partial";
  steps: DoneStep[];
  warnings: string[];
  restoredAt?: string;
  /**
   * Set on a retire whose tag change for a policy wasn't confirmed, once it went on to delete or untag entries with those
   * tags: each policy that may still name a tag whose entries it took. Restore puts the entries back before the tags, so
   * a restore clears it.
   */
  tagsMayRemain?: Array<{ policyId: string; policyName: string; tags: string[] }>;
}

function dir(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "retire", tenantId);
}

async function saveRec(dataDir: string, r: RetireRecord): Promise<void> {
  const d = dir(dataDir, r.tenantId);
  await fs.mkdir(d, { recursive: true });
  await saveFile(path.join(d, `${r.id}.json`), JSON.stringify(r, null, 2), { section: SECTION, mode: 0o600 });
}

/**
 * A record as this version saves it. Before v0.3.20 a retire step Sophos accepted that the read-back didn't confirm was
 * saved as failed, with its read-back: it's unconfirmed. Before v0.3.19 a restore kept the retire's read-back on a step
 * whose restore write then failed, so a restore-failed step with a read-back and an error that isn't the restore's own
 * note on what it read ("Read back: ...", or that it couldn't read it back) failed on its write: that read-back is the
 * retire's, and goes.
 */
export function asSavedNow(r: RetireRecord): RetireRecord {
  for (const s of r.steps) {
    if (s.status === "failed" && s.readBack) s.status = "unconfirmed";
    if (s.status === "restore-failed" && s.readBack && s.error && !/^(Read back: |The tool couldn't read it back)/.test(s.error)) delete s.readBack;
  }
  // Before v0.3.21 a retire that went on past a tag change it couldn't confirm didn't say which policies may still name the tags.
  if (r.status === "partial" && !r.tagsMayRemain) {
    const left = tagsLeftNamed(r);
    if (left.length) r.tagsMayRemain = left;
  }
  return r;
}

/**
 * The policies that may still name a retired tag whose entries the retire then took: the policy's tag change wasn't
 * confirmed, and a later step that was sent deleted an entry with the tag or took the tag off one.
 */
export function tagsLeftNamed(r: RetireRecord): NonNullable<RetireRecord["tagsMayRemain"]> {
  const sent = r.steps.filter((s) => s.op !== "policy-tags" && (s.status === "done" || s.status === "unconfirmed"));
  const taken = new Set(sent.flatMap((s) => (s.op === "delete-entry" ? s.tags : s.op === "patch-entry" ? s.before.filter((t) => !s.after.includes(t)) : [])));
  return r.steps.flatMap((s) => {
    if (s.op !== "policy-tags" || s.status !== "unconfirmed") return [];
    const tags = s.before.filter((x) => !s.after.some((y) => y.tag === x.tag) && taken.has(x.tag)).map((x) => x.tag);
    return tags.length ? [{ policyId: s.policyId, policyName: s.policyName, tags }] : [];
  });
}

export async function listRecords(dataDir: string, tenantId: string): Promise<RetireRecord[]> {
  const d = dir(dataDir, tenantId);
  const names = await fs.readdir(d).catch(() => [] as string[]);
  const out: RetireRecord[] = [];
  for (const n of names.filter((x) => /^[0-9a-f-]{36}\.json$/.test(x))) {
    const text = await readText(path.join(d, n), SECTION);
    if (text) out.push(asSavedNow(JSON.parse(text) as RetireRecord));
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

async function webPolicies(api: TenantApi, t: string): Promise<Policy[]> {
  const [wc, swc] = await Promise.all([listPolicies(api, t, "web-control"), listPolicies(api, t, "server-web-control")]);
  return [...wc, ...swc];
}

/** Every tag in Website Management, with the entries and policies that use it. Reads only. */
export async function retireOverview(dataDir: string, ctx: TenantContext): Promise<RetireOverview> {
  const ro = new ReadOnlyApi(ctx.client);
  const t = ctx.tenantId;
  const [sites, policies] = await Promise.all([listLocalSites(ro, t), webPolicies(ro, t)]);
  const rows = new Map<string, TagRow>();
  const row = (tag: string) => rows.get(tag) ?? (rows.set(tag, { tag, entries: 0, only: 0, policies: [] }), rows.get(tag)!);
  for (const s of sites) for (const tag of s.tags ?? []) {
    const r = row(tag);
    r.entries++;
    if ((s.tags ?? []).length === 1 && s.categoryId === undefined) r.only++;
  }
  for (const p of policies) for (const ts of settingValue<TagSetting>(p, TAGS_KEY) ?? []) {
    row(ts.tag).policies.push({ id: p.id, name: p.name, action: ts.action, enabled: p.enabled ?? true, onProfile: usesWebProfile(p), targets: targetCount(targetsOf(p)) });
  }
  const snaps = await listSnapshots(dataDir, t);
  return {
    tags: [...rows.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    latestSnapshot: snaps[0]?.file ?? null,
    records: await listRecords(dataDir, t),
  };
}

export interface RetirePreview extends RetirePlan {
  warnings: string[];
  snapshotFile: string | null;
}

async function warningsFor(ro: TenantApi, t: string, tags: string[], policies: Policy[]): Promise<string[]> {
  const set = new Set(tags);
  const warnings: string[] = [];
  for (const p of policies) {
    const uses = (settingValue<TagSetting>(p, TAGS_KEY) ?? []).filter((x) => set.has(x.tag));
    if (!uses.length || p.enabled === false) continue;
    const n = targetCount(targetsOf(p));
    if (!usesWebProfile(p) && (n > 0 || p.priority === 0 || p.name === "Base Policy")) {
      warnings.push(`"${p.name}" still filters with classic settings and uses ${uses.map((u) => `${u.tag} (${u.action})`).join(", ")}; its devices lose these exceptions.`);
    }
  }
  // Devices on classic settings only matter when some policy still uses the tags.
  const used = policies.some((p) => p.enabled !== false && (settingValue<TagSetting>(p, TAGS_KEY) ?? []).some((x) => set.has(x.tag)));
  if (used) {
    const devices = await listAllEndpoints(ro, t);
    const classic = devices.map(deviceEligibility).filter((e) => e.platform !== "linux" && !e.eligible);
    if (classic.length) warnings.push(`${classic.length.toLocaleString("en-US")} devices can't use profiles and keep classic settings, so the policies that use these tags still apply them to those devices.`);
  }
  return warnings;
}

/** The plan against the latest snapshot. Reads only. */
export async function previewRetire(dataDir: string, ctx: TenantContext, tags: string[]): Promise<RetirePreview> {
  const ro = new ReadOnlyApi(ctx.client);
  const t = ctx.tenantId;
  if (!tags.length) throw new Error("Choose the tags to retire.");
  const [sites, policies] = await Promise.all([listLocalSites(ro, t), webPolicies(ro, t)]);
  const snaps = await listSnapshots(dataDir, t);
  const snapshotFile = snaps[0]?.file ?? null;
  const snapSites = snapshotFile ? (await loadSnapshot(dataDir, t, snapshotFile)).snapshot.objects.websiteManagement : null;
  const plan = planRetire(tags, snapSites, sites, policies);
  if (!snapshotFile) plan.problems = ["There's no rollback snapshot yet. Run the readiness check first.", ...plan.problems.filter((p) => !/snapshot has no/.test(p))];
  return { ...plan, warnings: await warningsFor(ro, t, tags, policies), snapshotFile };
}

function sameTags(a: TagSetting | undefined, b: TagSetting): boolean {
  const k = (x: TagSetting | undefined) => canonicalJson([...(x ?? [])].map((y) => `${y.tag}:${y.action}`).sort());
  return k(a) === k(b);
}

function sameList(a: string[] | undefined, b: string[]): boolean {
  return canonicalJson([...(a ?? [])].sort()) === canonicalJson([...b].sort());
}

/** Retires the tags: fresh snapshot, then policies, then entries. Refuses on a problem, or on warnings without confirm. */
export async function retire(dataDir: string, ctx: TenantContext, tags: string[], confirm: boolean, tool: { name: string; version: string }): Promise<RetireRecord> {
  const first = await previewRetire(dataDir, ctx, tags);
  if (first.problems.length) throw new Error(first.problems.join(" "));
  if (first.warnings.length && !confirm) throw new Error("Confirm the warnings first.");
  const t = ctx.tenantId;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const tenant: InventoryTenant = { id: t, name: ctx.summary.displayName, region: ctx.summary.region, apiHost: ctx.summary.apiHost, credentialType: ctx.summary.credentialType };
  const readiness = await runReadiness(dataDir, ctx.client, tenant, tool, { parallel: 3 });
  const snapshotFile = readiness.snapshot?.file;
  if (!snapshotFile) throw new Error(`No rollback snapshot could be saved, so nothing was retired. ${readiness.snapshotError ?? ""}`.trim());
  // Plan again against the snapshot just taken, so every entry touched is in it.
  const snap = (await loadSnapshot(dataDir, t, snapshotFile)).snapshot;
  const sites = snap.objects.websiteManagement ?? [];
  const policies = [...(snap.objects.webControlPolicies ?? []), ...(snap.objects.serverWebControlPolicies ?? [])];
  const plan = planRetire(tags, snap.objects.websiteManagement, sites, policies);
  if (plan.problems.length) throw new Error(plan.problems.join(" "));
  const byId = new Map(sites.map((s) => [s.id, s]));
  const record: RetireRecord = {
    id: randomUUID(),
    tenantId: t,
    at: new Date().toISOString(),
    tags,
    snapshotFile,
    status: "partial",
    steps: plan.steps.map((s) => ({ ...s, status: "planned", ...(s.op !== "policy-tags" ? { entry: byId.get(s.id) } : {}) })),
    warnings: first.warnings,
  };
  await saveRec(dataDir, record);
  for (const step of record.steps) {
    try {
      // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
      let unclear: UnclearWriteError | undefined;
      let resource = "local-site";
      let resourceId = "";
      if (step.op === "policy-tags") {
        const body = { settings: { [TAGS_KEY]: { value: step.after } } };
        [resource, resourceId] = ["policy", step.policyId];
        ({ unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "retire-tags", "policy", step.policyId, () => patchPolicy(api, t, step.policyId, body), { retire: record.id, removed: tags })));
        const back = await readBack(async () => {
          const p = await getPolicy(ro, t, step.policyId);
          return sameTags(settingValue<TagSetting>(p, TAGS_KEY), step.after) ? p : null;
        });
        step.readBack = back.value ? "tags match" : back.unread ? `not read: ${back.unread}` : "tags differ";
      } else if (step.op === "delete-entry") {
        resourceId = step.id;
        ({ unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "retire-delete", "local-site", step.id, () => deleteLocalSite(api, t, step.id), { retire: record.id, url: step.url, tags: step.tags })));
        step.readBack = await goneOnReadBack(() => getLocalSite(ro, t, step.id));
      } else {
        resourceId = step.id;
        ({ unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "retire-patch", "local-site", step.id, () => patchLocalSite(api, t, step.id, { tags: step.after }), { retire: record.id, url: step.url, before: step.before })));
        const back = await readBack(async () => {
          const s = await getLocalSite(ro, t, step.id);
          return sameList(s.tags, step.after) ? s : null;
        });
        step.readBack = back.value ? "tags match" : back.unread ? `not read: ${back.unread}` : "tags differ";
      }
      const notRead = !!step.readBack?.startsWith("not read");
      if (/match|404/.test(step.readBack ?? "") && !notRead) {
        step.status = "done";
        if (unclear) await auditOrWarn({ tenantId: t, action: `retire-${step.op === "policy-tags" ? "tags" : step.op === "delete-entry" ? "delete" : "patch"}`, resource, resourceId, ok: true, detail: { retire: record.id, note: foundNote(unclear, "the change", "in the tenant") } });
      } else if (unclear && !notRead) {
        // No clear answer, and a read-back found it unchanged: not made, so it stops the retire as a refusal does.
        const found = step.readBack;
        delete step.readBack;
        throw new Error(`${unclear.reason.replace(/\.$/, "")}. A read-back found it unchanged (${found}), so it wasn't made.`);
      } else {
        // Sophos accepted it (or gave no clear answer and nothing could be read): not confirmed. The retire goes on, as a rollback goes on past a delete it couldn't confirm, and Restore puts it back too.
        step.status = "unconfirmed";
        step.error = unconfirmed(step.readBack, "change");
        // How Sophos answered when it wasn't a success: the page then doesn't say Sophos accepted the retire.
        if (unclear) step.answer = unclear.reason.replace(/\.$/, "");
      }
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      break;
    } finally {
      await saveRec(dataDir, record);
    }
  }
  record.status = record.steps.every((s) => s.status === "done") ? "retired" : record.steps.some((s) => s.status === "done" || s.status === "unconfirmed") ? "partial" : "failed";
  const left = tagsLeftNamed(record);
  if (left.length) record.tagsMayRemain = left;
  await saveRec(dataDir, record);
  return record;
}

/**
 * Reads an entry back after its delete, until it answers 404: "404 on read-back", "still there", or "not read: " and why
 * when no read worked (any answer but a 404 is a read that failed, not proof it's there).
 */
async function goneOnReadBack(get: () => Promise<unknown>): Promise<string> {
  const gone = await readBack(async () => {
    try {
      await get();
      return null;
    } catch (err) {
      if (errorStatus(err) === 404) return true;
      throw err;
    }
  });
  return gone.value ? "404 on read-back" : gone.unread ? `not read: ${gone.unread}` : "still there";
}

/** Why a write Sophos accepted isn't confirmed, from its read-back. What Sophos answered stays in the read-back, for a Detail line. */
function unconfirmed(readBack: string | undefined, what: "change" | "restore"): string {
  return readBack?.startsWith("not read") ? `The tool couldn't read it back, so the ${what} isn't confirmed.` : `Read back: ${readBack}.`;
}

/** Puts back everything a retire changed: entries first, then the policies. */
export async function restoreRetire(dataDir: string, ctx: TenantContext, id: string): Promise<RetireRecord> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a retire ID.");
  const t = ctx.tenantId;
  const text = await readText(path.join(dir(dataDir, t), `${id}.json`), SECTION);
  if (!text) throw new Error("No such retire record.");
  const record = asSavedNow(JSON.parse(text) as RetireRecord);
  // The restore puts the entries back before the tags, and its own steps say what it confirmed.
  delete record.tagsMayRemain;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  // A failed step may or may not have reached Sophos, and an unconfirmed one may have; putting either back is safe.
  const done = record.steps.filter((s) => s.status === "done" || s.status === "unconfirmed" || s.status === "failed" || s.status === "restore-failed");
  const order = [...done.filter((s) => s.op === "delete-entry"), ...done.filter((s) => s.op === "patch-entry"), ...done.filter((s) => s.op === "policy-tags")];
  for (const step of order) {
    // From here the read-back and error are this restore's, set only by what it finds.
    delete step.readBack;
    delete step.answer;
    delete step.error;
    try {
      if (step.op === "delete-entry") {
        const e = step.entry;
        if (!e) throw new Error("The record has no copy of this entry.");
        const exists = (await listLocalSites(ro, t)).find((s) => s.url.toLowerCase() === e.url.toLowerCase());
        if (exists) {
          step.newId = exists.id;
          step.readBack = "already there";
        } else {
          const body = { url: e.url, ...(e.tags?.length ? { tags: e.tags } : {}), ...(e.categoryId !== undefined ? { categoryId: e.categoryId } : {}), ...(e.comment ? { comment: e.comment } : {}) };
          const { value } = await auditedCreate(
            t,
            "local-site",
            () => createLocalSite(api, t, body),
            async () => (await listLocalSites(ro, t)).find((s) => s.url.toLowerCase() === e.url.toLowerCase()) ?? null,
            "the Website Management entry",
            { where: "Website Management", found: `no entry for ${e.url}` },
            { restoreOf: record.id, url: e.url, tags: e.tags },
          );
          step.newId = value.id;
          // Made: a read that fails leaves it unconfirmed, not failed.
          const back = await readBack(() => getLocalSite(ro, t, value.id));
          step.readBack = back.value
            ? sameList(back.value.tags, e.tags ?? []) && (back.value.categoryId ?? null) === (e.categoryId ?? null)
              ? "re-created, matches"
              : "re-created, differs"
            : `not read: ${back.unread ?? "no read-back"}`;
        }
      } else if (step.op === "patch-entry") {
        await auditedWrite({ tenantId: t }, "restore-patch", "local-site", step.id, () => patchLocalSite(api, t, step.id, { tags: step.before }), { restoreOf: record.id, url: step.url });
        const back = await readBack(async () => {
          const s = await getLocalSite(ro, t, step.id);
          return sameList(s.tags, step.before) ? s : null;
        });
        step.readBack = back.value ? "tags match" : back.unread ? `not read: ${back.unread}` : "tags differ";
      } else {
        const body = { settings: { [TAGS_KEY]: { value: step.before } } };
        await auditedWrite({ tenantId: t }, "restore-tags", "policy", step.policyId, () => patchPolicy(api, t, step.policyId, body), { restoreOf: record.id });
        const back = await readBack(async () => {
          const p = await getPolicy(ro, t, step.policyId);
          return sameTags(settingValue<TagSetting>(p, TAGS_KEY), step.before) ? p : null;
        });
        step.readBack = back.value ? "tags match" : back.unread ? `not read: ${back.unread}` : "tags differ";
      }
      step.status = /match|already there/.test(step.readBack ?? "") && !/differs|^not read/.test(step.readBack ?? "") ? "restored" : "restore-failed";
      if (step.status === "restore-failed") step.error = unconfirmed(step.readBack, "restore");
    } catch (err) {
      step.status = "restore-failed";
      step.error = err instanceof Error ? err.message : String(err);
    }
    await saveRec(dataDir, record);
  }
  record.status = record.steps.every((s) => s.status === "restored" || s.status === "planned") ? "restored" : "restore-partial";
  record.restoredAt = new Date().toISOString();
  await saveRec(dataDir, record);
  return record;
}
