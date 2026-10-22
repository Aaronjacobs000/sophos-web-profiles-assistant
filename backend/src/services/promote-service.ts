/**
 * Promotion: moving devices onto the pilot policy one wave at
 * a time.
 *
 * Waves hold only devices that can use profiles (Windows on 2026.1 or later)
 * and aren't on the pilot yet. Moving a wave adds its devices to the pilot
 * policy's appliesTo in one PATCH, always in the device shape (endpoints plus
 * endpointGroups, because device groups alone get a 500), then reads the
 * policy back until the assignment shows. A pilot assigned to users or user
 * groups can't take devices (the API refuses a mix with 400), so it's
 * promoted in Sophos Fusion by user group instead. Each wave can be undone,
 * which puts the assignment back as it was before that wave. A move Sophos
 * accepted that the read-back didn't confirm is kept as not confirmed, and
 * can be undone like a confirmed one (category D).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../sophos/tenant-context.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { getPolicy, patchPolicy, type Policy } from "../sophos/api/policies.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { appliesToFor } from "../domain/design.js";
import { planWaves, type WavePlan } from "../domain/promote.js";
import { deviceEligibility } from "../domain/eligibility.js";
import { canonicalJson } from "../domain/snapshot.js";
import { auditedWrite, auditOrWarn } from "./audit-log.js";
import { activePilot, type PilotInfo } from "./pilot-service.js";
import { serverRefusal } from "./build-service.js";
import { foundNote, readBack, sendChecked } from "./write-check.js";
import { readText, saveFile } from "./safe-files.js";

const SECTION = "promote";
const REASON_TEXT: Record<string, string> = {
  "windows-old-agent": "Windows below Sophos Endpoint 2026.1",
  "windows-no-agent-version": "no agent version reported",
  macos: "macOS keeps classic settings",
  other: "not Windows",
};

type Assignment = { endpoints: string[]; endpointGroups: string[] };

/** Why a wave undo is refused while the pilot policy can't be read. */
export const WAVE_UNDO_UNREAD = "Undo is off: the tool couldn't read the pilot policy, so it can't check the assignment first. Try again later, or check it in Sophos Fusion.";

/** Why a wave undo is refused when the pilot policy is no longer in the tenant (a 404). */
export const WAVE_UNDO_GONE = "Undo is off: the pilot policy is no longer in the tenant, so there's no assignment to put back.";

/** The waves that can be undone: moved, moved but not confirmed, and an undo that didn't finish. */
export const WAVE_UNDOABLE: ReadonlyArray<WaveRecord["status"]> = ["moved", "unconfirmed", "undo-failed"];

/** What a wave undo records when the assignment was already as it was before the wave, so nothing was sent. */
export const ALREADY_BEFORE = "assignment already as before the wave";

export interface WaveRecord {
  id: string;
  at: string;
  buildId: string;
  policyId: string;
  devices: Array<{ id: string; hostname: string }>;
  before: Assignment;
  after: Assignment;
  /** unconfirmed: Sophos accepted the move (or gave no clear answer and nothing could be read), but the read-back didn't confirm it. */
  status: "moved" | "unconfirmed" | "failed" | "undone" | "undo-failed";
  /** What the read-back after the move found. Set only once Sophos accepted the change, so a wave with one was sent. */
  readBack?: string;
  /** The same for the last undo: set only when Sophos accepted the undo, or gave no clear answer, but the read-back didn't confirm it. */
  undoReadBack?: string;
  /**
   * Set with readBack when Sophos didn't answer the move with a success (a 5xx, no answer in time or a dropped
   * connection) and nothing could be read back: what it said. Without it, Sophos accepted the move. undoAnswer is the
   * same for the last undo, with undoReadBack.
   */
  answer?: string;
  undoAnswer?: string;
  error?: string;
  undoneAt?: string;
}

interface PromoteRecord {
  tenantId: string;
  waves: WaveRecord[];
}

function recordPath(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "promote", `${tenantId}.json`);
}

async function load(dataDir: string, tenantId: string): Promise<PromoteRecord> {
  const text = await readText(recordPath(dataDir, tenantId), SECTION).catch(() => null);
  const r = text ? (JSON.parse(text) as PromoteRecord) : { tenantId, waves: [] };
  // Before v0.3.20 a move Sophos accepted that the read-back didn't confirm was saved as failed, with its read-back.
  for (const w of r.waves) if (w.status === "failed" && w.readBack) w.status = "unconfirmed";
  return r;
}

async function save(dataDir: string, r: PromoteRecord): Promise<void> {
  const file = recordPath(dataDir, r.tenantId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify(r, null, 2), { section: SECTION, mode: 0o600 });
}

