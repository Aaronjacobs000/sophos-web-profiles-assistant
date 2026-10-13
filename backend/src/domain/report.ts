/**
 * The customer report: one self-contained HTML page (inline styles, no
 * scripts, no external files) that prints to A4. The PDF is this page printed
 * by a local Chrome or Edge (services/pdf.ts).
 *
 * Pure: no Node or browser imports.
 */

import type { ReadinessLike } from "./report-types.js";
import type { ScoreItem, Severity } from "./scorecard.js";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** DD/MM/YYYY HH:MM in the reader's local time, as the tool shows dates. */
export function formatWhen(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  fix: "Fix before the pilot",
  plan: "Plan around",
  info: "Check by hand",
  ok: "Passing",
};

/** Evidence lines shown per item; the rest are counted, and all of them are in the snapshot. */
const REPORT_EVIDENCE = 12;

function itemHtml(item: ScoreItem): string {
  const shown = (item.evidence ?? []).slice(0, REPORT_EVIDENCE);
  const more = (item.evidence?.length ?? 0) - shown.length + (item.evidenceMore ?? 0);
  const ev = shown.length
    ? `<ul class="ev">${shown.map((e) => `<li>${esc(e)}</li>`).join("")}${more > 0 ? `<li class="more">and ${more} more</li>` : ""}</ul>`
    : "";
  return `<div class="item sev-${item.severity}">
    <div class="item-title">${esc(item.title)}</div>
    ${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
    ${item.fix ? `<p class="fix"><strong>What to do:</strong> ${esc(item.fix)}</p>` : ""}
    ${ev}
    ${item.topic ? `<div class="doc">Topic: ${esc(item.topic)}</div>` : ""}
  </div>`;
}

