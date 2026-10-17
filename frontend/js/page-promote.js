// Promote and retire: move devices that can use profiles onto the
// pilot one wave at a time, then retire Website Management tags last, with
// a restore from the record and a comparison with the snapshot.

import { api } from "./api.js";
import { currentTenantId, getStatus, initShell, setTenant } from "./shell.js";
import { OUTCOME_TAG, OUTCOME_TOAST, detailHtml, esc, escAttr, plural, readBackParts, retireStatus, retireStepStatus, rollbackUnfinishedBanner, sentence, unconfirmedReason } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { diffHtml } from "./diff-view.js";

const main = document.getElementById("main");
let tenantId = null;
let promo = null;
let retire = null;
let waveSize = null; // the server suggests one until it's changed here
let retirePlan = null;
let chosenTags = [];
let diff = null;

const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const REASON = { "windows-old-agent": "Windows below 2026.1", "windows-no-agent-version": "no agent version", macos: "macOS", other: "other platform", server: "server: needs a server Web Control policy", computer: "computer: needs a Web Control policy" };
// What a move confirmed: the read-back found the new devices on the pilot.
const MOVED = "assignment matches";
// What an undo confirmed: the read-back found the assignment as it was before the wave.
const UNDONE = "assignment back as before the wave";
// What an undo of a wave that wasn't confirmed found when the assignment was already as before it, so nothing was sent.
const ALREADY = "assignment already as before the wave";
// A move Sophos accepted that the read-back didn't confirm (saved as failed, with its read-back, before v0.3.20): it can be undone (category D).
const unconfirmedMove = (w) => w.status === "unconfirmed" || (w.status === "failed" && !!w.readBack);

/**
 * A wave's row as the history shows it (category C): green only when the read-back confirmed the move; amber when
 * Sophos accepted the move or the undo but the read-back didn't confirm it; red when it failed. The plain line goes
 * under the devices, and why (what Sophos or the tool answered) on the Detail line.
 */
function waveRow(w) {
  const tag = (state, label) => `<span class="tag ${state === "done" ? "tag-muted" : OUTCOME_TAG[state]}">${label}</span>`;
  switch (w.status) {
    case "moved":
      return w.readBack === MOVED
        ? { tag: tag("confirmed", "Moved") }
        : { tag: tag("unconfirmed", "Not confirmed"), note: "Sophos accepted the move, but the read-back didn't confirm it. Check the pilot in Sophos Fusion.", detail: unconfirmedReason(w.readBack, w.error) };
    case "unconfirmed":
    case "failed":
      return unconfirmedMove(w)
        ? { tag: tag("unconfirmed", "Not confirmed"), note: "Sophos accepted the move, but the read-back didn't confirm it. Check the pilot in Sophos Fusion.", detail: unconfirmedReason(w.readBack, w.error) }
        : { tag: tag("failed", "Failed"), note: "The move didn't finish.", detail: w.error };
    case "undone":
      return { tag: tag("done", "Undone") };
    case "undo-failed":
      return w.undoReadBack
        ? { tag: tag("unconfirmed", "Undo not confirmed"), note: "Sophos accepted the undo, but the read-back didn't confirm it. Undo again, or check the pilot in Sophos Fusion.", detail: unconfirmedReason(w.undoReadBack, w.error) }
        : { tag: tag("failed", "Undo failed"), note: "The undo didn't finish. Undo again, or check the pilot in Sophos Fusion.", detail: w.error };
    default:
      return { tag: "" };
  }
}

const stepName = (s) => (s.op === "policy-tags" ? s.policyName : s.url);

/**
 * A retire record's outcome (category C): confirmed when every step read back as planned; failed when nothing went
 * through; otherwise amber: it didn't finish (a step failed, or a retire stopped before its last steps), or Sophos
 * accepted every step but a read-back didn't confirm one. The reason is the first step that failed, or the first one
 * not confirmed. A step not confirmed is "unconfirmed" (saved as failed, with its read-back, before v0.3.20).
 */
