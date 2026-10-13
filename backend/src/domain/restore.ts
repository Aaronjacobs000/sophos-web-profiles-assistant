/**
 * Putting a tenant back the way a snapshot found it, and checking that it is.
 *
 * planWebsiteManagementRestore() compares the snapshot's Website Management
 * entries with the tenant's now, by URL (a re-created entry gets a new id),
 * and plans the writes: re-create what's missing, patch what changed, and
 * delete only entries this tool created. Entries someone else added since the
 * snapshot are left alone; several tools can share a tenant.
 *
 * compareToSnapshot() diffs two snapshots of the same tenant: everything in
 * the first must be in the second unchanged. Policies are compared by their
 * order among the snapshot's own policies, not by priority number, because a
 * policy someone else adds shifts every priority below it.
 *
 * Pure: no Node or browser imports.
 */

import { canonicalJson, type Snapshot } from "./snapshot.js";
import { parseSite } from "./sites.js";
import type { LocalSite } from "../sophos/api/web-control.js";
import type { Policy } from "../sophos/api/policies.js";

export type RestoreStep =
  | { op: "create"; url: string; body: { url: string; tags?: string[]; categoryId?: number; comment?: string } }
  | { op: "patch"; id: string; url: string; body: Record<string, unknown>; was: Record<string, unknown> }
  | { op: "delete"; id: string; url: string };

function key(url: string): string {
  return parseSite(url).value || url.trim().toLowerCase();
}

function same(a: LocalSite, b: LocalSite): boolean {
  return (
    canonicalJson([...(a.tags ?? [])].sort()) === canonicalJson([...(b.tags ?? [])].sort()) &&
    (a.categoryId ?? null) === (b.categoryId ?? null) &&
    (a.comment ?? "") === (b.comment ?? "")
  );
}

export function planWebsiteManagementRestore(snapshot: LocalSite[], current: LocalSite[], createdByTool: Set<string> = new Set()): RestoreStep[] {
  const steps: RestoreStep[] = [];
  const now = new Map(current.map((c) => [key(c.url), c]));
  for (const s of snapshot) {
    const c = now.get(key(s.url));
    if (!c) {
      steps.push({
        op: "create",
        url: s.url,
        body: { url: s.url, ...(s.tags?.length ? { tags: s.tags } : {}), ...(s.categoryId !== undefined ? { categoryId: s.categoryId } : {}), ...(s.comment ? { comment: s.comment } : {}) },
      });
    } else if (!same(s, c)) {
      steps.push({
        op: "patch",
        id: c.id,
        url: s.url,
        body: { tags: s.tags ?? [], categoryId: s.categoryId ?? null, comment: s.comment ?? null },
        was: { tags: c.tags ?? [], categoryId: c.categoryId ?? null, comment: c.comment ?? null },
      });
    }
  }
  const inSnapshot = new Set(snapshot.map((s) => key(s.url)));
  for (const c of current) {
    if (!inSnapshot.has(key(c.url)) && createdByTool.has(c.id)) steps.push({ op: "delete", id: c.id, url: c.url });
  }
  return steps;
}

export interface SectionDiff {
  section: string;
  matched: number;
  changed: Array<{ id: string; name: string; fields: string[] }>;
  /** In the snapshot but gone now. byTool when this tool deleted it (its audit log says so). */
  missing: Array<{ id: string; name: string; byTool: boolean }>;
  /** In the tenant now but not in the snapshot. */
  extra: Array<{ id: string; name: string; byTool: boolean }>;
}

export interface SnapshotDiff {
  /**
   * True when everything this tool touched matches the snapshot: nothing in it
   * changed, nothing this tool deleted is missing, and nothing this tool
   * created is left. Objects other tools added or removed since are reported
   * but don't count, because several tools can share a tenant.
   */
  matches: boolean;
  /** True when the tenant is identical to the snapshot, other tools' changes included. */
  identical: boolean;
  sections: SectionDiff[];
  /** Objects someone else added or removed since the snapshot. */
  othersCount: number;
}

function diffById<T extends { id: string; name?: string }>(
  section: string,
  before: T[] | null,
  after: T[] | null,
  compare: (a: T, b: T) => string[],
  createdByTool: Set<string>,
  deletedByTool: Set<string> = new Set(),
): SectionDiff {
  const d: SectionDiff = { section, matched: 0, changed: [], missing: [], extra: [] };
  if (!before || !after) return d;
  const now = new Map(after.map((x) => [x.id, x]));
  for (const b of before) {
    const a = now.get(b.id);
    if (!a) d.missing.push({ id: b.id, name: b.name ?? b.id, byTool: deletedByTool.has(b.id) });
    else {
      const fields = compare(b, a);
      if (fields.length) d.changed.push({ id: b.id, name: b.name ?? b.id, fields });
      else d.matched++;
    }
  }
  const was = new Set(before.map((b) => b.id));
  for (const a of after) if (!was.has(a.id)) d.extra.push({ id: a.id, name: a.name ?? a.id, byTool: createdByTool.has(a.id) });
  return d;
}

function appliesKey(p: Policy): string {
  const a = p.appliesTo ?? {};
  return canonicalJson(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, [...(v ?? [])].sort()])));
}

function policyFields(order: Map<string, number>, orderAfter: Map<string, number>) {
  return (b: Policy, a: Policy): string[] => {
    const f: string[] = [];
    if (b.name !== a.name) f.push("name");
    if ((b.enabled ?? true) !== (a.enabled ?? true)) f.push("enabled");
    if (appliesKey(b) !== appliesKey(a)) f.push("appliesTo");
    if (order.get(b.id) !== orderAfter.get(a.id)) f.push("order");
    const keys = new Set([...Object.keys(b.settings ?? {}), ...Object.keys(a.settings ?? {})]);
    for (const k of keys) {
      if (canonicalJson(b.settings?.[k]?.value) !== canonicalJson(a.settings?.[k]?.value)) f.push(k.replace(/^endpoint\./, ""));
    }
    return f;
  };
}

