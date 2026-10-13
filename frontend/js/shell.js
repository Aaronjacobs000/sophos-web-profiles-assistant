// App shell: the left rail (conversion steps, tools, settings), the top bar
// with the partner and tenant chips, and the footer. Paints at once, then
// fills in from /api/status.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { esc, escAttr } from "./ui.js";

// The six steps of the conversion. A step with a "drop" is a placeholder for
// the drop that brings it.
export const STEPS = [
  { n: 1, name: "Readiness", sub: "Requirements, inventory, snapshot", page: "/readiness.html" },
  { n: 2, name: "Clean up", sub: "SophosLabs check of legacy entries", page: "/cleanup.html" },
  { n: 3, name: "Design", sub: "Profiles from classic policies", page: "/design.html" },
  { n: 4, name: "Build", sub: "Site lists, profiles, pilot policy", page: "/build.html" },
  { n: 5, name: "Pilot", sub: "Daily hit digest, narrow Allow", page: "/pilot.html" },
  { n: 6, name: "Promote and retire", sub: "Waves, then remove old tags", page: "/promote.html" },
];

let status = null;

export function mark(cls = "brand-mark") {
  // A funnel over a globe: filtering the web.
  return `<svg class="${cls}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="12.5" stroke="currentColor" stroke-width="2.2" opacity="0.5"/><path d="M3.5 16h25M16 3.5c3.6 3.4 5.4 7.6 5.4 12.5S19.6 25.1 16 28.5M16 3.5c-3.6 3.4-5.4 7.6-5.4 12.5s1.8 9.1 5.4 12.5" stroke="currentColor" stroke-width="1.6" opacity="0.5"/><path d="M8 8h16l-6 7.5V22l-4 2v-8.5z" fill="currentColor"/></svg>`;
}

function tenantParam() {
  return new URLSearchParams(window.location.search).get("tenant");
}

/** The tenant this page is about: the URL's, or the only one in tenant mode. */
export function currentTenantId() {
  return tenantParam() || (status?.mode === "tenant" ? status?.tenant?.tenantId : null);
}

function stepItem(step, active, tenantId) {
  const sub = `<span class="step-sub">${esc(step.sub)}</span>`;
  if (step.drop) {
    return `<li><span class="step-item is-disabled" aria-disabled="true" title="Coming in drop ${step.drop}"><span class="step-num">${step.n}</span><span><span class="step-name">${esc(step.name)}<span class="tag tag-muted drop-tag">Drop ${step.drop}</span></span>${sub}</span></span></li>`;
  }
  const href = tenantId ? `${step.page}?tenant=${encodeURIComponent(tenantId)}` : step.page;
  return `<li><a class="step-item${active ? " is-active" : ""}" href="${escAttr(href)}"${active ? ' aria-current="page"' : ""}><span class="step-num">${step.n}</span><span><span class="step-name">${esc(step.name)}</span>${sub}</span></a></li>`;
}

function railLink(href, label, ic, active) {
  return `<a class="rail-link${active ? " is-active" : ""}" href="${href}"${active ? ' aria-current="page"' : ""} title="${escAttr(label)}">${icon(ic)}<span>${esc(label)}</span></a>`;
}

