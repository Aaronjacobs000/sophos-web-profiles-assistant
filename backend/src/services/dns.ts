/**
 * DNS checks for the clean-up step. Only NXDOMAIN counts against an entry
 * (the name doesn't exist); a timeout or a server failure says nothing about
 * the site. Internal names (.local, .corp, single labels) and IP entries are
 * skipped: from the computer running the tool they may not resolve at all.
 */

import { promises as dns } from "node:dns";
import type { ParsedSite } from "../domain/sites.js";
import type { DnsResult } from "../domain/cleanup.js";

const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });

export function dnsCheckable(site: ParsedSite): boolean {
  if (!["domain", "wildcard", "url"].includes(site.kind) || !site.host) return false;
  if (/^\d+(\.\d+){3}$/.test(site.host) || site.host.includes(":")) return false;
  if (!site.host.includes(".")) return false;
  return !/\.(local|localhost|localdomain|internal|lan|corp|home|intranet)$/i.test(site.host);
}

async function anyRecord(host: string): Promise<"yes" | "nxdomain" | "nodata"> {
  const tries: Array<() => Promise<unknown[]>> = [() => resolver.resolve4(host), () => resolver.resolve6(host), () => resolver.resolveCname(host)];
  let nodata = false;
  for (const t of tries) {
    try {
      const r = await t();
      if (r.length) return "yes";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND") return "nxdomain";
      if (code === "ENODATA") nodata = true;
      else if (code !== "ENODATA") throw err;
    }
  }
  return nodata ? "nodata" : "nxdomain";
}

export async function checkDns(site: ParsedSite): Promise<DnsResult> {
  if (!dnsCheckable(site)) return { status: "skipped", detail: "Not a public host name." };
  try {
    const r = await anyRecord(site.host);
    // A name with no address of its own can still have subdomains, and a site list entry matches those.
    if (r === "nxdomain") return { status: "nxdomain" };
    return { status: "resolves", detail: r === "nodata" ? "Exists, no address of its own." : undefined };
  } catch (err) {
    return { status: "error", detail: (err as NodeJS.ErrnoException).code ?? String(err) };
  }
}
