// Design: classic policies mapped to the nearest preset or a Custom
// profile, the difference group by group, site lists from the clean-up, and
// the account limits.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { esc, escAttr } from "./ui.js";
import { toast } from "./toast.js";

const main = document.getElementById("main");
let tenantId = null;
const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const GROUP_LABEL = { adult: "Adult", bandwidth: "Bandwidth", business: "Business", "data-loss": "Data loss", infrastructure: "Infrastructure", productivity: "Productivity", "social-networking": "Social networking", threats: "Threats", uncategorized: "Uncategorized" };

function profileCard(p, design, genAi) {
  const lists = p.siteLists.map((l) => design.siteLists.find((s) => s.key === l.listKey)).filter(Boolean);
  const gen = p.categoryActions?.["generative-ai"] ?? "allow";
  return `<section class="panel-card profile-card">
    <div class="card-head"><h2>${esc(p.name)}</h2><span class="spacer"></span>
      <span class="tag ${p.mode === "preset" ? "tag-ok" : "tag-accent"}">${p.mode === "preset" ? `Preset: ${esc(p.preset)}` : p.mode === "custom" ? "Custom" : "Site lists only"}</span></div>
    <div class="profile-meta">${p.sourcePolicies.map((s) => `<span class="tag tag-muted">${esc(s.name)}${s.type === "server-web-control" ? " (server)" : ""}</span>`).join("")}</div>
    ${p.flags.length ? `<ul class="flag-list">${p.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    ${p.diff.length ? `<div class="table-wrap"><table class="data-table diff-table"><thead><tr><th>Group</th><th>Classic today</th><th>Profile</th><th>Note</th></tr></thead><tbody>${p.diff
      .map((d) => `<tr><td>${esc(GROUP_LABEL[d.group] ?? d.group)}</td><td>${esc(d.classic)}</td><td class="${d.classic !== d.profile && d.classic !== "Not in classic" ? "changed" : ""}">${esc(d.profile)}</td><td class="cu-why">${esc(d.note ?? "")}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}
    <div class="cu-options" style="margin-top:12px">
      <label class="checkbox">Generative AI
        <select data-genai="${escAttr(p.sourcePolicies.map((s) => s.id).join(","))}">
          ${["allow", "warn", "block"].map((a) => `<option value="${a}"${gen === a ? " selected" : ""}>${a[0].toUpperCase() + a.slice(1)}</option>`).join("")}
        </select></label>
      <span class="hint">${lists.length ? lists.map((l) => `${esc(l.name)}: ${n(l.sites.length)} ${l.action}`).join("; ") : "No site lists"}</span>
    </div>
  </section>`;
}

function render(data) {
  const d = data.design;
  const t = encodeURIComponent(tenantId);
  const converted = d.policies.filter((p) => !p.skipped).length;
  main.innerHTML = `
    <section class="page-head">
      <div><span class="eyebrow">Design</span>
        <h1>${n(converted)} classic ${converted === 1 ? "policy becomes" : "policies become"} ${n(d.profiles.length)} ${d.profiles.length === 1 ? "profile" : "profiles"}</h1>
        <p class="page-lead">Each profile starts from the nearest preset; where the classic policy differs it becomes Custom. New categories, Generative AI among them, take the nearest preset's action until you choose. Site lists hold the clean-up step's exceptions.</p></div>
      <div class="head-actions"><a class="btn btn-lg btn-primary" href="/build.html?tenant=${t}">Continue to build</a></div>
    </section>
    <div class="estate-chips">
      <span class="count-chip"><b>${d.limits.profiles.planned + d.limits.profiles.existing} / ${d.limits.profiles.limit}</b><span>profiles (${d.limits.profiles.existing} already there)</span></span>
      <span class="count-chip"><b>${d.limits.siteLists.planned + d.limits.siteLists.existing} / ${d.limits.siteLists.limit}</b><span>site lists for the account (${d.limits.siteLists.existing} already there)</span></span>
      <span class="count-chip ${d.cleanedUp ? "is-ready" : "is-fix"}"><b>${d.cleanedUp ? "Yes" : "No"}</b><span>clean-up applied</span></span>
    </div>
    ${d.warnings.map((w) => `<div class="banner banner-warn" style="margin-bottom:10px">${esc(w)}</div>`).join("")}
    <div class="score-main">${d.profiles.map((p) => profileCard(p, d, data.genAi)).join("")}</div>
    ${d.policies.some((p) => p.skipped) ? `<section class="panel-card" style="margin-top:14px"><h2>Not converted</h2><ul class="flag-list">${d.policies.filter((p) => p.skipped).map((p) => `<li><b>${esc(p.policyName)}</b>: ${esc(p.skipped)}</li>`).join("")}</ul></section>` : ""}
  `;
  main.querySelectorAll("[data-genai]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const genAi = { ...data.genAi };
      for (const id of sel.dataset.genai.split(",")) genAi[id] = sel.value;
      try {
        render(await api.put(`/api/design/${t}`, { genAi }));
        toast("Generative AI choice saved.", "ok");
      } catch (err) {
        toast("Couldn't save the Generative AI choice.", "warn", 8000, err.message);
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
  const r = await api.get(`/api/readiness/${encodeURIComponent(tenantId)}`).catch(() => null);
  if (r?.tenant) setTenant(r.tenant);
  main.innerHTML = '<p class="running-line"><span class="spinner"></span>Reading the classic policies</p>';
  try {
    render(await api.get(`/api/design/${encodeURIComponent(tenantId)}`));
  } catch (err) {
    main.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
  }
}

start();