function retireOutcome(r) {
  if (r.status === "retired" || r.status === "restored") return { state: "confirmed", label: retireStatus(r.status), reason: "" };
  const restoring = r.status === "restore-partial";
  const bad = r.steps.filter((x) => (restoring ? x.status === "restore-failed" : x.status === "failed" || x.status === "unconfirmed"));
  const refused = bad.find((x) => !x.readBack);
  const accepted = r.steps.some((x) => x.status === (restoring ? "restored" : "done") || (bad.includes(x) && x.readBack));
  // A retire stops at a step Sophos refused, so the steps after it were never sent. It goes on past one it couldn't confirm.
  const unsent = !restoring && r.steps.some((x) => x.status === "planned");
  const first = refused ?? bad[0];
  const why = !first ? "" : refused ? sentence(first.error ?? "") : unconfirmedReason(first.readBack, first.error);
  const reason = why ? `${stepName(first)}: ${why}` : "";
  if (!accepted) return { state: "failed", label: retireStatus(r.status), reason };
  if (refused || unsent) return { state: "unconfirmed", label: restoring ? "Restore didn't finish" : "Retire didn't finish", reason };
  return { state: "unconfirmed", label: restoring ? "Restore not confirmed" : "Retire not confirmed", reason, accepted: restoring ? "the restore" : "the retire" };
}

function pilotCard() {
  const p = promo.policy;
  if (!p && promo.pilot && promo.policyUnread) {
    // Any other failed read than a 404 (a 403, a 5xx, no answer in time) doesn't show the policy is gone: say it wasn't read, and offer a retry.
    return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span><span class="tag tag-warn">Not read</span></div>
      <ul class="order-list"><li><span class="o-name">${esc(promo.pilot.policyName)}<span class="o-kind">Policy</span></span><span class="o-meta">not read</span></li></ul>
      <p style="margin:10px 0">The tool couldn't read the pilot policy, so it can't plan waves. That doesn't mean it's gone. Retry, or check it in Sophos Fusion.</p>
      <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(promo.policyUnread))}</p>
      ${rollbackUnfinishedBanner(promo.pilot, tenantId)}
      <div class="head-actions"><button class="btn btn-small" data-retry>Retry</button></div></section>`;
  }
  if (!p && promo.pilot) {
    // The pilot policy is no longer in the tenant: say so, and what to do next.
    return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span><span class="tag tag-bad">Not found</span></div>
      <ul class="order-list"><li><span class="o-name">${esc(promo.pilot.policyName)}<span class="o-kind">Web Control</span></span><span class="o-meta">not in the tenant</span></li></ul>
      <p style="margin-top:10px">${esc(promo.problem ?? "")}</p>
      <div class="head-actions"><a class="btn btn-small" href="/build.html?tenant=${encodeURIComponent(tenantId)}">Open the Build page</a></div></section>`;
  }
  if (!p) return `<section class="panel-card"><h2>Pilot policy</h2><p class="muted">${esc(promo.problem ?? "No pilot.")}</p></section>`;
  return `<section class="panel-card"><div class="card-head"><h2>Pilot policy</h2><span class="spacer"></span>${p.enabled ? '<span class="tag tag-ok">On</span>' : '<span class="tag tag-warn">Off</span>'}</div>
    <ul class="order-list">
      <li><span class="o-name">${esc(p.name)}<span class="o-kind">${p.type === "server-web-control" ? "Server Web Control" : "Web Control"}, priority ${esc(p.priority ?? "?")}</span></span><span class="o-meta">${plural(p.endpoints, "device")}, ${plural(p.endpointGroups, "device group")}${p.users || p.userGroups ? `, ${plural(p.users + p.userGroups, "user target")}` : ""}</span></li>
    </ul>
    ${rollbackUnfinishedBanner(promo.pilot, tenantId)}
    ${p.enabled ? "" : '<p class="hint">Off: devices moved onto it keep their current filtering until you turn it on.</p>'}
    <div class="head-actions"><button class="btn btn-small ${p.enabled ? "" : "btn-soft"}" id="toggle">${p.enabled ? "Turn off" : "Turn on"}</button></div></section>`;
}