function sorted(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])].sort();
}

function assignmentOf(p: Policy): Assignment {
  return { endpoints: sorted(p.appliesTo?.endpoints), endpointGroups: sorted(p.appliesTo?.endpointGroups) };
}

function same(a: Assignment, b: Assignment): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface PromotionView {
  pilot: PilotInfo | null;
  /** Null with a pilot when the pilot policy is no longer in the tenant. */
  policy: { id: string; name: string; enabled: boolean; priority?: number; type: string; endpoints: number; endpointGroups: number; users: number; userGroups: number } | null;
  mode: "devices" | "users" | "none";
  plan: WavePlan | null;
  waves: WaveRecord[];
  /** The wave size used: the one asked for, or about ten waves' worth. */
  waveSize: number;
  problem?: string;
  /** Why the pilot policy wasn't read, when Sophos answered anything but a 404 (that doesn't show it's gone). There's no plan then. */
  policyUnread?: string;
}

/** About ten waves: 25 devices a wave for a small estate, more for a large one, in steps of 25. */
export function suggestedWaveSize(candidates: number): number {
  return Math.min(500, Math.max(25, Math.ceil(candidates / 10 / 25) * 25));
}

export async function promotionView(dataDir: string, ctx: TenantContext, waveSizeIn: number | null): Promise<PromotionView> {
  const t = ctx.tenantId;
  const pilot = await activePilot(dataDir, t);
  const waves = (await load(dataDir, t)).waves;
  const ro = new ReadOnlyApi(ctx.client);
  if (!pilot) {
    // No pilot yet: still show how the devices would split into waves, for planning.
    const devices = await listAllEndpoints(ro, t);
    const waveSize = waveSizeIn ?? suggestedWaveSize(planWaves(devices, [], 1, "computer").waves.length);
    return { pilot, policy: null, mode: "none", plan: planWaves(devices, [], waveSize, "computer"), waves, waveSize, problem: "There's no pilot yet, so these waves are a plan only. Build one in the Build step to move devices." };
  }
  let unread: string | undefined;
  const [policy, devices] = await Promise.all([
    // A pilot policy deleted in Sophos Fusion, or by a rollback Sophos answered with an error, answers 404.
    getPolicy(ro, t, pilot.policyId).catch((err) => {
      if (errorStatus(err) !== 404) unread = err instanceof Error ? err.message : String(err);
      return null;
    }),
    listAllEndpoints(ro, t),
  ]);
  if (unread) {
    // Not read (a 403, a 5xx, no answer in time): it may still be there, so no plan from an assignment that wasn't read.
    return { pilot, policy: null, mode: "none", plan: null, waves, waveSize: waveSizeIn ?? 25, policyUnread: unread };
  }
  if (!policy) {
    const waveSize = waveSizeIn ?? suggestedWaveSize(planWaves(devices, [], 1, "computer").waves.length);
    return {
      pilot,
      policy: null,
      mode: "none",
      plan: planWaves(devices, [], waveSize, "computer"),
      waves,
      waveSize,
      problem: `The pilot policy "${pilot.policyName}" is no longer in the tenant, so there's nothing to promote. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`,
    };
  }
  const a = policy.appliesTo ?? {};
  const users = (a.users?.length ?? 0) + (a.userGroups?.length ?? 0);
  const kind = policy.type === "server-web-control" ? "server" : "computer";
  const waveSize = waveSizeIn ?? suggestedWaveSize(planWaves(devices, a.endpoints ?? [], 1, kind).waves.length);
  const view: PromotionView = {
    pilot,
    policy: {
      id: policy.id,
      name: policy.name,
      enabled: policy.enabled ?? true,
      priority: policy.priority,
      type: policy.type,
      endpoints: a.endpoints?.length ?? 0,
      endpointGroups: a.endpointGroups?.length ?? 0,
      users: a.users?.length ?? 0,
      userGroups: a.userGroups?.length ?? 0,
    },
    mode: users ? "users" : "devices",
    plan: planWaves(devices, a.endpoints ?? [], waveSize, kind),
    waves,
    waveSize,
  };
  if (users) view.problem = "The pilot is assigned to users or user groups, and a policy can't hold users and devices together. Promote it by adding user groups in Sophos Fusion, or build a device pilot.";
  return view;
}

export interface WavePreview {
  before: Assignment;
  after: Assignment;
  devices: Array<{ id: string; hostname: string }>;
  problems: string[];
  policyName: string;
  enabled: boolean;
}

