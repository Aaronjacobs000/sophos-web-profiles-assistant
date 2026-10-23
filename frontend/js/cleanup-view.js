// The clean-up results view, shared by the clean-up step and the standalone
// site list cleaner: summary bar, planned lists with exports, the results
// table with filters, and per-entry decisions.

import { api } from "./api.js";
import { OUTCOME_TOAST, detailHtml, esc, escAttr, readBackParts, sentence, unansweredReason } from "./ui.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";

export const n = (x) => Number(x ?? 0).toLocaleString("en-US");

const VERDICT_TAG = {
  covered: '<span class="tag tag-ok">Covered</span>',
  exception: '<span class="tag tag-accent">Exception</span>',
  remove: '<span class="tag tag-muted">Remove</span>',
};
const ACTION_TAG = { allow: "tag-ok", block: "tag-bad", warn: "tag-warn", mixed: "tag-warn", none: "tag-muted" };

export function summaryHtml(summary) {
  if (!summary?.total) return "";
  const pct = (x) => (summary.total ? (x / summary.total) * 100 : 0);
  return `<div class="cu-bar" role="img" aria-label="${escAttr(`${summary.covered} covered, ${summary.remove} remove, ${summary.exception} exceptions`)}">
      <span class="c-cov" style="width:${pct(summary.covered)}%"></span><span class="c-rem" style="width:${pct(summary.remove)}%"></span><span class="c-exc" style="width:${pct(summary.exception)}%"></span>
    </div>
    <div class="cu-counts">
      <span><b>${n(summary.covered)}</b> covered by a category</span>
      <span><b>${n(summary.remove)}</b> remove: dead, repeated, or unused</span>
      <span><b>${n(summary.exception)}</b> exceptions for site lists</span>
      ${summary.needsDecision ? `<span class="cu-decide">Of these, <b>${n(summary.needsDecision)}</b> need a decision</span>` : ""}
    </div>`;
}

// A delete an undo couldn't confirm can be sent again (category D), like a list the create made.
const OPEN_DELETE = ["not confirmed", "still there after delete"];
// So can a delete Sophos refused, as a rollback sends one again.
const REFUSED_DELETE = ["delete failed", "in use by a profile, left"];

// A list Sophos didn't confirm was made has no id: an undo looks for it by name, and says when it couldn't read the site lists.
const lookUpUnread = (l) => l.status === "unconfirmed" && !l.id && /^not read: /.test(l.lookedUp ?? "");

/** What the last undo left, for the note by Undo again: deletes it couldn't confirm, deletes Sophos refused, and lists it couldn't look for. */
function undoLeftHint(open, refused, unread = []) {
  const named = (xs) => (xs.length === 1 ? `"${esc(xs[0].name)}"` : `${xs.length} site lists`);
  const failed = refused.filter((l) => l.status === "delete failed");
  const inUse = refused.filter((l) => l.status === "in use by a profile, left");
  const said = [];
  if (open.length) said.push(`The last undo didn't confirm ${named(open)} deleted.`);
  if (failed.length) said.push(`${said.length ? "It" : "The last undo"} couldn't delete ${named(failed)}.`);
  const one = inUse.length === 1;
  if (inUse.length) said.push(`${named(inUse)} ${one ? "is" : "are"} in use by a profile, so ${one ? "it was" : "they were"} left: take ${one ? "it" : "them"} off the profile in Sophos Fusion first.`);
  if (unread.length) said.push(`${said.length ? "It" : "The last undo"} couldn't look for ${named(unread)} by name, so ${unread.length === 1 ? "it" : "they"} may be in the tenant.`);
  const n = open.length + refused.length;
  const again = !n ? "look again" : `send ${n === 1 ? "that delete" : "those deletes"} again${unread.length ? " and look again" : ""}`;
  return `${said.join(" ")} Undo again to ${again}, or check the site lists in Sophos Fusion.`;
}