function wavesCard() {
  if (!promo.plan) return "";
  const plan = promo.plan;
  const waves = plan.waves
    .map((w) => `<li><div><div class="w-name">Wave ${w.n}: ${n(w.devices.length)} ${w.devices.length === 1 ? "device" : "devices"}</div><div class="w-devs">${esc(w.devices.slice(0, 12).map((d) => `${d.hostname}${d.group !== "No group" ? ` (${d.group})` : ""}`).join(", "))}${w.devices.length > 12 ? `, and ${n(w.devices.length - 12)} more` : ""}</div></div>
      <button class="btn btn-small btn-soft" data-wave="${w.n}"${promo.mode === "devices" ? "" : " disabled"}>${icon("play")}Move wave ${w.n}</button></li>`)
    .join("");
  return `<section class="panel-card"><div class="card-head"><h2>Waves</h2><span class="spacer"></span>
      <label class="cu-options">Devices per wave <input type="number" id="wavesize" min="1" max="500" value="${promo.waveSize ?? waveSize ?? 25}" style="width:80px" /></label></div>
    ${promo.problem && promo.mode === "users" ? `<div class="banner banner-warn">${esc(promo.problem)}</div>` : ""}
    <p class="hint">Only Windows devices on Sophos Endpoint 2026.1 or later, not yet on the pilot. Each wave is one change to the pilot's assignment, read back before the next. On the pilot now: ${n(plan.inPilot.length)}.</p>
    ${waves ? `<ul class="wave-list">${waves}</ul>` : '<p class="muted">Every device that can use profiles is on the pilot.</p>'}
  </section>`;
}

// Why Undo is off on a wave while the pilot policy it changed wasn't read, or is no longer in the tenant.
const UNDO_OFF = "Undo is off: the tool couldn't read the pilot policy.";
const UNDO_GONE = "Undo is off: the pilot policy is no longer in the tenant.";

function historyCard() {
  // While the pilot policy isn't read, its assignment can't be checked, and once it's gone there's none to put back, so Undo is off on its waves; the server refuses it too.
  const why = promo.policyUnread ? UNDO_OFF : !promo.policy && promo.pilot ? UNDO_GONE : "";
  const off = (w) => !!why && w.policyId === promo.pilot?.policyId;
  // A move that wasn't confirmed may be in place, so it can be undone like a confirmed one; the server refuses nothing else.
  const undoable = promo.waves.filter((w) => ["moved", "undo-failed"].includes(w.status) || unconfirmedMove(w));
  const rows = promo.waves
    .map((w) => {
      // A read-back that couldn't read the policy says "not read" here; why goes on the Detail line.
      const back = readBackParts(w.readBack);
      const row = waveRow(w);
      return `<li><div><div class="w-name">${when(w.at)}: ${n(w.devices.length)} ${w.devices.length === 1 ? "device" : "devices"}</div><div class="w-devs">${esc(w.devices.map((d) => d.hostname).join(", "))}${back.plain ? `. Read back: ${esc(back.plain)}` : ""}</div>${row.note ? `<span class="err-note">${row.note}</span>` : ""}${detailHtml(row.detail)}</div>
      <span>${row.tag}${undoable.includes(w) ? ` <button class="btn btn-small" data-undo-wave="${escAttr(w.id)}"${off(w) ? ` disabled title="${escAttr(why)}"` : ""}>Undo</button>` : ""}</span></li>`;
    })
    .join("");
  return `<section class="panel-card"><h2>Waves moved</h2>${undoable.some(off) ? `<p class="hint" data-undo-off>${esc(why)}</p>` : ""}${rows ? `<ul class="wave-list">${rows}</ul>` : '<p class="muted">None yet.</p>'}</section>`;
}

