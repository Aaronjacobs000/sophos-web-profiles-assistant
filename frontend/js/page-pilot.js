// Pilot: Web Control events collected from the SIEM API into this
// computer, a digest of warned and blocked hits, and a narrow Allow entry
// for a host, with a dry run and an undo.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { OUTCOME_TAG, OUTCOME_TOAST, esc, escAttr, readBackParts, relTime, rollbackUnfinishedBanner, sentence, unconfirmedReason } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

const main = document.getElementById("main");
let tenantId = null;
let view = null;
let digest = null;
let days = 7;
let pilotOnly = false;

const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/**
 * An Allow entry's row (category C): green only when the read-back confirmed the Allow; amber when Sophos accepted the
 * Allow or its undo but the read-back didn't confirm it; red when it failed. The plain line goes under the site, and why
 * on the Detail line. An entry undone has nothing to fix, so an error left from an earlier undo that failed isn't shown.
 */
function allowRow(a) {
  const tag = (cls, label) => `<span class="tag ${cls}">${label}</span>`;
  // An entry that failed keeps why its read-back couldn't read the list, if it got that far, with its error.
  const withError = [readBackParts(a.readBack).detail, a.error].filter(Boolean).map(sentence).join(" ");
  switch (a.status) {
    case "added":
      if (a.buildStatus === "rolled-back") return { tag: tag("tag-muted", "Removed with the build") };
      return allowConfirmed(a.readBack)
        ? { tag: tag(OUTCOME_TAG.confirmed, "Added") }
        : { tag: tag(OUTCOME_TAG.unconfirmed, "Not confirmed"), note: "Sophos accepted the Allow, but the read-back didn't confirm it.", detail: unconfirmedReason(a.readBack) };
    case "partial":
      // Sophos made the list, so part of the Allow went through and it can be undone (category D). A rollback deletes the list too.
      if (a.buildStatus === "rolled-back") return { tag: tag("tag-muted", "Removed with the build") };
      return { tag: tag(OUTCOME_TAG.unconfirmed, "Not finished"), note: PARTIAL_NOTE, detail: withError };
    case "failed":
      return { tag: tag(OUTCOME_TAG.failed, "Failed"), note: "The Allow didn't finish.", detail: withError };
    case "undone":
      return { tag: tag("tag-muted", "Undone") };
    case "undo-failed":
      return a.undoReadBack
        ? { tag: tag(OUTCOME_TAG.unconfirmed, "Undo not confirmed"), note: "Sophos accepted the undo, but the read-back didn't confirm it. Undo again, or check the list in Sophos Fusion.", detail: unconfirmedReason(a.undoReadBack, a.error) }
        : { tag: tag(OUTCOME_TAG.failed, "Undo failed"), note: "The undo didn't finish. Undo again, or check the list in Sophos Fusion.", detail: withError };
    default:
      return { tag: "" };
  }
}