async function previewWave(dataDir: string, ctx: TenantContext, deviceIds: string[]): Promise<{ pilot: PilotInfo; preview: WavePreview }> {
  const t = ctx.tenantId;
  const pilot = await activePilot(dataDir, t);
  if (!pilot) throw new Error("There's no pilot yet. Build one in the Build step first.");
  const ro = new ReadOnlyApi(ctx.client);
  const [policy, devices] = await Promise.all([getPolicy(ro, t, pilot.policyId), listAllEndpoints(ro, t)]);
  const problems: string[] = [];
  if ((policy.appliesTo?.users?.length ?? 0) + (policy.appliesTo?.userGroups?.length ?? 0)) problems.push("The pilot is assigned to users, so it can't take devices.");
  const byId = new Map(devices.map((d) => [d.id, d]));
  const kind = policy.type === "server-web-control" ? "server" : "computer";
  const before = assignmentOf(policy);
  const wave: WavePreview["devices"] = [];
  for (const id of [...new Set(deviceIds)]) {
    const d = byId.get(id);
    if (!d) {
      problems.push(`Device ${id} doesn't exist.`);
      continue;
    }
    const e = deviceEligibility(d);
    if (e.kind === "server" && kind === "computer") problems.push(serverRefusal([e.hostname], "device"));
    else if (e.kind !== kind) problems.push(`${e.hostname} is a computer; this pilot is a server Web Control policy, which applies to servers.`);
    else if (!e.eligible) problems.push(`${e.hostname} can't use profiles (${REASON_TEXT[e.reason] ?? e.reason}).`);
    else if (before.endpoints.includes(id)) problems.push(`${e.hostname} is already on the pilot.`);
    else wave.push({ id, hostname: e.hostname });
  }
  if (!deviceIds.length) problems.push("Choose the devices for this wave.");
  const after = { endpoints: sorted([...before.endpoints, ...wave.map((w) => w.id)]), endpointGroups: before.endpointGroups };
  return { pilot, preview: { before, after, devices: wave, problems, policyName: policy.name, enabled: policy.enabled ?? true } };
}

/** Dry run, or the move: one PATCH of the pilot's appliesTo, read back. */
export async function moveWave(dataDir: string, ctx: TenantContext, deviceIds: string[], dryRun: boolean): Promise<WavePreview | WaveRecord> {
  const { pilot, preview } = await previewWave(dataDir, ctx, deviceIds);
  if (dryRun) return preview;
  if (preview.problems.length) throw new Error(preview.problems.join(" "));
  const t = ctx.tenantId;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const record = await load(dataDir, t);
  const wave: WaveRecord = {
    id: randomUUID(),
    at: new Date().toISOString(),
    buildId: pilot.buildId,
    policyId: pilot.policyId,
    devices: preview.devices,
    before: preview.before,
    after: preview.after,
    status: "failed",
  };
  record.waves.unshift(wave);
  try {
    const body = { appliesTo: appliesToFor({ endpoints: preview.after.endpoints, endpointGroups: preview.after.endpointGroups }) };
    // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
    const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "update", "policy", pilot.policyId, () => patchPolicy(api, t, pilot.policyId, body), { wave: wave.id, added: preview.devices.map((d) => d.hostname) }));
    const back = await readBack(async () => {
      const p = await getPolicy(ro, t, pilot.policyId);
      return same(assignmentOf(p), preview.after) ? p : null;
    });
    if (back.value) {
      wave.status = "moved";
      wave.readBack = "assignment matches";
      if (unclear) await auditOrWarn({ tenantId: t, action: "update", resource: "policy", resourceId: pilot.policyId, ok: true, detail: { wave: wave.id, note: foundNote(unclear, "the new devices", "on the pilot") } });
    } else if (unclear && !back.unread) {
      // No clear answer, and the pilot read back without the new devices: not moved, as a rollback counts a delete still found. The devices stay in the plan, so the wave can be moved again.
      wave.error = `${unclear.reason.replace(/\.$/, "")}. A read-back found the pilot without the new devices, so the wave wasn't moved. Move it again in a minute or two if they're still not on the pilot.`;
    } else {
      // Sophos accepted the move (or gave no clear answer and nothing could be read): it may be in place, so it's not confirmed and can be undone.
      // A read that failed doesn't show the devices are missing, only that the move isn't confirmed.
      wave.status = "unconfirmed";
      wave.readBack = back.unread ? `not read: ${back.unread}` : "assignment differs";
      // How Sophos answered when it wasn't a success: the page then doesn't say Sophos accepted the move.
      if (unclear) wave.answer = unclear.reason.replace(/\.$/, "");
      wave.error = back.unread ? "The tool couldn't read the pilot policy back, so the move isn't confirmed." : "The policy read back without the new devices.";
    }
  } catch (err) {
    wave.error = err instanceof Error ? err.message : String(err);
  }
  await save(dataDir, record);
  return wave;
}

