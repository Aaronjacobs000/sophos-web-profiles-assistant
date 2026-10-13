/**
 * The pilot digest: Web Control events from the SIEM API,
 * summarized into warned and blocked hits by site, reason, user and day.
 *
 * The SIEM API keeps about 24 hours and gives the action and reason only as
 * free text in the event's name, for example:
 *   'https://example.com/setup.exe' warned due to filetype 'Windows Executable (exe)'
 * Seen live (13/10/2026): "warned due to filetype '...'" and
 * "blocked due to category '...'". The parser reads the same shape for site
 * lists and other reasons too, and keeps anything it can't read as "unknown"
 * with the raw text, so a new wording is counted rather than lost.
 *
 * Pure: no Node or browser imports.
 */

import { parseSite } from "./sites.js";

export const WEB_CONTROL_EVENT = "Event::Endpoint::WebControlViolation";

export interface SiemEvent {
  id: string;
  type: string;
  name: string;
  created_at?: string;
  when?: string;
  endpoint_id?: string;
  endpoint_type?: string;
  location?: string;
  source?: string;
  user_id?: string;
  severity?: string;
  [k: string]: unknown;
}

export type HitAction = "warned" | "blocked" | "proceeded" | "allowed" | "unknown";

export interface ParsedHit {
  url: string;
  host: string;
  action: HitAction;
  reasonType: string;
  reasonValue: string;
}

const ACTIONS: Record<string, HitAction> = {
  warned: "warned",
  warn: "warned",
  blocked: "blocked",
  block: "blocked",
  proceeded: "proceeded",
  allowed: "allowed",
};

/** Reads an event name. Never throws. */
export function parseHit(name: string): ParsedHit {
  const m = /^'(.+?)'\s+([A-Za-z]+)(?:\s+(?:due to|because of|by)\s+(.+))?$/.exec(name.trim());
  if (!m) return { url: "", host: "", action: "unknown", reasonType: "unknown", reasonValue: name };
  const [, url = "", verb = "", reasonText = ""] = m;
  const action = ACTIONS[verb.toLowerCase()] ?? "unknown";
  let reasonType = "other";
  let reasonValue = reasonText.trim();
  const r = /^(file\s?type|category|site list|sitelist|tag|policy|risk(?: level)?|security risk|reputation)\s*:?\s*'?([^']*)'?/i.exec(reasonValue);
  if (r) {
    reasonType = r[1]!.toLowerCase().replace(/\s+/g, " ").replace("file type", "filetype").replace("sitelist", "site list");
    reasonValue = r[2]!.trim() || reasonValue;
  } else if (!reasonValue) reasonType = "none";
  const site = parseSite(url);
  return { url, host: site.host || url, action, reasonType, reasonValue };
}

export interface HostSummary {
  host: string;
  hits: number;
  byAction: Partial<Record<HitAction, number>>;
  reasons: string[];
  users: number;
  devices: number;
  lastSeen: string;
}

export interface Digest {
  total: number;
  from: string | null;
  to: string | null;
  byAction: Partial<Record<HitAction, number>>;
  byReason: Array<{ reason: string; hits: number }>;
  byDay: Array<{ day: string; warned: number; blocked: number; other: number }>;
  hosts: HostSummary[];
  unparsed: number;
}

const REASON_LABEL: Record<string, string> = {
  filetype: "File type",
  category: "Category",
  "site list": "Site list",
  tag: "Tag",
  policy: "Policy",
  risk: "Risk",
  "risk level": "Risk level",
  "security risk": "Security risk",
  reputation: "Reputation",
};

/** "File type: Windows Executable (exe)", or the text as it came when the tool can't read it. */
export function reasonLabel(hit: ParsedHit): string {
  if (hit.reasonType === "other" || hit.reasonType === "none" || hit.reasonType === "unknown") return hit.reasonValue || "No reason given";
  return `${REASON_LABEL[hit.reasonType] ?? hit.reasonType}: ${hit.reasonValue}`;
}

function day(iso: string | undefined): string {
  return (iso ?? "").slice(0, 10);
}

/** Summarizes events, optionally only those at or after `since` (ISO). */
export function summarize(events: SiemEvent[], since?: string): Digest {
  const list = events.filter((e) => e.type === WEB_CONTROL_EVENT && (!since || (e.created_at ?? e.when ?? "") >= since));
  const byAction: Digest["byAction"] = {};
  const reasons = new Map<string, number>();
  const days = new Map<string, { warned: number; blocked: number; other: number }>();
  const hosts = new Map<string, { hits: number; byAction: Partial<Record<HitAction, number>>; reasons: Set<string>; users: Set<string>; devices: Set<string>; lastSeen: string }>();
  let unparsed = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const e of list) {
    const when = e.created_at ?? e.when ?? "";
    if (when && (!from || when < from)) from = when;
    if (when && (!to || when > to)) to = when;
    const hit = parseHit(e.name ?? "");
    if (hit.action === "unknown") unparsed++;
    byAction[hit.action] = (byAction[hit.action] ?? 0) + 1;
    const reason = reasonLabel(hit);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const d = days.get(day(when)) ?? { warned: 0, blocked: 0, other: 0 };
    if (hit.action === "warned") d.warned++;
    else if (hit.action === "blocked") d.blocked++;
    else d.other++;
    days.set(day(when), d);
    const key = hit.host || "(unreadable)";
    const h = hosts.get(key) ?? { hits: 0, byAction: {}, reasons: new Set(), users: new Set(), devices: new Set(), lastSeen: "" };
    h.hits++;
    h.byAction[hit.action] = (h.byAction[hit.action] ?? 0) + 1;
    h.reasons.add(reason);
    if (e.source || e.user_id) h.users.add(String(e.source ?? e.user_id));
    if (e.endpoint_id) h.devices.add(e.endpoint_id);
    if (when > h.lastSeen) h.lastSeen = when;
    hosts.set(key, h);
  }
  return {
    total: list.length,
    from,
    to,
    byAction,
    byReason: [...reasons.entries()].map(([reason, hits]) => ({ reason, hits })).sort((a, b) => b.hits - a.hits),
    byDay: [...days.entries()].map(([d, v]) => ({ day: d, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    hosts: [...hosts.entries()]
      .map(([host, h]) => ({ host, hits: h.hits, byAction: h.byAction, reasons: [...h.reasons], users: h.users.size, devices: h.devices.size, lastSeen: h.lastSeen }))
      .sort((a, b) => b.hits - a.hits || a.host.localeCompare(b.host)),
    unparsed,
  };
}

/** The narrow Allow entry for a hit: the exact host, never its parent domain. */
export function narrowAllow(host: string): string | null {
  const s = parseSite(host);
  if (s.kind === "invalid" || !s.host || s.kind === "wildcard" || s.kind === "tld") return null;
  return s.host;
}
