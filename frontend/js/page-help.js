// Help: what the tool checks, what it reads and writes, and what each step does.

import { initShell } from "./shell.js";

const CHECKS = [
  ["Devices that can use profiles: Windows with Sophos Endpoint 2026.1 or later (coreAgent version). macOS and older Windows keep classic settings", "Requirements", "Fix when none qualify; plan when some don't"],
  ["HTTPS decryption in every Threat Protection policy", "Requirements", "Fix when off everywhere; plan when off in some"],
  ["Block QUIC in every Threat Protection policy", "Requirements", "Plan"],
  ["Decryption exclusions: categories and websites not decrypted", "Decryption", "Check by hand"],
  ["Website exclusions from threat checks, which Web Control skips", "Pilot", "Plan"],
  ["Log web control events in every active Web Control policy", "Pilot", "Plan"],
  ["Policies that are disabled, assigned to no one, duplicated, or shadowed by a policy above", "Inventory", "Plan"],
  ["Assignments to empty groups, and to deleted users, groups or devices. Sophos drops a deleted user or group from assignments itself, so those policies show as assigned to no one", "Inventory", "Plan"],
  ["Policies that use a web filtering profile that doesn't exist", "Pilot", "Fix"],
  ["Schedules, which run on the endpoint's local time", "Inventory", "Check by hand"],
  ["Additional security options and Protect against data loss, which profiles don't have by name", "Classic settings", "Plan"],
  ["Website Management: entries, tags, unused tags, untagged entries, duplicates, entries a site list won't take (such as *.example.com), tags over 750 entries, and more entries than 20 site lists of 750 can hold", "Website Management", "Plan"],
  ["Broad Allow entries: whole top-level domains, wide IP ranges, shared hosting platforms", "Website Management", "Plan"],
  ["Profiles in use against the limit of 20, site lists against the 20 an account can have, profiles with no owner, profiles near 20 site lists", "Profiles", "Plan when close"],
  ["Admin role includes Manage web profiles; User or Device policy type", "Requirements", "Check by hand"],
];

async function start() {
  await initShell();
  document.getElementById("main").innerHTML = `
    <section class="page-head"><div><span class="eyebrow">Help</span><h1>How the Web Profiles Assistant works</h1>
      <p class="page-lead">It takes a tenant from classic Web Control to web filtering profiles: what to fix before a pilot, which legacy entries to keep, which profiles to build, the build, the pilot, promotion in waves, and retiring the old tags. Every write has a dry run and a way back.</p></div></section>
    <div class="prose">
      <div class="banner banner-warn">Unofficial tool, not from Sophos and not supported by Sophos. Confirm every setting in Sophos Fusion before you change it.</div>

      <h2>What you get</h2>
      <ul>
        <li><strong>Readiness scorecard</strong> for a tenant: what to fix before a pilot, what to plan around, what to check by hand, and what already passes. Each item carries a topic label.</li>
        <li><strong>Partner estate view</strong> with a partner or organization credential: the same scorecard for every tenant, a few at a time, with a link into each one.</li>
        <li><strong>Customer report</strong> as HTML or PDF, ready to send.</li>
        <li><strong>Rollback snapshot</strong> on every check: a JSON file with every Web Control policy, the web settings of every Threat Protection policy, every Website Management entry, the decryption and scanning exclusions, and every profile and site list, as read. Later steps restore from it.</li>
        <li><strong>Clean up, Design and Build</strong>: legacy entries sorted into Covered, Exception or Remove, profiles mapped from classic policies, and a pilot policy built at the top of the order.</li>
        <li><strong>Pilot digest</strong>: warned and blocked hits from the SIEM API, collected onto this computer because the API keeps about 24 hours, with a narrow Allow for a host in one click.</li>
        <li><strong>Promote and retire</strong>: devices that can use profiles moved onto the pilot in waves, then Website Management tags retired, with a restore.</li>
      </ul>

      <h2>How to read the scorecard</h2>
      <table><thead><tr><th>Group</th><th>Means</th></tr></thead><tbody>
        <tr><td>Fix before the pilot</td><td>A pilot won't work, or the tool couldn't read something it needs.</td></tr>
        <tr><td>Plan around</td><td>Work to do before or during the conversion. Doesn't block a pilot.</td></tr>
        <tr><td>Check by hand</td><td>The API can't answer it, or it's context worth a look.</td></tr>
        <tr><td>Passing</td><td>Checked and fine.</td></tr>
      </tbody></table>

      <h2>What it checks</h2>
      <table><thead><tr><th>Check</th><th>Topic</th><th>Result</th></tr></thead><tbody>
        ${CHECKS.map(([c, g, r]) => `<tr><td>${c}</td><td>${g}</td><td>${r}</td></tr>`).join("")}
      </tbody></table>

      <h2>What it reads and writes</h2>
      <p><strong>Reads</strong> (GET only): devices, Web Control and Threat Protection policies (computer and server), Website Management, the classic category list, SSL/TLS decryption settings, scanning exclusions, device groups, user groups, the users a policy names, and web filtering profiles and site lists. A check is usually 13 to 40 calls. The client refuses any write, so nothing in a tenant can change.</p>
      <p><strong>Writes</strong> to the tenant only when you confirm one: the build and its rollback, one-click site lists, a narrow Allow, a promotion wave, turning the pilot on or off, and retiring or restoring tags. Each is previewed first, sent once, read back, and recorded in <code>data/audit.log</code>. On this computer: <code>.env</code> (the credentials) and the <code>data/</code> folder (snapshots, results, clean-up runs, design choices, build records, SIEM events, and the pilot, promotion and retire records).</p>

      <h2>Steps and what they write</h2>
      <table><thead><tr><th>Step</th><th>What it does</th><th>Writes to the tenant</th></tr></thead><tbody>
        <tr><td>1. Readiness</td><td>Scorecard, estate view, report, snapshot</td><td>Nothing</td></tr>
        <tr><td>2 to 4. Clean up, Design, Build</td><td>SophosLabs check and DNS, profiles from classic policies, the build with a dry run; also the Site list cleaner</td><td>Site lists, a profile, a pilot policy at the top of the order, with rollback</td></tr>
        <tr><td>5. Pilot</td><td>Daily SIEM collection, digest of warned and blocked hits, narrow Allow</td><td>One site in a pilot Allow list (the first creates the list and links it to the pilot's profile); undo removes it</td></tr>
        <tr><td>6. Promote and retire</td><td>Waves of eligible devices onto the pilot, then retiring Website Management tags</td><td>The pilot's assignment, one wave at a time; tags taken out of policies and entries deleted or untagged; undo and restore put them back</td></tr>
      </tbody></table>
    </div>`;
}

start();
