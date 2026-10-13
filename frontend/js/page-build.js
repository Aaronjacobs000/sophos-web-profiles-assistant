// Build: the plan, a dry run, then site lists, a profile and a pilot
// policy at the top of the order, each read back. Builds can be rolled back,
// and the tenant compared with the snapshot taken before the build.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { esc, escAttr } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { diffHtml } from "./diff-view.js";

const main = document.getElementById("main");
let tenantId = null;
let design = null;
let targets = null;
let lastPlan = null;
let builds = [];
let diff = null;

const REASON = { "windows-old-agent": "Windows below 2026.1", "windows-no-agent-version": "no agent version", macos: "macOS", other: "other platform" };
const STATUS_TAG = {
  planned: '<span class="tag tag-muted">Dry run OK</span>',
  created: '<span class="tag tag-ok">Created</span>',
  failed: '<span class="tag tag-bad">Failed</span>',
  deleted: '<span class="tag tag-muted">Rolled back</span>',
  "delete-failed": '<span class="tag tag-bad">Delete failed</span>',
};

function pilotFromForm() {
  const f = main.querySelector("#pilot");
  const checked = (name) => [...f.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    profileKey: f.querySelector("#profile").value,
    name: f.querySelector("#pname").value,
    enabled: f.querySelector("#enabled").checked,
    targets: { endpoints: checked("endpoints"), endpointGroups: checked("endpointGroups"), userGroups: checked("userGroups") },
  };
}

function stepsHtml(rec) {
  return `<ol class="steps-list">${rec.steps
    .map(
      (s) => `<li><span class="s-n">${s.order}</span><div><div class="s-name">${esc(s.kind === "site-list" ? "Site list" : s.kind === "profile" ? "Profile" : "Policy")} "${esc(s.name)}"</div>
        <div class="s-sum">${esc(s.summary)}${s.readBack ? `. Read back: ${esc(s.readBack)}` : ""}${s.note ? `. ${esc(s.note)}` : ""}${s.error ? `. ${esc(s.error)}` : ""}</div>
        <div class="s-path">${s.method} ${esc(s.path)}${s.id ? `  ${esc(s.id)}` : ""}</div></div>${STATUS_TAG[s.status] ?? ""}</li>`,
    )
    .join("")}</ol>`;
}

function checksHtml(rec) {
  return `<ul class="check-list">${rec.checks.map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join("")}</ul>`;
}