export function renderReport(r: ReadinessLike, opts: { generatedAt: string; toolVersion: string; timeZone?: string }): string {
  const s = r.scorecard;
  const e = s.facts.eligibility;
  const groups = (["fix", "plan", "info", "ok"] as Severity[])
    .map((sev) => {
      const list = s.items.filter((i) => i.severity === sev);
      if (!list.length) return "";
      return `<section class="group"><h2>${SEVERITY_LABEL[sev]} <span class="count">${list.length}</span></h2>${list.map(itemHtml).join("")}</section>`;
    })
    .join("");

  const policyRows = s.facts.policies
    .map(
      (p) => `<tr><td>${esc(p.name)}</td><td>${p.type === "server-web-control" ? "Server" : "Computer"}</td><td class="num">${p.base ? "Base" : p.priority}</td><td>${
        p.enabled ? "On" : "Off"
      }</td><td>${p.mode === "profile" ? "Web profile" : "Classic"}</td><td>${esc(p.assignedTo)}</td><td class="num">${p.tags}</td><td>${
        p.logging === null ? "" : p.logging ? "On" : "Off"
      }</td></tr>`,
    )
    .join("");

  const wm = s.facts.websiteManagement;
  const tagRows = wm
    ? wm.tagRows
        .slice(0, 40)
        .map(
          (t) =>
            `<tr><td>${esc(t.tag)}</td><td class="num">${t.entries}</td><td>${
              t.actions.length ? esc(t.actions.map((a) => `${a.action} in ${a.policy}`).join("; ")) : "Not used by any policy"
            }</td></tr>`,
        )
        .join("")
    : "";

  const decryptRows = s.facts.decryption
    .map(
      (d) =>
        `<tr><td>${esc(d.policy)}</td><td>${d.type === "server-threat-protection" ? "Server" : "Computer"}</td><td>${d.enabled ? "On" : "Off"}</td><td>${
          d.decryption === null ? "" : d.decryption ? "On" : "Off"
        }</td><td>${d.quic === null ? "" : d.quic ? "On" : "Off"}</td></tr>`,
    )
    .join("");

  const eligibility = e
    ? `<div class="kpis">
        <div class="kpi"><div class="kpi-n">${e.eligible.toLocaleString("en-US")}<span> of ${e.inScope.toLocaleString("en-US")}</span></div><div class="kpi-l">devices can use profiles (${e.percent}%)</div></div>
        <div class="kpi"><div class="kpi-n">${e.byReason.macos.toLocaleString("en-US")}</div><div class="kpi-l">macOS devices</div></div>
        <div class="kpi"><div class="kpi-n">${(e.byReason["windows-old-agent"] + e.byReason["windows-no-agent-version"]).toLocaleString("en-US")}</div><div class="kpi-l">Windows devices below 2026.1</div></div>
        <div class="kpi"><div class="kpi-n">${wm ? wm.entries.toLocaleString("en-US") : "?"}</div><div class="kpi-l">Website Management entries${wm ? ` in ${wm.tags} tags` : ""}</div></div>
        <div class="kpi"><div class="kpi-n">${s.facts.profiles ? `${s.facts.profiles.count} / ${s.facts.profiles.limit}` : "?"}</div><div class="kpi-l">web filtering profiles in use</div></div>
      </div>`
    : "";

  const snapshot = r.snapshot
    ? `<p>Rollback snapshot saved before any change: <code>${esc(r.snapshot.file)}</code>, SHA-256 <code>${esc(r.snapshot.hash.slice(0, 16))}…</code>. It holds every Web Control policy, the web settings of every Threat Protection policy, every Website Management entry, the decryption and scanning exclusions, and every profile and site list, as read.</p>`
    : `<p>No rollback snapshot was saved for this read.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Web filtering readiness: ${esc(r.tenant.name)}</title>
<style>
  :root { --navy:#001A47; --blue:#2006F7; --ink:#1d2433; --muted:#5b6b7a; --line:#d8e0ea; --bg:#ffffff; --tint:#EDF3F9;
          --fix:#C8001E; --fix-bg:#fdecee; --plan:#9a5c00; --plan-bg:#fff4e0; --ok:#0a7a3d; --ok-bg:#e6f6ec; --info:#3a4a5c; --info-bg:#eef2f6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 10.5pt/1.5 "Segoe UI", Aptos, "Helvetica Neue", Arial, sans-serif; }
  .page { max-width: 820px; margin: 0 auto; padding: 32px 36px 40px; }
  header { border-bottom: 3px solid var(--navy); padding-bottom: 14px; margin-bottom: 18px; }
  .eyebrow { font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  h1 { color: var(--navy); font-size: 20pt; line-height: 1.2; margin: 6px 0 6px; }
  h2 { color: var(--navy); font-size: 12.5pt; margin: 22px 0 8px; }
  h2 .count { display:inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; background: var(--tint); font-size: 9pt; text-align:center; vertical-align: 2px; }
  p { margin: 4px 0; }
  .meta { color: var(--muted); font-size: 9pt; }
  .unofficial { margin-top: 8px; display: inline-block; font-size: 8.5pt; color: var(--navy); background: var(--tint); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; }
  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 14px 0 6px; }
  .kpi { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  .kpi-n { font-size: 15pt; font-weight: 700; color: var(--navy); }
  .kpi-n span { font-size: 9.5pt; font-weight: 500; color: var(--muted); }
  .kpi-l { font-size: 8.5pt; color: var(--muted); line-height: 1.3; }
  .item { border-left: 4px solid var(--info); background: var(--info-bg); padding: 8px 12px; margin: 0 0 8px; border-radius: 0 6px 6px 0; break-inside: avoid; }
  .sev-fix { border-color: var(--fix); background: var(--fix-bg); }
  .sev-plan { border-color: var(--plan); background: var(--plan-bg); }
  .sev-ok { border-color: var(--ok); background: var(--ok-bg); }
  .item-title { font-weight: 650; color: var(--navy); }
  .fix { margin-top: 4px; }
  .ev { margin: 4px 0 0 18px; padding: 0; font-size: 9pt; color: #334; }
  .ev .more { list-style: none; margin-left: -18px; color: var(--muted); }
  .doc { font-size: 8.5pt; color: var(--muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 6px 0 10px; break-inside: auto; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; }
  tr { break-inside: avoid; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-family: Consolas, "SF Mono", Menlo, monospace; font-size: 8.5pt; background: var(--tint); padding: 0 4px; border-radius: 3px; }
  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 8.5pt; }
  @page { size: A4; margin: 14mm 12mm; }
  @media print { .page { padding: 0; max-width: none; } h2 { break-after: avoid; } }
</style>
</head>
<body>
<div class="page">
<header>
  <div class="eyebrow">Web filtering profiles readiness</div>
  <h1>${esc(s.headline)}</h1>
  <p>${esc(s.summary)}</p>
  <p class="meta">Tenant ${esc(r.tenant.name)} (${esc(r.tenant.id)})${r.tenant.region ? `, region ${esc(r.tenant.region)}` : ""}. Read ${esc(formatWhen(r.readAt, opts.timeZone))}: ${r.calls} read-only API calls in ${(r.durationMs / 1000).toFixed(1)} s. Nothing in the tenant was changed.</p>
  <span class="unofficial">Unofficial tool, not from Sophos</span>
</header>
${eligibility}
${groups}
<section>
  <h2>Web Control policy order, top wins</h2>
  ${policyRows ? `<table><thead><tr><th>Policy</th><th>Kind</th><th class="num">Priority</th><th>Enabled</th><th>Filters by</th><th>Assigned to</th><th class="num">Tags</th><th>Logging</th></tr></thead><tbody>${policyRows}</tbody></table>` : "<p>Not read.</p>"}
</section>
${
  wm && wm.tagRows.length
    ? `<section><h2>Website Management tags</h2><table><thead><tr><th>Tag</th><th class="num">Entries</th><th>Action</th></tr></thead><tbody>${tagRows}</tbody></table>${
        wm.tagRows.length > 40 ? `<p class="meta">${wm.tagRows.length - 40} more tags in the snapshot.</p>` : ""
      }</section>`
    : ""
}
${
  decryptRows
    ? `<section><h2>Threat Protection: HTTPS decryption and Block QUIC</h2><table><thead><tr><th>Policy</th><th>Kind</th><th>Enabled</th><th>HTTPS decryption</th><th>Block QUIC</th></tr></thead><tbody>${decryptRows}</tbody></table></section>`
    : ""
}
<section>
  <h2>Rollback</h2>
  ${snapshot}
</section>
<footer>
  Made with the Web Profiles Assistant ${esc(opts.toolVersion)}, an unofficial tool that is not from Sophos and not supported by Sophos. It checks a tenant for the move to web filtering profiles using read-only calls to the Sophos Fusion API. Confirm settings in Sophos Fusion before you change them. Report made ${esc(formatWhen(opts.generatedAt, opts.timeZone))}.
</footer>
</div>
</body>
</html>
`;
}
