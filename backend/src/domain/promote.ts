/**
 * Promotion and retirement.
 *
 * planWaves() splits the devices that can use profiles (Windows on 2026.1 or
 * later) and aren't in the pilot yet into waves, grouped by device group so a
 * wave follows how the estate is organized. Devices that can't use profiles
 * stay on a classic policy and are listed apart.
 *
 * planRetire() works out how to retire Website Management tags: take the tags
 * out of every policy's tags.settings first (a policy that names a tag with no
 * entries can't be written: the API answers 500), then delete the entries
 * that carried only retired tags and patch the rest. It refuses an entry the
 * snapshot doesn't hold, because the snapshot is what puts it back.
 *
 * Pure: no Node or browser imports.
 */

import { deviceEligibility, type DeviceLike } from "./eligibility.js";
import { parseSite } from "./sites.js";
import { settingValue } from "./inventory.js";
import type { LocalSite } from "../sophos/api/web-control.js";
import type { Policy } from "../sophos/api/policies.js";

export interface WaveDevice {
  id: string;
  hostname: string;
  group: string;
}

export interface WavePlan {
  waves: Array<{ n: number; devices: WaveDevice[] }>;
  inPilot: WaveDevice[];
  notEligible: Array<WaveDevice & { reason: string }>;
}

/**
 * A Web Control policy takes computers, a server Web Control policy takes
 * servers, so devices of the other kind are listed apart rather than waved.
 */
export function planWaves(devices: DeviceLike[], pilotEndpoints: string[], waveSize: number, kind: "computer" | "server" = "computer"): WavePlan {
  const size = Math.max(1, Math.floor(waveSize));
  const inPilotIds = new Set(pilotEndpoints);
  const rows = devices.map((d) => ({ d, e: deviceEligibility(d) })).filter(({ e }) => e.platform !== "linux");
  const toWave = (x: (typeof rows)[number]): WaveDevice => ({ id: x.d.id, hostname: x.e.hostname, group: x.d.group?.name ?? "No group" });
  const fits = (x: (typeof rows)[number]) => x.e.kind === kind;
  const eligible = rows.filter((r) => fits(r) && r.e.eligible && !inPilotIds.has(r.d.id)).map(toWave);
  eligible.sort((a, b) => a.group.localeCompare(b.group) || a.hostname.localeCompare(b.hostname));
  const waves: WavePlan["waves"] = [];
  for (let i = 0; i < eligible.length; i += size) waves.push({ n: waves.length + 1, devices: eligible.slice(i, i + size) });
  return {
    waves,
    inPilot: rows.filter((r) => inPilotIds.has(r.d.id)).map(toWave),
    notEligible: rows
      .filter((r) => !inPilotIds.has(r.d.id) && (!fits(r) || !r.e.eligible))
      .map((r) => ({ ...toWave(r), reason: fits(r) ? r.e.reason : r.e.kind === "server" ? "server" : "computer" })),
  };
}

export type RetireStep =
  | { op: "policy-tags"; policyId: string; policyName: string; before: Array<{ tag: string; action: string }>; after: Array<{ tag: string; action: string }> }
  | { op: "delete-entry"; id: string; url: string; tags: string[] }
  | { op: "patch-entry"; id: string; url: string; before: string[]; after: string[] };

export interface RetirePlan {
  tags: string[];
  steps: RetireStep[];
  problems: string[];
}

function key(url: string): string {
  return parseSite(url).value || url.trim().toLowerCase();
}

export function planRetire(tags: string[], snapshotSites: LocalSite[] | null, current: LocalSite[], policies: Policy[]): RetirePlan {
  const retire = new Set(tags);
  const problems: string[] = [];
  const steps: RetireStep[] = [];
  if (!snapshotSites) problems.push("The snapshot has no Website Management section, so nothing could be put back. Take a new snapshot first.");
  for (const p of policies) {
    const before = settingValue<Array<{ tag: string; action: string }>>(p, "endpoint.web-control.tags.settings") ?? [];
    const after = before.filter((t) => !retire.has(t.tag));
    if (after.length !== before.length) steps.push({ op: "policy-tags", policyId: p.id, policyName: p.name, before, after });
  }
  const inSnapshot = new Map((snapshotSites ?? []).map((s) => [key(s.url), s]));
  for (const s of current) {
    const own = s.tags ?? [];
    if (!own.some((t) => retire.has(t))) continue;
    const snap = inSnapshot.get(key(s.url));
    if (!snap) {
      problems.push(`${s.url} isn't in the snapshot; take a new snapshot before retiring its tags.`);
      continue;
    }
    const remaining = own.filter((t) => !retire.has(t));
    if (remaining.length === 0 && s.categoryId === undefined) steps.push({ op: "delete-entry", id: s.id, url: s.url, tags: own });
    else steps.push({ op: "patch-entry", id: s.id, url: s.url, before: own, after: remaining });
  }
  if (!steps.some((s) => s.op !== "policy-tags")) problems.push("No Website Management entry carries these tags.");
  // Policies first: a policy naming a tag with no entries can't be written afterwards.
  steps.sort((a, b) => Number(a.op !== "policy-tags") - Number(b.op !== "policy-tags"));
  return { tags, steps, problems };
}