function render() {
  const t = encodeURIComponent(tenantId);
  const profiles = design.profiles;
  const lead = lastPlan;
  const devices = targets.endpoints;
  main.innerHTML = `
    <section class="page-head">
      <div><span class="eyebrow">Build${lead ? `: ${esc(lead.pilot.name)}` : ""}</span>
        <h1>${lead ? (lead.status === "dry-run" ? (lead.checks.every((c) => c.ok) ? (getStatus()?.readOnly ? "Dry run passed. Read-only mode, so nothing will be created." : `Dry run passed. Ready to create ${lead.steps.length} objects.`) : "Dry run found problems") : lead.status === "built" ? `Built ${lead.steps.length} objects` : lead.status === "rolled-back" ? "Rolled back" : `Build ${esc(lead.status)}`) : "Plan the pilot"}</h1>
        <p class="page-lead">Site lists, then the profile, then a pilot policy at the top of the policy order with the profile, logging on and Recommended file types. A rollback snapshot is saved first. Every write is sent once, read back, and recorded in the audit log.</p></div>
      <div class="head-actions">
        <button class="btn btn-lg" id="dry">${icon("search")}Dry run</button>
        <button class="btn btn-lg btn-primary" id="go" data-write${lead && lead.status === "dry-run" && lead.checks.every((c) => c.ok) ? "" : " disabled"}>${icon("play")}Create ${lead?.steps.length ?? ""} objects</button>
      </div>
    </section>
    <div class="build-grid">
      <section class="panel-card">
        <h2>Pilot policy</h2>
        <form id="pilot" class="form-stack" onsubmit="return false">
          <label>Profile<select id="profile">${profiles.map((p) => `<option value="${escAttr(p.key)}">${esc(p.name)}</option>`).join("")}</select></label>
          <label>Policy name<input type="text" id="pname" placeholder="WF pilot: profile name" /></label>
          <label class="checkbox"><input type="checkbox" id="enabled" checked /> Enabled (turn off to build it without changing devices yet)</label>
          <label>Devices (Windows on 2026.1 or later can use profiles)
            <div class="target-list">${devices.map((d) => d.kind === "server" ? `<label class="muted"><input type="checkbox" name="endpoints" value="${escAttr(d.id)}" disabled /> ${esc(d.hostname)}<span class="hint">server: needs a server policy</span></label>` : `<label><input type="checkbox" name="endpoints" value="${escAttr(d.id)}" /> ${esc(d.hostname)}<span class="hint">${d.eligible ? "eligible" : esc(REASON[d.reason] ?? d.reason)}</span></label>`).join("") || '<span class="hint">No devices.</span>'}</div></label>
          <label>Device groups
            <div class="target-list">${targets.endpointGroups.map((g) => g.type === "server" ? `<label class="muted"><input type="checkbox" name="endpointGroups" value="${escAttr(g.id)}" disabled /> ${esc(g.name)}<span class="hint">server group: needs a server policy</span></label>` : `<label><input type="checkbox" name="endpointGroups" value="${escAttr(g.id)}" /> ${esc(g.name)}<span class="hint">${g.members ?? "?"} devices</span></label>`).join("") || '<span class="hint">No device groups.</span>'}</div></label>
          <label>User groups (a policy goes to devices or to users, not both)
            <div class="target-list">${targets.userGroups.map((g) => `<label><input type="checkbox" name="userGroups" value="${escAttr(g.id)}" /> ${esc(g.name)}<span class="hint">${g.members ?? "?"} users</span></label>`).join("") || '<span class="hint">No user groups.</span>'}</div></label>
        </form>
      </section>
      <div class="score-main">
        ${lead ? `<section class="panel-card"><h2>Plan</h2>${stepsHtml(lead)}</section><section class="panel-card"><h2>Checks</h2>${checksHtml(lead)}</section>` : '<section class="panel-card"><p class="muted">Choose the profile and pilot targets, then run a dry run. Nothing is written until you confirm.</p></section>'}
        ${diffHtml(diff)}
        <section class="panel-card"><h2>Builds</h2>${
          builds.length
            ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Pilot</th><th>Status</th><th>Snapshot</th><th></th></tr></thead><tbody>${builds
                .map((b) => `<tr><td class="cell-nowrap">${new Date(b.createdAt).toLocaleString("en-GB")}</td><td>${esc(b.pilot.name)}</td><td>${esc(b.status)}</td><td><code>${esc(b.snapshotFile ?? "")}</code></td><td class="cell-nowrap">
                  ${["built", "partial", "rollback-partial"].includes(b.status) ? `<button class="btn btn-small btn-danger" data-rollback="${escAttr(b.id)}">Roll back</button>` : ""}
                  ${b.snapshotFile ? `<button class="btn btn-small" data-diff="${escAttr(b.snapshotFile)}">Compare with snapshot</button>` : ""}</td></tr>`)
                .join("")}</tbody></table></div>`
            : '<p class="muted">No builds yet.</p>'
        }</section>
      </div>
    </div>`;
  if (lead) {
    main.querySelector("#profile").value = lead.pilot.profileKey;
    main.querySelector("#pname").value = lead.pilot.name;
    main.querySelector("#enabled").checked = lead.pilot.enabled;
    for (const [k, ids] of Object.entries(lead.pilot.targets)) for (const id of ids ?? []) {
      const box = main.querySelector(`input[name="${k}"][value="${CSS.escape(id)}"]`);
      if (box) box.checked = true;
    }
  }
  main.querySelector("#dry").addEventListener("click", async () => {
    try {
      lastPlan = await api.post(`/api/build/${t}/dry-run`, pilotFromForm());
      diff = null;
      render();
    } catch (err) {
      toast(err.message, "warn", 9000);
    }
  });
  main.querySelector("#go").addEventListener("click", async () => {
    if (!window.confirm(`Create ${lastPlan.steps.length} objects in ${tenantId}? A rollback snapshot is saved first.`)) return;
    const btn = main.querySelector("#go");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Building';
    try {
      lastPlan = await api.post(`/api/build/${t}/execute`, pilotFromForm());
      builds = (await api.get(`/api/build/${t}`)).items;
      render();
      toast(lastPlan.status === "built" ? "Built and read back." : `Build ${lastPlan.status}.`, lastPlan.status === "built" ? "ok" : "warn", 9000);
    } catch (err) {
      toast(err.message, "warn", 10000);
      render();
    }
  });
  main.querySelectorAll("[data-rollback]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const plan = await api.post(`/api/build/${t}/${b.dataset.rollback}/rollback`, { dryRun: true });
        const objs = plan.steps.filter((s) => s.id && s.status !== "deleted");
        const wm = plan.restorePlan?.length ?? 0;
        if (!window.confirm(`Roll back: delete ${objs.map((s) => `${s.kind} "${s.name}"`).join(", ")} in that order${wm ? `, and ${wm} Website Management changes from the snapshot` : ""}?`)) return;
        lastPlan = await api.post(`/api/build/${t}/${b.dataset.rollback}/rollback`, { dryRun: false });
        builds = (await api.get(`/api/build/${t}`)).items;
        render();
        toast(`Rollback: ${lastPlan.status}.`, lastPlan.status === "rolled-back" ? "ok" : "warn", 9000);
      } catch (err) {
        toast(err.message, "warn", 10000);
      }
    }),
  );
  main.querySelectorAll("[data-diff]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.innerHTML = '<span class="spinner"></span>Reading';
      try {
        diff = await api.post(`/api/diff/${t}`, { snapshotFile: b.dataset.diff });
        render();
      } catch (err) {
        toast(err.message, "warn", 10000);
        render();
      }
    }),
  );
}

async function start() {
  await initShell();
  tenantId = currentTenantId();
  if (!tenantId) {
    window.location.href = getStatus()?.mode === "partner" ? "/estate.html" : "/";
    return;
  }
  const t = encodeURIComponent(tenantId);
  const r = await api.get(`/api/readiness/${t}`).catch(() => null);
  if (r?.tenant) setTenant(r.tenant);
  main.innerHTML = '<p class="running-line"><span class="spinner"></span>Reading the design and pilot targets</p>';
  try {
    [design, targets, builds] = await Promise.all([api.get(`/api/design/${t}`).then((x) => x.design), api.get(`/api/pilot-targets/${t}`), api.get(`/api/build/${t}`).then((x) => x.items)]);
    lastPlan = builds[0] ?? null;
    render();
  } catch (err) {
    main.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

start();