export function listsHtml(view, base) {
  const lists = view.lists ?? [];
  const last = view.lastLists?.lists ?? [];
  const made = last.some((l) => l.status === "created");
  const open = last.filter((l) => OPEN_DELETE.includes(l.status));
  const refused = last.filter((l) => REFUSED_DELETE.includes(l.status));
  // A list Sophos didn't confirm was made can be undone too: the undo looks for it by name first.
  const asked = last.filter((l) => l.status === "unconfirmed" && !l.id);
  const unread = asked.filter(lookUpUnread);
  const first = made || asked.length > unread.length;
  const cards = lists
    .map(
      (l, i) => `<div class="cu-list"><span class="tag ${ACTION_TAG[l.action]}">${esc(l.action)}</span><div><b>${esc(l.name)}</b><span class="hint">${n(l.sites)} ${l.sites === 1 ? "site" : "sites"}</span></div><a class="btn btn-small" href="${base}/${i}.csv">${icon("download")}CSV</a></div>`,
    )
    .join("");
  return `<div class="cu-lists">${cards || '<p class="muted">No exceptions to put in a site list yet.</p>'}
    <div class="cu-list-actions">
      <a class="btn" href="${base}/results.csv">${icon("download")}All results (CSV)</a>
      ${view.canCreate ? `<button class="btn btn-soft" id="create-lists"${lists.length ? "" : " disabled"}>${icon("play")}Create site lists</button>` : ""}
      ${made || open.length || refused.length || asked.length ? `<button class="btn" id="undo-lists">${first ? "Undo last lists" : "Undo again"}</button>` : ""}
    </div>
    ${(open.length || refused.length || unread.length) && !first ? `<p class="hint" data-undo-open>${undoLeftHint(open, refused, unread)}</p>` : ""}
    ${view.leftOut ? `<p class="hint">${n(view.leftOut)} ${view.leftOut === 1 ? "entry is" : "entries are"} left out until you decide: broad entries, and entries with different actions in different policies.</p>` : ""}
  </div>`;
}

let filter = "all";
let query = "";

/** Why, in plain words. A lookup that failed puts what Intelix answered in the reason; that answer goes on the Detail line. */
function whyHtml(r) {
  if (r.decided) return esc("Your decision.");
  const raw = r.lookupError && r.reason.includes(`(${r.lookupError})`) ? r.lookupError : "";
  return `${esc(raw ? r.reason.replace(`(${raw})`, "(the lookup failed)") : r.reason)}${detailHtml(raw)}`;
}

function rowHtml(r) {
  const verdict = r.decided?.verdict ?? r.verdict;
  const action = r.decided?.action ?? r.action;
  const cat = r.categoryLabel ?? r.lookup?.productivityCategory ?? (r.lookupError ? "Lookup failed" : r.lookup ? "No category" : "Not looked up");
  const risk = r.lookup?.riskLevel ?? "";
  return `<tr data-id="${escAttr(r.id)}">
    <td class="cu-site"><b>${esc(r.site.value || r.raw)}</b>${r.site.value && r.site.value !== r.raw.trim() ? `<span class="t-sub">was ${esc(r.raw)}</span>` : ""}</td>
    <td>${r.tags.length ? esc(r.tags.join(", ")) : r.override ? "" : '<span class="muted">none</span>'}${r.override ? `<span class="t-sub">Category override: ${esc(r.override)}</span>` : ""}<span class="t-sub"><span class="tag ${ACTION_TAG[action] ?? "tag-muted"}">${esc(action)}</span></span></td>
    <td>${esc(cat)}${r.lookup?.securityRisk ? `<span class="t-sub" style="color:var(--bad)">${esc(r.lookup.securityCategory)}</span>` : ""}</td>
    <td>${risk ? `<span class="${risk === "HIGH" ? "off" : ""}">${esc(risk)}</span>` : '<span class="muted">none</span>'}</td>
    <td>${r.dns ? esc(r.dns.status) : '<span class="muted">not checked</span>'}</td>
    <td>${VERDICT_TAG[verdict]}${r.needsDecision && !r.decided ? ' <span class="tag tag-warn">Decide</span>' : ""}</td>
    <td class="cu-why">${whyHtml(r)}</td>
    <td><select class="cu-decision" aria-label="Decision">
      <option value="">${r.decided ? "Undo decision" : "Keep"}</option>
      <option value="covered"${r.decided?.verdict === "covered" ? " selected" : ""}>Covered</option>
      <option value="exception"${r.decided?.verdict === "exception" ? " selected" : ""}>Exception</option>
      <option value="remove"${r.decided?.verdict === "remove" ? " selected" : ""}>Remove</option>
    </select></td>
  </tr>`;
}