function pilotCard() {
  const p = view.pilot;
  const pol = view.policy;
  if (!p) return `<section class="panel-card"><h2>Pilot policy</h2><p class="muted">No pilot yet. <a href="/build.html?tenant=${encodeURIComponent(tenantId)}">Build one in the Build step</a>; the digest still works on any events collected.</p></section>`;
  if (!pol && view.problem) {
    // The pilot policy is no longer in the tenant: say so, and what to do next, instead of the note on an unfinished rollback.
    return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span><span class="tag tag-bad">Not found</span></div>
      <ul class="order-list"><li><span class="o-name">${esc(p.policyName)}<span class="o-kind">Policy</span></span><span class="o-meta">not in the tenant</span></li></ul>
      <p style="margin-top:10px">${esc(view.problem)}</p>
      <div class="head-actions"><a class="btn btn-small" href="/build.html?tenant=${encodeURIComponent(tenantId)}">Open the Build page</a></div></section>`;
  }
  if (!pol && view.policyUnread) {
    // Any other failed read (a 403, a 5xx, no answer in time) doesn't show the policy is gone: say the read failed, and offer a retry.
    return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span><span class="tag tag-warn">Not read</span></div>
      <ul class="order-list">
        <li><span class="o-name">${esc(p.policyName)}<span class="o-kind">Policy</span></span><span class="o-meta">not read</span></li>
        <li><span class="o-name">${esc(p.profileName)}<span class="o-kind">Profile</span></span><span class="o-meta"><a href="/build.html?tenant=${encodeURIComponent(tenantId)}">Build</a></span></li>
      </ul>
      <p style="margin:10px 0">The tool couldn't read the pilot policy. That doesn't mean it's gone. Retry, or check it in Sophos Fusion.</p>
      <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(view.policyUnread))}</p>
      ${rollbackUnfinishedBanner(p, tenantId)}
      <div class="head-actions"><button class="btn btn-small" data-retry>Retry</button></div></section>`;
  }
  const targets = pol ? pol.endpoints.length + pol.endpointGroups.length + pol.users.length + pol.userGroups.length : 0;
  return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span>${pol ? (pol.enabled ? '<span class="tag tag-ok">On</span>' : '<span class="tag tag-warn">Off</span>') : '<span class="tag tag-bad">Not found</span>'}</div>
    <ul class="order-list">
      <li><span class="o-name">${esc(p.policyName)}<span class="o-kind">Policy, priority ${esc(pol?.priority ?? "?")}</span></span><span class="o-meta">${n(targets)} ${pol?.users.length || pol?.userGroups.length ? "user" : "device"} ${targets === 1 ? "target" : "targets"}</span></li>
      <li><span class="o-name">${esc(p.profileName)}<span class="o-kind">Profile</span></span><span class="o-meta"><a href="/build.html?tenant=${encodeURIComponent(tenantId)}">Build</a></span></li>
    </ul>
    ${rollbackUnfinishedBanner(p, tenantId)}
    ${pol && !pol.enabled ? '<p class="hint">The pilot is off, so it filters nothing yet. Turn it on from the Promote and retire page when you are ready.</p>' : ""}</section>`;
}

function collectionCard() {
  const s = view.store;
  const last = s.state.runs.filter((r) => r.source === "api").slice(-1)[0];
  const rows = s.days.slice(-10).reverse().map((d) => `<tr><td>${esc(d.day)}</td><td>${n(d.events)}</td><td>${d.imported ? n(d.imported) : ""}</td></tr>`).join("");
  return `<section class="panel-card"><h2>Collection</h2>
    <p class="hint">The SIEM API keeps about 24 hours of events, so the tool collects them into this computer. Collect at least daily for the length of the pilot.</p>
    <label class="checkbox cu-options"><input type="checkbox" id="schedule"${s.state.enabled ? " checked" : ""}/> Collect every few hours while the tool runs</label>
    <p class="hint">Last collection: ${last ? `${relTime(last.at)}, ${last.ok ? `${n(last.added)} new of ${n(last.web)} web events` : "failed"}` : "never"}.${last?.gap ? ` ${esc(last.gap)}` : ""} For a schedule without the tool open, run <code>npm run collect</code> daily.</p>
    ${last && !last.ok && last.error ? `<p class="hint" style="overflow-wrap:anywhere" data-collect-detail>Detail: ${esc(sentence(last.error))}</p>` : ""}
    ${rows ? `<table class="mini-table"><thead><tr><th>Day</th><th>Events</th><th>Imported</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No events stored yet.</p>'}
  </section>`;
}

function allowsCard() {
  // This pilot's entries; entries from earlier builds are counted, not listed.
  const current = view.pilot ? view.allows.filter((a) => a.buildId === view.pilot.buildId) : view.allows;
  const earlier = view.allows.length - current.length;
  const rows = current
    .map((a) => {
      // A read-back that couldn't read the list says "not read" in the sub-line; why goes on the Detail line.
      const back = readBackParts(a.readBack);
      const row = allowRow(a);
      const detail = sentence(row.detail ?? "");
      // An Allow that failed before it had a list has no list name, so the sub-line starts with the date.
      const sub = [esc(a.listName || ""), when(a.at), esc(back.plain)].filter(Boolean).join(" · ");
      const undo = !(["added", "partial"].includes(a.status) && a.buildStatus === "rolled-back") && ["added", "partial", "undo-failed"].includes(a.status);
      return `<li><span class="o-name">${esc(a.site)}<span class="o-kind">${sub}</span>${row.note ? `<span class="o-note">${row.note}</span>` : ""}${detail ? `<span class="o-detail" data-allow-detail>Detail: ${esc(detail)}</span>` : ""}</span><span class="o-meta">${row.tag}${undo ? ` <button class="btn btn-small" data-undo="${escAttr(a.id)}">Undo</button>` : ""}</span></li>`;
    })
    .join("");
  return `<section class="panel-card"><h2>Allow entries</h2>${rows ? `<ul class="order-list">${rows}</ul>` : '<p class="muted">None yet. Allow a host from the sites table.</p>'}${earlier ? `<p class="hint">${earlier} more ${earlier === 1 ? "entry belongs" : "entries belong"} to earlier builds.</p>` : ""}</section>`;
}

function tiles() {
  const d = digest;
  const tile = (num, label) => `<section class="panel-card"><div class="kpi-num">${num}</div><div class="kpi-label">${label}</div></section>`;
  return `<div class="kpi-row">
    ${tile(n(d.byAction.warned), "warned")}
    ${tile(n(d.byAction.blocked), "blocked")}
    ${tile(n(d.hosts.length), d.hosts.length === 1 ? "site" : "sites")}
    ${tile(n(d.unparsed), "events the tool couldn't read")}
  </div>`;
}

// An Allow whose list Sophos made but whose link to the profile didn't go through (or isn't confirmed).
const PARTIAL_NOTE = "Sophos made the list, but its link to the profile didn't go through, so the Allow may not be in effect. Undo removes the list.";

// What a read-back says when it confirms an Allow: the site in the list, and a new list linked to the profile.
const CONFIRMED = new Set(["site listed", "list holds the site", "profile links it as allow"]);
const allowConfirmed = (readBack) => !!readBack && String(readBack).split("; ").every((part) => CONFIRMED.has(part));
// What an undo's notes say when its read-backs confirm it.
const UNDO_CONFIRMED = new Set(["Profile read back without the list.", "List deleted, 404 on read-back.", "Site removed, confirmed on read-back."]);

// A Collect now that failed, whether the request was refused or the collection itself failed; the toast's detail line says why.
const COLLECT_FAILED = "Couldn't collect events.";

// Why Allow is off when the pilot policy is gone (a 404), and when there's no pilot at all.
const ALLOW_OFF = "Allow is off: the pilot policy is no longer in the tenant.";
const ALLOW_NO_PILOT = "Allow is off: there's no pilot yet.";

function digestHtml() {
  const d = digest;
  const gone = !view.policy && !!view.problem;
  const off = !view.pilot ? ALLOW_NO_PILOT : gone ? ALLOW_OFF : "";
  const allowAttrs = off ? ` disabled title="${escAttr(off)}"` : "";
  const max = Math.max(1, ...d.byDay.map((x) => x.warned + x.blocked + x.other));
  const daysRows = d.byDay
    .map((x) => `<tr><td class="cell-nowrap">${esc(x.day)}</td><td class="num">${n(x.warned)}</td><td class="num">${n(x.blocked)}</td><td class="num">${n(x.other)}</td><td class="day-bar-cell"><span class="day-bar"><span class="b-warn" style="width:${(x.warned / max) * 100}%"></span><span class="b-block" style="width:${(x.blocked / max) * 100}%"></span></span></td></tr>`)
    .join("");
  const reasons = d.byReason.slice(0, 8).map((r) => `<li><span class="o-name">${esc(r.reason)}</span><span class="o-meta">${n(r.hits)}</span></li>`).join("");
  // Each count carries its name, shown only when a narrow card stacks the row.
  const count = (label, x, cls = "num") => `<td class="${cls} s-count"><span class="s-label">${label} </span>${x}</td>`;
  const hosts = d.hosts
    .slice(0, 100)
    .map((h) => `<tr><td class="cu-site s-site"><b>${esc(h.host)}</b><span class="t-sub">${esc(h.reasons.join("; "))}</span></td>${count("Warned", n(h.byAction.warned))}${count("Blocked", n(h.byAction.blocked))}${count("Users", n(h.users))}${count("Devices", n(h.devices))}${count("Last seen", when(h.lastSeen), "cell-nowrap")}<td class="s-act"><button class="btn btn-small" data-allow="${escAttr(h.host)}"${allowAttrs}>Allow</button></td></tr>`)
    .join("");
  return `
    ${tiles()}
    ${d.imported ? `<div class="banner banner-warn">${n(d.imported)} of these events were imported from a file, not collected from this tenant.</div>` : ""}
    <section class="panel-card sites-card"><div class="card-head"><h2>Sites the pilot warned or blocked</h2><span class="spacer"></span><span class="hint">${d.from ? `${when(d.from)} to ${when(d.to)}` : ""}</span></div>
      ${hosts && off ? `<p class="hint" data-allow-off>${esc(off)}</p>` : ""}
      ${hosts ? `<div class="table-wrap"><table class="data-table cu-table sites-table"><thead><tr><th>Site and reason</th><th class="num">Warned</th><th class="num">Blocked</th><th class="num">Users</th><th class="num">Devices</th><th>Last seen</th><th></th></tr></thead><tbody>${hosts}</tbody></table></div>
        <p class="hint">Allow adds the exact host to the pilot's Allow list, never its parent domain. A file type warning (such as an installer download) isn't a category decision; allowing the host lets every file type from it through.</p>` : '<p class="muted">No warned or blocked hits in this period.</p>'}
    </section>
    <div class="kpi-pair pilot-pair">
      <section class="panel-card"><h2>By day</h2>${daysRows ? `<table class="mini-table"><thead><tr><th>Day</th><th>Warned</th><th>Blocked</th><th>Other</th><th></th></tr></thead><tbody>${daysRows}</tbody></table>` : '<p class="muted">Nothing yet.</p>'}</section>
      <section class="panel-card"><h2>Top reasons</h2>${reasons ? `<ul class="order-list">${reasons}</ul>` : '<p class="muted">Nothing yet.</p>'}</section>
    </div>`;
}

/** In place of the digest when Pilot devices only is on and the pilot policy couldn't be read: say so, and offer a retry. What Sophos answered goes on a separate detail line. */
function filterUnreadHtml() {
  return `<section class="panel-card"><h2>Pilot devices only</h2>
    <p style="margin:0 0 10px">The tool couldn't read which devices are on the pilot, so the digest isn't shown. Retry, or untick Pilot devices only to see every device.</p>
    <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(digest.pilotUnread))}</p>
    <div class="head-actions"><button class="btn btn-small" data-retry>Retry</button></div></section>`;
}

function headline() {
  if (digest?.pilotUnread) return "Couldn't read the pilot's devices";
  // The period the digest on screen was read for, which a read that failed after a change of Period leaves as it was.
  const shown = digest?.days ?? days;
  if (!digest || !digest.total) return shown > 0 ? `No hits in the last ${shown === 1 ? "day" : `${shown} days`}` : "No hits stored";
  return `${n(digest.byAction.warned)} warned and ${n(digest.byAction.blocked)} blocked ${shown > 0 ? `in the last ${shown === 1 ? "day" : `${shown} days`}` : "in all stored events"}`;
}

function render() {
  main.innerHTML = `
    <section class="page-head">
      <div><span class="eyebrow">Pilot${view.pilot ? `: ${esc(view.pilot.policyName)}` : ""}</span>
        <h1>${headline()}</h1>
        <p class="page-lead">Web Control events from the SIEM API, kept on this computer. Review what the pilot warns and blocks, allow what people need, then move more devices onto it. Events give the action and reason as text only; the tool reads that text.</p></div>
      <div class="head-actions">
        <label class="btn btn-lg" title="A saved SIEM events response, or a JSON list of events">${icon("folders")}Import events<input type="file" id="import" accept="application/json,.json" hidden /></label>
        <button class="btn btn-lg btn-primary" id="collect">${icon("refresh")}Collect now</button>
      </div>
    </section>
    <div class="build-grid">
      <div class="score-main">${pilotCard()}${collectionCard()}${allowsCard()}</div>
      <div class="score-main">
        <section class="panel-card"><div class="cu-options">
          <label>Period <select id="days">${[[1, "Last day"], [7, "Last 7 days"], [30, "Last 30 days"], [0, "All stored"]].map(([v, l]) => `<option value="${v}"${v === days ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="checkbox"><input type="checkbox" id="pilotonly"${pilotOnly ? " checked" : ""}${view.policy?.endpoints?.length || pilotOnly ? "" : " disabled"}/> Pilot devices only</label>
          ${digest?.otherWebEvents ? `<span class="hint">${n(digest.otherWebEvents)} other web events (threat blocks) stored, not part of the digest.</span>` : ""}
        </div></section>
        ${digest ? (digest.pilotUnread ? filterUnreadHtml() : digestHtml()) : ""}
      </div>
    </div>`;
  wire();
}

async function refresh() {
  const t = encodeURIComponent(tenantId);
  [view, digest] = await Promise.all([api.get(`/api/pilot/${t}`), api.get(`/api/pilot/${t}/digest?days=${days}${pilotOnly ? "&pilotOnly=1" : ""}`)]);
  render();
}

/** Reads the page. When a read fails, the page says so in plain words and offers a retry; the error itself stays out of the main text. */
async function load() {
  try {
    await refresh();
  } catch (err) {
    main.innerHTML = `
      <section class="page-head"><div><span class="eyebrow">Pilot</span><h1>Couldn't read the pilot</h1></div></section>
      <section class="panel-card"><p style="margin:0 0 10px">The tool couldn't read the pilot or its events, so there's nothing to show yet. Retry, or check the tenant in Sophos Fusion.</p>
        <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(err.message))}</p>
        <div class="head-actions"><button class="btn btn-small" data-retry>Retry</button></div></section>`;
    wireRetry(load);
  }
}

/** Wires each Retry on the page to read it with read: load when nothing was read yet, reread once the page shows a read. */
function wireRetry(read) {
  main.querySelectorAll("[data-retry]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>Reading';
      await read();
    }),
  );
}

/**
 * Reads the page again after a change on it. When the read fails, the page
 * keeps what it showed, says so above it in plain words and offers a retry;
 * the error itself goes on a separate detail line.
 */
async function reread() {
  try {
    await refresh();
  } catch (err) {
    // The last read, drawn again so every button is as it was, with the choices just made.
    render();
    main.querySelector(".page-head").insertAdjacentHTML(
      "afterend",
      `<section class="panel-card" style="margin-bottom:18px" data-reread-failed><h2>Couldn't read the pilot</h2>
        <p style="margin:0 0 10px">The tool couldn't read the pilot or its events, so the page still shows what it read before. Retry, or check the tenant in Sophos Fusion.</p>
        <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(err.message))}</p>
        <div class="head-actions"><button class="btn btn-small" data-reread>Retry</button></div></section>`,
    );
    // Into view from wherever the change was made, clear of the sticky top bar (taller when it wraps at phone width).
    const note = main.querySelector("[data-reread-failed]");
    note.style.scrollMarginTop = `${(document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0) + 12}px`;
    note.scrollIntoView({ block: "nearest" });
    note.querySelector("[data-reread]").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.innerHTML = '<span class="spinner"></span>Reading';
      await reread();
    });
  }
}

function allowModal(plan) {
  document.getElementById("results-modal")?.remove();
  const steps = plan.steps
    .map((s) => (s.op === "add-site" ? `Add ${s.site} to the site list "${s.listName}".` : s.op === "create-list" ? `Create the site list "${s.name}" with ${s.site}.` : `Link it to the profile "${s.profileName}" as Allow, priority ${s.priority} (the profile is sent whole, as the API requires, and read back).`))
    .map((x) => `<li>${esc(x)}</li>`)
    .join("");
  const modal = document.createElement("div");
  modal.id = "results-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `<div class="modal-card" role="dialog" aria-label="Allow ${escAttr(plan.host)}">
    <header class="modal-header"><h2>Allow ${esc(plan.site ?? plan.host)}: dry run</h2><button class="icon-btn modal-close" title="Close" aria-label="Close">${icon("x")}</button></header>
    <div class="modal-body">
      ${plan.problems.length ? `<ul class="check-list">${plan.problems.map((p) => `<li class="fail">${esc(p)}</li>`).join("")}</ul>` : `<h3>What it will do</h3><ol class="flag-list">${steps}</ol>`}
      ${plan.notes.length ? `<ul class="check-list">${plan.notes.map((p) => `<li class="warn">${esc(p)}</li>`).join("")}</ul>` : ""}
      <p class="hint">Each write is sent once, read back, and recorded in the audit log. You can undo it from Allow entries.</p>
      <div class="head-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="allow-go"${plan.problems.length ? " disabled" : ""}>Allow ${esc(plan.site ?? "")}</button></div>
    </div></div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector(".modal-close").addEventListener("click", close);
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  modal.querySelector("#allow-go").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.innerHTML = '<span class="spinner"></span>Adding';
    try {
      const r = await api.post(`/api/pilot/${encodeURIComponent(tenantId)}/allow`, { host: plan.host, dryRun: false });
      close();
      const back = readBackParts(r.entry.readBack);
      // Green only when the read-back confirmed the Allow; a list that couldn't be read, or a read-back without the site or link, leaves it
      // unconfirmed, with what was read (or why it couldn't be) on the Detail line.
      if (r.entry.status === "partial") toast(`Sophos made the list for ${r.entry.site}, but its link to the profile didn't go through. Undo it from Allow entries.`, OUTCOME_TOAST.unconfirmed, 10000, r.entry.error);
      else if (allowConfirmed(r.entry.readBack)) toast(`Allowed ${r.entry.site}: ${back.plain}.`, OUTCOME_TOAST.confirmed, 9000);
      else if (back.detail) toast(`Sophos accepted the Allow for ${r.entry.site}, but the list couldn't be read back, so it isn't confirmed.`, OUTCOME_TOAST.unconfirmed, 10000, back.detail);
      else toast(`Sophos accepted the Allow for ${r.entry.site}, but the read-back didn't confirm it.`, OUTCOME_TOAST.unconfirmed, 10000, unconfirmedReason(r.entry.readBack));
      await reread();
    } catch (err) {
      toast(`Couldn't allow ${plan.site ?? plan.host}.`, OUTCOME_TOAST.failed, 10000, err.message);
      close();
      await reread();
    }
  });
}

