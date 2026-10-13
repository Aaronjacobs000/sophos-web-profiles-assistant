/**
 * Which devices can use web filtering profiles.
 *
 * Sophos Fusion Help: profiles apply only to Windows devices
 * running Sophos Endpoint 2026.1 or later. "Sophos Endpoint 2026.1" is the
 * coreAgent version in GET /endpoint/v1/endpoints (confirmed 13/10/2026).
 * Everything else keeps the classic Web Control settings. Linux has no Web
 * Control, so it is counted apart and left out of the percentage.
 *
 * Pure: no Node or browser imports, so the site list cleaner's static page can
 * reuse it.
 */

export const PROFILE_MIN_AGENT = "2026.1";
const MIN_PARTS = [2026, 1];

export interface DeviceLike {
  id: string;
  hostname?: string;
  type?: string;
  os?: { platform?: string; isServer?: boolean; name?: string };
  assignedProducts?: Array<{ code: string; version?: string; status?: string }>;
  lastSeenAt?: string;
  group?: { id?: string; name?: string };
}

export type EligibilityReason =
  | "eligible"
  | "windows-old-agent"
  | "windows-no-agent-version"
  | "macos"
  | "linux"
  | "other";

export interface DeviceEligibility {
  id: string;
  hostname: string;
  kind: "computer" | "server";
  platform: string;
  coreAgent: string | null;
  eligible: boolean;
  reason: EligibilityReason;
}

/** "2026.2.2.1.0" as [2026, 2, 2, 1, 0]; null when it is not a dotted version. */
export function parseVersion(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").map((p) => Number.parseInt(p, 10));
}

/** Negative, zero or positive, comparing part by part; a missing part counts as 0. */
export function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function meetsMinimum(version: string | null | undefined): boolean {
  const parts = parseVersion(version);
  return parts !== null && compareVersions(parts, MIN_PARTS) >= 0;
}

/** The installed coreAgent version, or null when the device reports none. */
export function coreAgentVersion(device: DeviceLike): string | null {
  const core = (device.assignedProducts ?? []).find((p) => p.code === "coreAgent");
  if (!core?.version) return null;
  if (core.status && core.status !== "installed") return null;
  return core.version;
}

function platformOf(device: DeviceLike): string {
  return (device.os?.platform ?? "").toLowerCase();
}

export function deviceEligibility(device: DeviceLike): DeviceEligibility {
  const platform = platformOf(device);
  const coreAgent = coreAgentVersion(device);
  const kind: "computer" | "server" = device.type === "server" || device.os?.isServer ? "server" : "computer";
  let reason: EligibilityReason;
  if (platform === "windows") {
    if (!coreAgent) reason = "windows-no-agent-version";
    else reason = meetsMinimum(coreAgent) ? "eligible" : "windows-old-agent";
  } else if (platform === "macos" || platform === "mac") {
    reason = "macos";
  } else if (platform === "linux") {
    reason = "linux";
  } else {
    reason = "other";
  }
  return {
    id: device.id,
    hostname: device.hostname ?? device.id,
    kind,
    platform: platform || "unknown",
    coreAgent,
    eligible: reason === "eligible",
    reason,
  };
}

export interface EligibilitySummary {
  /** Devices Web Control can apply to: everything except Linux. */
  inScope: number;
  eligible: number;
  /** Eligible as a percentage of inScope, rounded down; 0 when nothing is in scope. */
  percent: number;
  byReason: Record<EligibilityReason, number>;
  computers: { inScope: number; eligible: number };
  servers: { inScope: number; eligible: number };
  /** Older Windows coreAgent versions and how many devices run each, highest count first. */
  oldWindowsVersions: Array<{ version: string; count: number }>;
  /** Up to 200 devices that cannot use profiles yet, for the device list. */
  ineligible: DeviceEligibility[];
  ineligibleTotal: number;
}

export function summariseEligibility(devices: DeviceLike[]): EligibilitySummary {
  const byReason: Record<EligibilityReason, number> = {
    eligible: 0,
    "windows-old-agent": 0,
    "windows-no-agent-version": 0,
    macos: 0,
    linux: 0,
    other: 0,
  };
  const computers = { inScope: 0, eligible: 0 };
  const servers = { inScope: 0, eligible: 0 };
  const versions = new Map<string, number>();
  const ineligible: DeviceEligibility[] = [];
  let ineligibleTotal = 0;
  for (const device of devices) {
    const e = deviceEligibility(device);
    byReason[e.reason]++;
    if (e.reason === "linux") continue;
    const bucket = e.kind === "server" ? servers : computers;
    bucket.inScope++;
    if (e.eligible) {
      bucket.eligible++;
      continue;
    }
    ineligibleTotal++;
    if (ineligible.length < 200) ineligible.push(e);
    if (e.reason === "windows-old-agent" && e.coreAgent) {
      const short = e.coreAgent.split(".").slice(0, 3).join(".");
      versions.set(short, (versions.get(short) ?? 0) + 1);
    }
  }
  const inScope = computers.inScope + servers.inScope;
  const eligible = computers.eligible + servers.eligible;
  return {
    inScope,
    eligible,
    percent: inScope === 0 ? 0 : Math.floor((eligible / inScope) * 100),
    byReason,
    computers,
    servers,
    oldWindowsVersions: [...versions.entries()]
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version)),
    ineligible: ineligible.sort((a, b) => a.reason.localeCompare(b.reason) || a.hostname.localeCompare(b.hostname)),
    ineligibleTotal,
  };
}