export function tableHtml(results) {
  const counts = { all: results.length, exception: 0, covered: 0, remove: 0, decide: 0 };
  for (const r of results) {
    counts[r.decided?.verdict ?? r.verdict]++;
    if (r.needsDecision && !r.decided) counts.decide++;
  }
  const shown = results.filter((r) => {
    const v = r.decided?.verdict ?? r.verdict;
    if (filter === "decide" && !(r.needsDecision && !r.decided)) return false;
    if (filter !== "all" && filter !== "decide" && v !== filter) return false;
    if (query && !`${r.raw} ${r.site.value} ${r.tags.join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const tabs = [["all", "All"], ["exception", "Exceptions"], ["covered", "Covered"], ["remove", "Remove"], ["decide", "Need a decision"]]
    .map(([k, label]) => `<button type="button" class="seg-btn${filter === k ? " is-active" : ""}" data-filter="${k}">${label} <span class="seg-count">${n(counts[k])}</span></button>`)
    .join("");
  return `<section class="panel-card">
    <div class="card-head"><div class="seg">${tabs}</div><span class="spacer"></span><input type="search" id="cu-q" placeholder="Search sites or tags" value="${escAttr(query)}" /></div>
    <div class="table-wrap"><table class="data-table cu-table"><thead><tr><th>Site</th><th>Tag today</th><th>SophosLabs category</th><th>Risk</th><th>DNS</th><th>Verdict</th><th>Why</th><th>Decide</th></tr></thead>
    <tbody>${shown.slice(0, 500).map(rowHtml).join("") || '<tr><td colspan="8" class="empty-state">Nothing here.</td></tr>'}</tbody></table></div>
    ${shown.length > 500 ? `<p class="hint">Showing 500 of ${n(shown.length)}. The CSV has them all.</p>` : ""}
  </section>`;
}

/** Why a list's read-back didn't confirm it, for a Detail line: what Sophos answered when it couldn't be read, else what was read. */
function listReason(l) {
  const back = readBackParts(l.readBack);
  return `"${l.name}": ${sentence(back.detail || back.plain || "no read-back on record")}`;
}

/**
 * What a create did (category C): green only when every list was made and read back with the sites sent; amber when
 * Sophos made lists but a read-back didn't confirm one, or a later list failed, or Sophos didn't answer a create with a
 * success and nothing could be read to look for it (unconfirmed); red when none was made. Which list failed and that the
 * lists after it weren't sent are in the message; what Sophos answered, and why a list isn't confirmed, on the Detail
 * line. A list found by name, which the last create asked for, is said: it was used, not made again.
 */
function listsOutcome(rec, planned) {
  const made = rec.lists.filter((l) => l.status === "created");
  const open = made.filter((l) => l.readBack !== "matches");
  const failed = rec.lists.find((l) => l.status === "failed");
  const unknown = rec.lists.find((l) => l.status === "unconfirmed");
  const used = made.filter((l) => l.note);
  const lists = (k) => `${k} site ${k === 1 ? "list" : "lists"}`;
  const confirmed = !open.length ? " and read back" : open.length === made.length ? ", not confirmed on read-back" : `, ${open.length} not confirmed on read-back`;
  const reasons = open.map(listReason);
  const usedText = used.length ? ` ${used.length === 1 ? `"${used[0].name}" was` : `${used.length} of them were`} found by name and used, not made again.` : "";
  if (unknown) {
    const notSent = planned - made.length - 1;
    const rest = notSent > 0 ? `, so ${notSent === 1 ? "the list after it wasn't" : `the ${notSent} lists after it weren't`} sent` : "";
    return {
      state: "unconfirmed",
      text: `${made.length ? `${made.length} of ${lists(planned)} created${confirmed}.${usedText} ` : ""}Sophos didn't say creating "${unknown.name}" went through, and the read-back didn't confirm it${rest}.`,
      reason: [`"${unknown.name}": ${unansweredReason(unknown.answer, unknown.readBack)}`, ...reasons].join(" "),
    };
  }
  if (failed) {
    const notSent = planned - made.length - 1;
    const rest = notSent > 0 ? `, so ${notSent === 1 ? "the list after it wasn't" : `the ${notSent} lists after it weren't`} sent` : "";
    return {
      state: made.length ? "unconfirmed" : "failed",
      text: `${made.length ? `${made.length} of ${lists(planned)} created${confirmed}.${usedText}` : "No site lists created."} Creating "${failed.name}" failed${rest}.`,
      reason: [sentence(failed.error ?? ""), ...reasons].filter(Boolean).join(" "),
    };
  }
  if (!open.length) return { state: "confirmed", text: `${lists(made.length)} created and read back.${usedText}`, reason: "" };
  const which = open.length === 1 ? `"${open[0].name}"` : `${open.length} of them`;
  return { state: "unconfirmed", text: `${lists(made.length)} created, but the read-back didn't confirm ${which}.${usedText}`, reason: reasons.join(" ") };
}

/**
 * What an undo did (category C): green only when every list read back gone (404); amber when Sophos accepted a delete,
 * or didn't answer it with a success, but the read-back didn't confirm it, or some were deleted and others refused; red
 * when every delete was refused. It says Sophos accepted a delete only when Sophos answered it with a success. Why goes
 * on the Detail line. A list Sophos didn't confirm was made is looked for by name: the message says what was found and
 * deleted, or wasn't there, and it's amber when the site lists couldn't be read to look.
 */
function undoOutcome(rec) {
  const rows = rec.lists.filter((l) => ["deleted", "still there after delete", "not confirmed", "in use by a profile, left", "delete failed"].includes(l.status));
  const gone = rows.filter((l) => l.status === "deleted");
  const open = rows.filter((l) => l.status === "still there after delete" || l.status === "not confirmed");
  const refused = rows.filter((l) => l.status === "in use by a profile, left" || l.status === "delete failed");
  // Lists Sophos didn't confirm were made, looked for by name: found (then deleted as above), not there, or not read.
  const unread = rec.lists.filter(lookUpUnread);
  const lists = (k) => `${k} site ${k === 1 ? "list" : "lists"}`;
  const name = (xs, many) => (xs.length === 1 ? `"${xs[0].name}"` : many);
  const why = (l) => (l.status === "in use by a profile, left" ? `"${l.name}" is in use by a profile, so it was left.${l.error ? ` ${sentence(l.error)}` : ""}` : `"${l.name}": ${sentence(l.error ?? "")}`);
  const looked = lookedUpText(rec.lists);
  // A list found by name and deleted is said once, in looked.
  const plainGone = gone.filter((l) => l.lookedUp !== "found");
  // A list that read back still there, or couldn't be read back, and why: first what Sophos said when it wasn't a success.
  const openWhy = (l) => {
    const back = readBackParts(l.readBack);
    if (l.deleteAnswer) return `"${l.name}": ${sentence(l.deleteAnswer)} Read back: ${sentence(back.detail || back.plain)}`;
    return back.detail ? `"${l.name}": ${sentence(back.detail)}` : `"${l.name}" was still there after the delete.`;
  };
  const reasons = [...refused.map(why), ...open.map(openWhy)].join(" ");
  if (unread.length) {
    const one = unread.length === 1;
    const text = `Couldn't confirm whether ${name(unread, `${unread.length} site lists`)} ${one ? "is" : "are"} in the tenant: Sophos didn't confirm ${one ? "it was" : "they were"} made, and the undo couldn't look for ${one ? "it" : "them"} by name. Check the site lists in Sophos Fusion, or undo again.`;
    const left = open.length + refused.length;
    const rest = [plainGone.length ? ` ${lists(plainGone.length)} deleted and read back.` : "", left ? ` ${left === 1 ? "One delete isn't" : `${left} deletes aren't`} confirmed.` : ""].join("");
    return { state: "unconfirmed", text: `${text}${rest}${looked}`, reason: [...unread.map((l) => `"${l.name}": ${sentence(readBackParts(l.lookedUp).detail)}`), reasons].filter(Boolean).join(" ") };
  }
  if (!open.length && !refused.length) {
    if (!plainGone.length) return { state: "confirmed", text: `Undone.${looked}`, reason: "" };
    return { state: "confirmed", text: `Undone: ${plainGone.length === 1 ? `"${plainGone[0].name}" deleted` : `${lists(plainGone.length)} deleted`} and read back.${looked}`, reason: "" };
  }
  if (refused.length) {
    const done = gone.length + open.length;
    return { state: done ? "unconfirmed" : "failed", text: `Couldn't delete ${name(refused, `${refused.length} of the site lists`)}${gone.length ? `. ${lists(gone.length)} deleted and read back` : ""}${open.length ? `. ${open.length === 1 ? "One delete isn't" : `${open.length} deletes aren't`} confirmed` : ""}.${looked}`, reason: reasons };
  }
  // A delete Sophos answered with a 5xx or a 404, or not at all, wasn't accepted: say what's known, not that it was.
  const unanswered = open.filter((l) => l.deleteAnswer);
  if (!unanswered.length) return { state: "unconfirmed", text: `Sophos accepted the ${open.length + gone.length === 1 ? "delete" : "deletes"}, but the read-back didn't confirm ${name(open, `${open.length} of them`)}.${looked}`, reason: reasons };
  const [n, k] = [open.length, unanswered.length];
  const text =
    n === 1
      ? `Sophos didn't say the delete of "${open[0].name}" went through, and the read-back didn't confirm it.`
      : k === n
        ? `Sophos didn't say ${n} of the deletes went through, and the read-back didn't confirm them.`
        : `The read-back didn't confirm ${n} of the deletes, and Sophos didn't say ${k} of those went through.`;
  return { state: "unconfirmed", text: `${text}${looked}`, reason: reasons };
}

/** What an undo did with each list Sophos didn't confirm was made, which it looked for by name: found and deleted, or not there. */
function lookedUpText(rows) {
  return rows
    .filter((l) => (l.lookedUp === "found" && l.status === "deleted") || l.lookedUp === "not found")
    .map((l) => ` "${l.name}", which Sophos didn't confirm was made, ${l.lookedUp === "found" ? "was found by name, deleted and read back" : "isn't in the tenant, so there was nothing to remove"}.`)
    .join("");
}

/** Wires filters, search, decisions and list buttons. `endpoints` names the page's API paths. */
export function wireView(root, view, endpoints, rerender) {
  root.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.filter; rerender(view); }));
  const q = root.querySelector("#cu-q");
  q?.addEventListener("input", () => {
    query = q.value.trim().toLowerCase();
    const pos = q.selectionStart;
    rerender(view);
    const again = root.querySelector("#cu-q");
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  root.querySelectorAll(".cu-decision").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const id = sel.closest("tr").dataset.id;
      const r = view.results.find((x) => x.id === id);
      const verdict = sel.value;
      const decision = verdict ? { verdict, ...(r.action === "mixed" && verdict === "exception" ? { action: "block" } : {}) } : null;
      try {
        const next = await api.put(endpoints.decisions, { decisions: { [id]: decision } });
        rerender({ ...view, ...next });
      } catch (err) {
        toast("Couldn't save the decision.", OUTCOME_TOAST.failed, 8000, err.message);
      }
    }),
  );
  root.querySelector("#create-lists")?.addEventListener("click", async () => {
    try {
      const plan = await api.post(endpoints.lists, { ...endpoints.listBody, dryRun: true });
      if (plan.problems?.length) {
        toast(plan.problems.join(" "), "warn", 10000);
        return;
      }
      const ok = window.confirm(`Dry run passed. Create ${plan.lists.length} site ${plan.lists.length === 1 ? "list" : "lists"} (${plan.lists.map((l) => `${l.name}: ${l.sites.length}`).join(", ")})? Each is read back and recorded in the audit log, and Undo deletes them.${plan.notes?.length ? `\n\n${plan.notes.join("\n")}` : ""}`);
      if (!ok) return;
      const rec = await api.post(endpoints.lists, { ...endpoints.listBody, dryRun: false });
      const o = listsOutcome(rec, plan.lists.length);
      toast(o.text, OUTCOME_TOAST[o.state], o.state === "confirmed" ? 8000 : 10000, o.reason);
      rerender({ ...view, lastLists: rec });
    } catch (err) {
      toast("Couldn't create the site lists.", OUTCOME_TOAST.failed, 10000, err.message);
    }
  });
  root.querySelector("#undo-lists")?.addEventListener("click", async () => {
    const asked = (view.lastLists?.lists ?? []).some((l) => l.status === "unconfirmed" && !l.id);
    if (!window.confirm(`Delete the site lists the last create made? Lists a profile uses are left.${asked ? " A list Sophos didn't confirm was made is looked for by name first." : ""}`)) return;
    try {
      const rec = await api.post(endpoints.lists, { ...endpoints.listBody, undo: true });
      const o = undoOutcome(rec);
      toast(o.text, OUTCOME_TOAST[o.state], o.state === "confirmed" ? 8000 : 10000, o.reason);
      rerender({ ...view, lastLists: rec });
    } catch (err) {
      toast("Couldn't undo the site lists.", OUTCOME_TOAST.failed, 10000, err.message);
    }
  });
}