function wire() {
  const t = encodeURIComponent(tenantId);
  main.querySelector("#collect").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span>Collecting';
    try {
      const r = await api.post(`/api/pilot/${t}/collect`, {});
      if (r.ok) toast(`Collected: ${n(r.added)} new of ${n(r.web)} web events (${n(r.fetched)} events read).`, "ok", 9000);
      else toast(COLLECT_FAILED, "warn", 9000, r.error);
    } catch (err) {
      toast(COLLECT_FAILED, "warn", 9000, err.message);
    }
    await reread();
  });
  main.querySelector("#import").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api.post(`/api/pilot/${t}/import`, { label: file.name, data });
      toast(`Imported ${n(r.added)} new web events from ${file.name}.`, OUTCOME_TOAST.confirmed, 8000);
    } catch (err) {
      toast(`Couldn't import events from ${file.name}.`, OUTCOME_TOAST.failed, 9000, err.message);
    }
    await reread();
  });
  main.querySelector("#schedule").addEventListener("change", async (e) => {
    const box = e.target;
    const on = box.checked;
    try {
      const saved = await api.put(`/api/pilot/${t}/schedule`, { enabled: on });
      // The message says what the server saved, which is what the box shows from here.
      const now = typeof saved?.enabled === "boolean" ? saved.enabled : on;
      view.store.state.enabled = now;
      box.checked = now;
      if (now === on) toast(now ? "Collection is on while the tool runs." : "Collection is off.", OUTCOME_TOAST.confirmed, 5000);
      else toast(`The setting saved is ${now ? "on" : "off"}, not ${on ? "on" : "off"}.`, OUTCOME_TOAST.unconfirmed, 9000, `The server saved collection as ${now ? "on" : "off"}.`);
    } catch (err) {
      // Not saved: the box shows the setting on file again.
      box.checked = view.store.state.enabled;
      toast(`Couldn't turn collection ${on ? "on" : "off"}, so it's still ${view.store.state.enabled ? "on" : "off"}.`, OUTCOME_TOAST.failed, 9000, err.message);
    }
  });
  main.querySelector("#days").addEventListener("change", async (e) => {
    days = Number(e.target.value);
    await reread();
  });
  main.querySelector("#pilotonly").addEventListener("change", async (e) => {
    pilotOnly = e.target.checked;
    await reread();
  });
  // The Retry in the Not read and Pilot devices only cards keeps what's on screen while the read fails, like the note's Retry.
  wireRetry(reread);
  main.querySelectorAll("[data-allow]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await api.post(`/api/pilot/${t}/allow`, { host: b.dataset.allow, dryRun: true });
        allowModal(r.plan);
      } catch (err) {
        toast(`Couldn't run the dry run for ${b.dataset.allow}.`, "warn", 9000, err.message);
      }
    }),
  );
  main.querySelectorAll("[data-undo]").forEach((b) =>
    b.addEventListener("click", async () => {
      const a = view.allows.find((x) => x.id === b.dataset.undo);
      if (!window.confirm(`Undo the Allow for ${a?.site}?`)) return;
      b.disabled = true;
      try {
        const r = await api.post(`/api/pilot/${t}/allow/${encodeURIComponent(b.dataset.undo)}/undo`, {});
        const notes = r.undo ?? [];
        // Green only when every read-back confirmed the undo; an undo read-back on record means Sophos accepted it.
        if (r.status === "undone" && notes.length && notes.every((x) => UNDO_CONFIRMED.has(x))) toast(`Undone. ${notes.join(" ")}`, OUTCOME_TOAST.confirmed, 9000);
        else if (r.status === "undone" || r.undoReadBack) toast(`Sophos accepted the undo for ${a?.site}, but the read-back didn't confirm it.`, OUTCOME_TOAST.unconfirmed, 10000, unconfirmedReason(r.undoReadBack, notes.filter((x) => !UNDO_CONFIRMED.has(x)).join(" ") || r.error));
        else toast(`Couldn't undo the Allow for ${a?.site}.`, OUTCOME_TOAST.failed, 9000, r.error);
      } catch (err) {
        toast(`Couldn't undo the Allow for ${a?.site}.`, OUTCOME_TOAST.failed, 9000, err.message);
      }
      await reread();
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
  await load();
}

start();