/** Rank of each policy among the given ids (those in both the snapshot and the tenant now), top first. */
function relativeOrder(policies: Policy[], ids: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = policies.filter((p) => ids.has(p.id)).sort((a, b) => (a.priority === 0 ? 1e9 : a.priority ?? 1e9) - (b.priority === 0 ? 1e9 : b.priority ?? 1e9));
  sorted.forEach((p, i) => out.set(p.id, i));
  return out;
}

export function compareToSnapshot(
  before: Snapshot,
  after: Snapshot,
  createdByTool: Set<string> = new Set(),
  deletedByTool: Set<string> = new Set(),
): SnapshotDiff {
  const sections: SectionDiff[] = [];
  for (const kind of ["webControlPolicies", "serverWebControlPolicies"] as const) {
    const b = before.objects[kind];
    const a = after.objects[kind];
    // Order is compared among the policies in both, so one someone else removed doesn't shift the rest.
    const now = new Set((a ?? []).map((p) => p.id));
    const ids = new Set((b ?? []).map((p) => p.id).filter((id) => now.has(id)));
    sections.push(diffById(kind, b, a, policyFields(relativeOrder(b ?? [], ids), relativeOrder(a ?? [], ids)), createdByTool, deletedByTool));
  }
  sections.push(
    diffById("threatProtectionWebSettings", before.objects.threatProtectionWebSettings, after.objects.threatProtectionWebSettings, (b, a) => {
      const f: string[] = [];
      if (canonicalJson(b.settings) !== canonicalJson(a.settings)) f.push("settings");
      if (canonicalJson(b.webExclusions) !== canonicalJson(a.webExclusions)) f.push("webExclusions");
      return f;
    }, createdByTool, deletedByTool),
  );
  sections.push(
    diffById("webFilteringProfiles", before.objects.webFilteringProfiles, after.objects.webFilteringProfiles, (b, a) => {
      const strip = (p: Record<string, unknown>) => {
        const { updatedAt, updatedBy, consumers, ...rest } = p;
        void updatedAt;
        void updatedBy;
        void consumers;
        return canonicalJson(rest);
      };
      return strip(b as unknown as Record<string, unknown>) === strip(a as unknown as Record<string, unknown>) ? [] : ["settings"];
    }, createdByTool, deletedByTool),
  );
  sections.push(
    diffById("siteLists", before.objects.siteLists, after.objects.siteLists, (b, a) => {
      const f: string[] = [];
      if (b.name !== a.name) f.push("name");
      if ((b.description ?? "") !== (a.description ?? "")) f.push("description");
      if (canonicalJson(b.sites.map((s) => s.site).sort()) !== canonicalJson(a.sites.map((s) => s.site).sort())) f.push("sites");
      return f;
    }, createdByTool, deletedByTool),
  );
  // Website Management by URL: a restored entry has a new id.
  const wmB = before.objects.websiteManagement;
  const wmA = after.objects.websiteManagement;
  const wm: SectionDiff = { section: "websiteManagement", matched: 0, changed: [], missing: [], extra: [] };
  if (wmB && wmA) {
    const now = new Map(wmA.map((x) => [key(x.url), x]));
    for (const b of wmB) {
      const a = now.get(key(b.url));
      if (!a) wm.missing.push({ id: b.id, name: b.url, byTool: deletedByTool.has(b.id) });
      else if (!same(b, a)) wm.changed.push({ id: b.id, name: b.url, fields: ["tags, category or comment"] });
      else wm.matched++;
    }
    const was = new Set(wmB.map((b) => key(b.url)));
    for (const a of wmA) if (!was.has(key(a.url))) wm.extra.push({ id: a.id, name: a.url, byTool: createdByTool.has(a.id) });
  }
  sections.push(wm);
  const exB = before.objects.webScanningExclusions ?? [];
  const exA = after.objects.webScanningExclusions ?? [];
  sections.push(diffById("webScanningExclusions", exB.map((x) => ({ ...x, name: x.value })), exA.map((x) => ({ ...x, name: x.value })), (b, a) => (b.value === a.value && b.type === a.type ? [] : ["value"]), createdByTool, deletedByTool));
  const tls: SectionDiff = { section: "tlsDecryption", matched: 0, changed: [], missing: [], extra: [] };
  if (before.objects.tlsDecryption && after.objects.tlsDecryption) {
    const pick = (t: NonNullable<Snapshot["objects"]["tlsDecryption"]>) => canonicalJson({ categories: t.categories, excluded: t.excludedWebsiteItems });
    if (pick(before.objects.tlsDecryption) === pick(after.objects.tlsDecryption)) tls.matched = 1;
    else tls.changed.push({ id: "tls-decryption", name: "SSL/TLS decryption settings", fields: ["categories or excluded websites"] });
  }
  sections.push(tls);

  const othersCount = sections.reduce((n, s) => n + s.extra.filter((e) => !e.byTool).length + s.missing.filter((m) => !m.byTool).length, 0);
  const matches = sections.every((s) => s.changed.length === 0 && s.missing.every((m) => !m.byTool) && s.extra.every((e) => !e.byTool));
  const identical = sections.every((s) => s.changed.length === 0 && s.missing.length === 0 && s.extra.length === 0);
  return { matches, identical, sections, othersCount };
}