function renderRail(opts) {
  const mount = document.getElementById("app-rail");
  if (!mount) return;
  const path = window.location.pathname;
  const tenantId = currentTenantId();
  const partner = status?.mode === "partner";
  const steps = STEPS.map((s) => stepItem(s, path === s.page, tenantId)).join("");
  mount.innerHTML = `
    <a class="rail-brand" href="/" title="Web Profiles Assistant">
      ${mark()}
      <span class="brand-text"><span class="brand-name">Web Profiles Assistant</span><span class="brand-sub">for Sophos Fusion</span></span>
    </a>
    ${partner ? `<div class="rail-group"><div class="rail-label">Partner</div>${railLink("/estate.html", "Estate", "building", path === "/estate.html")}</div>` : ""}
    <div class="rail-group"><div class="rail-label">Conversion steps</div><ol class="steps">${steps}</ol></div>
    <div class="rail-group"><div class="rail-label">Tools</div>
      ${railLink("/site-list-cleaner.html", "Site list cleaner", "list", path === "/site-list-cleaner.html")}
      ${railLink("/logs.html", "Logs", "logs", path === "/logs.html")}
    </div>
    <div class="rail-group"><div class="rail-label">Settings</div>
      ${railLink("/credentials.html", "Credentials", "key", path === "/credentials.html")}
      ${railLink("/help.html", "Help", "help", path === "/help.html")}
    </div>
    <div class="rail-note">${esc(opts?.railNote ?? "Checks only read. Every write is previewed in a dry run, sent once, read back, and recorded in the audit log, with a rollback.")}</div>
    <div class="rail-foot">Unofficial tool, not from Sophos.</div>
  `;
}

function renderTopbar(tenantInfo) {
  const mount = document.getElementById("app-nav");
  if (!mount) return;
  const chips = [];
  if (status?.mode === "partner" && status.partner) {
    const name = status.partner.label || `${status.partner.idType === "organization" ? "Organization" : "Partner"} ${status.partner.id.slice(0, 8)}`;
    chips.push(
      `<a class="ctx-chip" href="/estate.html" title="${escAttr(`${status.partner.tenantCount} tenants`)}"><span class="ctx-role">${status.partner.idType === "organization" ? "Organization" : "Partner"}</span><span class="ctx-name">${esc(name)}</span></a>`,
    );
  }
  const t = tenantInfo ?? (status?.mode === "tenant" ? status.tenant : null);
  if (t) {
    const name = t.name ?? t.displayName ?? "Tenant";
    const region = t.region ? `<span class="ctx-region">${esc(t.region)}</span>` : "";
    chips.push(
      `<span class="ctx-chip" data-state="ok" title="${escAttr(`Tenant ${t.id ?? t.tenantId ?? ""}`)}"><span class="conn-dot"></span><span class="ctx-role">Tenant</span><span class="ctx-name">${esc(name)}</span>${region}</span>`,
    );
  } else if (status && status.status !== "configured-ok") {
    chips.push(`<a class="ctx-chip" href="/credentials.html" data-state="error"><span class="conn-dot"></span><span class="ctx-name">${status.status === "unconfigured" ? "Not connected" : "Connection failed"}</span></a>`);
  }
  mount.innerHTML = `
    <div class="route">${chips.join("")}</div>
    <span class="topbar-spacer"></span>
    ${status ? `<span class="tag tag-muted" title="Credential mode">${status.mode === "partner" ? "Partner mode" : "Tenant mode"}</span>` : ""}
    ${status?.version ? `<span class="tag tag-muted tag-mono">v${esc(status.version)}</span>` : ""}
  `;
}

function renderFooter() {
  const mount = document.getElementById("page-footer");
  if (!mount) return;
  mount.innerHTML = `<p class="copyright">Unofficial tool, not from Sophos and not supported by Sophos. MIT License, © 2026 Aaron Jacobs.</p>`;
}

/**
 * Paints the shell and returns the status. Sends an unconfigured server to
 * the setup wizard.
 */
export async function initShell(opts = {}) {
  renderRail(opts);
  renderTopbar(null);
  renderFooter();
  try {
    status = await api.get("/api/status");
  } catch (err) {
    console.error("status failed", err);
  }
  if (status?.status === "unconfigured" && window.location.pathname !== "/welcome.html" && !opts.allowUnconfigured) {
    window.location.href = "/welcome.html";
    return status;
  }
  renderRail(opts);
  renderTopbar(null);
  return status;
}

/** Shows the tenant in the top bar once the page knows it. */
export function setTenant(tenant) {
  renderTopbar(tenant);
}

export function getStatus() {
  return status;
}