/** Puts the pilot's assignment back as it was before the wave. Refused when a later wave is still in place. */
export async function undoWave(dataDir: string, ctx: TenantContext, waveId: string): Promise<WaveRecord> {
  const t = ctx.tenantId;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const record = await load(dataDir, t);
  const wave = record.waves.find((w) => w.id === waveId);
  if (!wave) throw new Error("No such wave.");
  if (!WAVE_UNDOABLE.includes(wave.status)) throw new Error(`This wave is ${wave.status}; there's nothing to undo.`);
  // A later wave that isn't confirmed may be in place too.
  const later = record.waves.find((w) => w.policyId === wave.policyId && (w.status === "moved" || w.status === "unconfirmed") && w.at > wave.at);
  if (later) throw new Error("Undo the later waves first.");
  // Gone (a 404): there's no assignment to put back. Not read (a 403, a 5xx, no answer in time): it can't be checked. Either way, refuse and leave the wave as it was.
  const read = await getPolicy(ro, t, wave.policyId).catch((err: unknown) => {
    throw new Error(errorStatus(err) === 404 ? WAVE_UNDO_GONE : WAVE_UNDO_UNREAD);
  });
  // Only this attempt's read-back counts.
  delete wave.undoReadBack;
  delete wave.undoAnswer;
  try {
    const current = assignmentOf(read);
    // A move or an undo that wasn't confirmed may not have gone through: when the assignment is already as it was before the wave, there's nothing to put back.
    const already = wave.status !== "moved" && same(current, wave.before);
    if (!already) {
      if (!same(current, wave.after)) throw new Error("The pilot's assignment has changed since this wave, so it wasn't put back. Check it in Sophos Fusion.");
      const body = { appliesTo: appliesToFor({ endpoints: wave.before.endpoints, endpointGroups: wave.before.endpointGroups }) };
      // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
      const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "update", "policy", wave.policyId, () => patchPolicy(api, t, wave.policyId, body), { undoWave: wave.id, removed: wave.devices.map((d) => d.hostname) }));
      const back = await readBack(async () => {
        const p = await getPolicy(ro, t, wave.policyId);
        return same(assignmentOf(p), wave.before) ? p : null;
      });
      if (!back.value && unclear && !back.unread) throw new Error(`${unclear.reason.replace(/\.$/, "")}. A read-back found the pilot with this wave's devices still on it, so the undo wasn't made. Undo again in a minute or two.`);
      if (!back.value) {
        // Sophos accepted the undo (or gave no clear answer and nothing could be read), but the read-back didn't confirm it.
        wave.undoReadBack = back.unread ? `not read: ${back.unread}` : "assignment differs";
        if (unclear) wave.undoAnswer = unclear.reason.replace(/\.$/, "");
        throw new Error(back.unread ? "The tool couldn't read the pilot policy back, so the undo isn't confirmed." : "The policy didn't read back with the earlier assignment.");
      }
      if (unclear) await auditOrWarn({ tenantId: t, action: "update", resource: "policy", resourceId: wave.policyId, ok: true, detail: { undoWave: wave.id, note: foundNote(unclear, "the assignment as it was before the wave", "on the pilot") } });
    }
    wave.status = "undone";
    wave.undoneAt = new Date().toISOString();
    wave.readBack = already ? ALREADY_BEFORE : "assignment back as before the wave";
    // An earlier undo that failed is over now: the wave no longer carries its error (the audit log keeps both).
    delete wave.error;
  } catch (err) {
    wave.status = "undo-failed";
    wave.error = err instanceof Error ? err.message : String(err);
  }
  await save(dataDir, record);
  return wave;
}

/** Turns the pilot policy on or off, read back: "matches", "differs", or "not read: " and why when no read worked. */
export async function setPilotEnabled(dataDir: string, ctx: TenantContext, enabled: boolean): Promise<{ enabled: boolean; readBack: string }> {
  const t = ctx.tenantId;
  const pilot = await activePilot(dataDir, t);
  if (!pilot) throw new Error("There's no pilot yet.");
  const api: TenantApi = ctx.client;
  await auditedWrite({ tenantId: t }, "update", "policy", pilot.policyId, () => patchPolicy(api, t, pilot.policyId, { enabled }), { enabled });
  const back = await readBack(async () => {
    const p = await getPolicy(new ReadOnlyApi(api), t, pilot.policyId);
    return (p.enabled ?? true) === enabled ? p : null;
  });
  return { enabled, readBack: back.value ? "matches" : back.unread ? `not read: ${back.unread}` : "differs" };
}