function classicCard() {
  // No plan while the pilot policy wasn't read.
  if (!promo.plan) return "";
  const all = promo.plan.notEligible ?? [];
  // A large estate can have thousands: count them by reason, then list the first few.
  const counts = Object.entries(all.reduce((m, d) => ((m[d.reason] = (m[d.reason] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const rows = all.slice(0, 25).map((d) => `<li><span class="o-name">${esc(d.hostname)}</span><span class="o-meta">${esc(REASON[d.reason] ?? d.reason)}</span></li>`).join("");
  return `<section class="panel-card"><div class="card-head"><h2>Devices that stay on classic settings</h2><span class="spacer"></span>${all.length ? `<span class="tag tag-muted">${n(all.length)}</span>` : ""}</div>
    ${counts.length ? `<ul class="order-list">${counts.map(([r, c]) => `<li><span class="o-name">${esc(REASON[r] ?? r)}</span><span class="o-meta">${n(c)}</span></li>`).join("")}</ul>` : ""}
    ${rows ? `<ul class="order-list" style="margin-top:10px">${rows}</ul>${all.length > 25 ? `<p class="hint">And ${n(all.length - 25)} more.</p>` : ""}<p class="hint">Keep a classic Web Control policy, and the tags it uses, for these devices.</p>` : '<p class="muted">None.</p>'}</section>`;
}

function retireCard() {
  const rows = retire.tags
    .map((t) => `<tr><td><label class="checkbox"><input type="checkbox" name="tag" value="${escAttr(t.tag)}"${chosenTags.includes(t.tag) ? " checked" : ""}/> <b>${esc(t.tag)}</b></label></td><td class="num">${n(t.entries)}</td><td class="num">${n(t.only)}</td>
      <td>${t.policies.length ? `<div class="tag-cell">${t.policies.map((p) => `<span class="tag ${p.onProfile ? "tag-muted" : p.enabled && p.targets ? "tag-warn" : "tag-muted"}" title="${escAttr(`${p.action}, ${p.onProfile ? "on a profile" : "classic"}, ${p.enabled ? "on" : "off"}, ${p.targets} targets`)}">${esc(p.name)}: ${esc(p.action)}</span>`).join("")}</div>` : '<span class="muted">no policy</span>'}</td></tr>`)
    .join("");
  const plan = retirePlan;
  const steps = plan
    ? plan.steps.map((s) => `<li>${esc(s.op === "policy-tags" ? `Policy "${s.policyName}": remove ${s.before.filter((x) => !s.after.some((y) => y.tag === x.tag)).map((x) => x.tag).join(", ")} from its tags` : s.op === "delete-entry" ? `Delete ${s.url} (tags ${s.tags.join(", ")})` : `${s.url}: tags ${s.before.join(", ")} become ${s.after.join(", ") || "none"}`)}</li>`).join("")
    : "";
  return `<section class="panel-card"><div class="card-head"><h2>Retire Website Management tags</h2><span class="spacer"></span><span class="hint">Last, once every wave is done</span></div>
    <p class="hint">Retiring takes a fresh rollback snapshot, removes the tags from each policy first, then deletes the entries that carried only those tags and untags the rest. Each write is read back and audited; Restore puts it all back.</p>
    ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tag</th><th class="num">Entries</th><th class="num">Only this tag</th><th>Policies (warn: classic and in use)</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Website Management has no tags.</p>'}
    <div class="head-actions"><button class="btn" id="plan-retire"${rows ? "" : " disabled"}>${icon("search")}Dry run</button></div>
    ${plan ? `<h3>Plan for ${esc(plan.tags.join(", "))}</h3>
      ${plan.problems.length ? `<ul class="check-list">${plan.problems.map((p) => `<li class="fail">${esc(p)}</li>`).join("")}</ul>` : `<ol class="flag-list">${steps}</ol>`}
      ${plan.warnings.length ? `<ul class="check-list">${plan.warnings.map((p) => `<li class="warn">${esc(p)}</li>`).join("")}</ul><label class="checkbox cu-options"><input type="checkbox" id="confirm-retire"/> I've read the warnings; retire anyway</label>` : ""}
      <div class="head-actions"><button class="btn btn-danger" id="go-retire"${plan.problems.length ? " disabled" : ""}>Retire ${esc(plan.tags.join(", "))}</button></div>` : ""}
  </section>`;
}

function recordsCard() {
  const rows = retire.records
    .map((r) => {
      // A restored record is muted, not green: the retire it undid is over. A read-back that couldn't read says "not read"; why goes on the Detail line.
      const o = retireOutcome(r);
      const cls = r.status === "restored" ? "tag-muted" : OUTCOME_TAG[o.state];
      return `<tr><td class="r-when">${when(r.at)}</td><td class="r-tags">${esc(r.tags.join(", "))}</td><td class="r-status"><span class="tag ${cls}">${esc(o.label)}</span></td><td class="r-steps">${esc(r.steps.map((s) => `${stepName(s)}: ${retireStepStatus(s.status, s.readBack)}${s.readBack ? ` (${readBackParts(s.readBack).plain})` : ""}`).join("; "))}${detailHtml(o.reason)}</td>
      <td class="r-act"><div class="r-actions">${["retired", "partial", "restore-partial", "failed"].includes(r.status) ? `<button class="btn btn-small" data-restore="${escAttr(r.id)}">Restore</button>` : ""}<button class="btn btn-small" data-diff="${escAttr(r.snapshotFile)}">Compare with snapshot</button></div></td></tr>`;
    })
    .join("");
  // The card sizes the table: on a narrow card each record stacks, so the status and the buttons are never cut off.
  return `<section class="panel-card retired-card"><h2>Retired</h2>${rows ? `<div class="table-wrap"><table class="data-table retired-table"><thead><tr><th>When</th><th>Tags</th><th>Status</th><th>Steps</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Nothing retired yet.</p>'}</section>`;
}

function headline() {
  if (promo.policyUnread) return "Couldn't read the pilot policy";
  const plan = promo.plan;
  if (!plan) return "Promote and retire";
  const left = plan.waves.reduce((a, w) => a + w.devices.length, 0);
  const total = left + plan.inPilot.length;
  return total ? `${n(plan.inPilot.length)} of ${n(total)} devices that can use profiles are on the pilot` : "No device can use profiles yet";
}

function render() {
  main.innerHTML = `
    <section class="page-head">
      <div><span class="eyebrow">Promote and retire${promo.pilot ? `: ${esc(promo.pilot.policyName)}` : ""}</span>
        <h1>${headline()}</h1>
        <p class="page-lead">Move devices onto the pilot in waves, with a read-back after each. Devices that can't use profiles stay on classic settings. Retire Website Management tags last.</p></div>
    </section>
    <div class="build-grid">
      <div class="score-main">${pilotCard()}${classicCard()}</div>
      <div class="score-main">${wavesCard()}${historyCard()}${retireCard()}${recordsCard()}${diffHtml(diff)}</div>
    </div>`;
  wire();
}

async function refresh() {
  const t = encodeURIComponent(tenantId);
  [promo, retire] = await Promise.all([api.get(`/api/promote/${t}${waveSize ? `?waveSize=${waveSize}` : ""}`), api.get(`/api/retire/${t}`)]);
  render();
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
    // The last read, drawn again so every button is as it was.
    render();
    main.querySelector(".page-head").insertAdjacentHTML(
      "afterend",
      `<section class="panel-card" style="margin-bottom:18px" data-reread-failed><h2>Couldn't read the tenant</h2>
        <p style="margin:0 0 10px">The tool couldn't read the pilot, the devices or Website Management, so the page still shows what it read before. Retry, or check the tenant in Sophos Fusion.</p>
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

/** Reads the page. When a read fails, the page says so in plain words and offers a retry; Sophos's answer stays out of the main text. */
async function load() {
  try {
    await refresh();
  } catch (err) {
    main.innerHTML = `
      <section class="page-head"><div><span class="eyebrow">Promote and retire</span><h1>Couldn't read the tenant</h1></div></section>
      <section class="panel-card"><p style="margin:0 0 10px">The tool couldn't read the pilot, the devices or Website Management from Sophos Fusion, so there's nothing to show yet. Retry, or check the tenant in Sophos Fusion.</p>
        <p class="hint" style="margin:0 0 10px;overflow-wrap:anywhere" data-unread-detail>Detail: ${esc(sentence(err.message))}</p>
        <div class="head-actions"><button class="btn btn-small" data-retry>Retry</button></div></section>`;
    wireRetry();
  }
}

function wireRetry() {
  main.querySelectorAll("[data-retry]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>Reading';
      await load();
    }),
  );
}

/** The message after a retire or a restore: its outcome in plain words, colored by what was confirmed, with the reason on the Detail line. */
function outcomeToast(r) {
  const o = retireOutcome(r);
  const text = o.accepted ? `Sophos accepted ${o.accepted}, but the read-back didn't confirm all of it.` : `${o.label}.`;
  toast(text, OUTCOME_TOAST[o.state], o.state === "confirmed" ? 9000 : 10000, o.reason);
}

function wire() {
  const t = encodeURIComponent(tenantId);
  wireRetry();
  main.querySelector("#wavesize")?.addEventListener("change", async (e) => {
    waveSize = Math.max(1, Number(e.target.value) || 25);
    await reread();
  });
  main.querySelector("#toggle")?.addEventListener("click", async () => {
    const on = !promo.policy.enabled;
    if (!window.confirm(on ? `Turn on "${promo.policy.name}"? Its devices start filtering with the profile.` : `Turn off "${promo.policy.name}"? Its devices fall back to the next policy.`)) return;
    const word = on ? "on" : "off";
    try {
      const r = await api.post(`/api/promote/${t}/enabled`, { enabled: on });
      // Green only when the read-back confirmed it; why it isn't confirmed goes on the Detail line, never the read-back itself in the message.
      if (r.readBack === "matches") toast(`Pilot turned ${word} and read back.`, OUTCOME_TOAST.confirmed, 8000);
      else toast(`Sophos accepted turning the pilot ${word}, but the read-back didn't confirm it.`, OUTCOME_TOAST.unconfirmed, 10000, readBackParts(r.readBack).detail || `The pilot policy read back still ${on ? "off" : "on"}.`);
    } catch (err) {
      toast(`Couldn't turn the pilot ${word}.`, OUTCOME_TOAST.failed, 9000, err.message);
    }
    await reread();
  });
  main.querySelectorAll("[data-wave]").forEach((b) =>
    b.addEventListener("click", async () => {
      const wave = promo.plan.waves.find((w) => w.n === Number(b.dataset.wave));
      const ids = wave.devices.map((d) => d.id);
      try {
        const dry = await api.post(`/api/promote/${t}/wave`, { devices: ids, dryRun: true });
        if (dry.problems.length) {
          toast(dry.problems.join(" "), "warn", 10000);
          return;
        }
        if (!window.confirm(`Dry run: "${dry.policyName}" goes from ${dry.before.endpoints.length} to ${dry.after.endpoints.length} devices (${dry.devices.map((d) => d.hostname).join(", ")})${dry.enabled ? "" : ". The pilot is off, so filtering doesn't change yet"}. Move this wave?`)) return;
        b.disabled = true;
        b.innerHTML = '<span class="spinner"></span>Moving';
        const r = await api.post(`/api/promote/${t}/wave`, { devices: ids, dryRun: false });
        // Green only when the read-back found the devices on the pilot. A read-back on record means Sophos accepted the move.
        if (r.status === "moved" && r.readBack === MOVED) toast(`Wave ${wave.n} moved and read back.`, OUTCOME_TOAST.confirmed, 9000);
        else if (r.readBack) toast(`Sophos accepted wave ${wave.n}, but the read-back didn't confirm the move.`, OUTCOME_TOAST.unconfirmed, 10000, unconfirmedReason(r.readBack, r.error));
        else toast(`Couldn't move wave ${wave.n}.`, OUTCOME_TOAST.failed, 9000, r.error);
      } catch (err) {
        toast(`Couldn't move wave ${wave.n}.`, OUTCOME_TOAST.failed, 9000, err.message);
      }
      await reread();
    }),
  );
  main.querySelectorAll("[data-undo-wave]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!window.confirm("Put the pilot's assignment back as it was before this wave?")) return;
      try {
        const r = await api.post(`/api/promote/${t}/wave/${encodeURIComponent(b.dataset.undoWave)}/undo`, {});
        // Green only when the read-back found the assignment as it was; an undo read-back on record means Sophos accepted the undo.
        if (r.status === "undone" && r.readBack === UNDONE) toast("Wave undone and read back.", OUTCOME_TOAST.confirmed, 9000);
        else if (r.status === "undone" && r.readBack === ALREADY) toast("Nothing to undo: the pilot read back with its assignment as it was before this wave.", OUTCOME_TOAST.confirmed, 9000);
        else if (r.undoReadBack || r.status === "undone") toast("Sophos accepted the undo, but the read-back didn't confirm it.", OUTCOME_TOAST.unconfirmed, 10000, unconfirmedReason(r.undoReadBack ?? r.readBack, r.error));
        else toast("Couldn't undo the wave.", OUTCOME_TOAST.failed, 9000, r.error);
      } catch (err) {
        toast("Couldn't undo the wave.", OUTCOME_TOAST.failed, 9000, err.message);
      }
      await reread();
    }),
  );
  main.querySelectorAll('input[name="tag"]').forEach((c) =>
    c.addEventListener("change", () => {
      chosenTags = [...main.querySelectorAll('input[name="tag"]:checked')].map((x) => x.value);
    }),
  );
  main.querySelector("#plan-retire")?.addEventListener("click", async () => {
    if (!chosenTags.length) return toast("Choose the tags to retire.", "warn", 5000);
    try {
      retirePlan = await api.post(`/api/retire/${t}/plan`, { tags: chosenTags });
      render();
    } catch (err) {
      toast("Couldn't run the dry run.", "warn", 9000, err.message);
    }
  });
  main.querySelector("#go-retire")?.addEventListener("click", async (e) => {
    const confirmBox = main.querySelector("#confirm-retire");
    if (confirmBox && !confirmBox.checked) return toast("Tick the box to confirm the warnings first.", "warn", 6000);
    if (!window.confirm(`Retire ${retirePlan.tags.join(", ")}? A rollback snapshot is saved first.`)) return;
    e.target.disabled = true;
    e.target.innerHTML = '<span class="spinner"></span>Retiring';
    try {
      const r = await api.post(`/api/retire/${t}/execute`, { tags: retirePlan.tags, confirm: !!confirmBox?.checked });
      outcomeToast(r);
      retirePlan = null;
      chosenTags = [];
    } catch (err) {
      toast("Couldn't retire the tags.", OUTCOME_TOAST.failed, 10000, err.message);
    }
    await reread();
  });
  main.querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!window.confirm("Restore: re-create and re-tag the entries, then put the tags back in each policy?")) return;
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>Restoring';
      try {
        const r = await api.post(`/api/retire/${t}/${encodeURIComponent(b.dataset.restore)}/restore`, {});
        outcomeToast(r);
      } catch (err) {
        toast("Couldn't restore the tags.", OUTCOME_TOAST.failed, 10000, err.message);
      }
      await reread();
    }),
  );
  main.querySelectorAll("[data-diff]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.innerHTML = '<span class="spinner"></span>Reading';
      try {
        diff = await api.post(`/api/diff/${t}`, { snapshotFile: b.dataset.diff });
      } catch (err) {
        toast("Couldn't compare with the snapshot.", "warn", 10000, err.message);
      }
      render();
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
  main.innerHTML = '<p class="running-line"><span class="spinner"></span>Reading the pilot, devices and Website Management</p>';
  await load();
}

start();
