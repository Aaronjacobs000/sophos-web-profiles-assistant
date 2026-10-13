/**
 * Website Management entries as site list entries.
 *
 * parseSite() reads one entry the way a site list will need it. What the live
 * site list API took and refused on 13/10/2026 (a test tenant):
 *   accepted  example.com (domain), www.example.com/path and example.com:8443
 *             (urlPattern), http://www.example.com/news (url), .com and .co.uk
 *             (tld), IPv4 and IPv6 addresses and CIDR ranges; upper case is
 *             stored lower case
 *   refused   *.example.com ("Site type could not be determined")
 * example.com and *.example.com both match every domain ending in
 * example.com. The tool follows the API for what a list accepts, so
 * *.example.com becomes example.com, and flags a scheme (http:// or https://)
 * because a site entry doesn't need one.
 *
 * broadness() says whether an Allow entry reaches far more than one business
 * system: site lists win over categories,
 * so a broad Allow bypasses category protection.
 *
 * Pure: no Node or browser imports. The drop 2 clean-up step and the
 * standalone site list cleaner build on this module.
 */

export type SiteKind = "domain" | "wildcard" | "url" | "tld" | "ipv4" | "ipv6" | "cidr4" | "cidr6" | "invalid";

export type SiteIssue =
  /** http:// or https:// in front; a site entry doesn't need it. */
  | "scheme"
  /** *.example.com; the site list API refuses it, and example.com matches the same sites. */
  | "wildcard"
  | "whitespace"
  | "uppercase"
  | "trailing-dot"
  | "trailing-slash"
  | "empty"
  | "bad-characters"
  | "no-dot";

export interface ParsedSite {
  raw: string;
  /** The entry as a site list should hold it; empty when it can't go into one. */
  value: string;
  kind: SiteKind;
  /** The host part, lower case, without a leading "*." or "." */
  host: string;
  issues: SiteIssue[];
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function isIpv6(text: string): boolean {
  if (!text.includes(":")) return false;
  if (!/^[0-9a-f:.]+$/i.test(text)) return false;
  const doubles = text.split("::").length - 1;
  if (doubles > 1) return false;
  const groups = text.split(":").filter((g) => g !== "");
  return groups.length <= 8 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g) || IPV4.test(g));
}

/** Valid labels, and a last label that isn't all digits (999.1.1.1 is no host name). */
function isHostName(host: string): boolean {
  const labels = host.split(".");
  return (
    host.length <= 253 &&
    labels.every((l) => LABEL.test(l)) &&
    !/^\d+$/.test(labels[labels.length - 1] ?? "")
  );
}

export function parseSite(raw: string): ParsedSite {
  const issues: SiteIssue[] = [];
  let text = raw;
  if (text !== text.trim() || /\s/.test(text.trim())) issues.push("whitespace");
  text = text.trim().replace(/\s+/g, "");
  if (!text) return { raw, value: "", kind: "invalid", host: "", issues: ["empty"] };
  if (text !== text.toLowerCase()) issues.push("uppercase");
  text = text.toLowerCase();

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(text);
  if (scheme) {
    issues.push("scheme");
    text = text.slice(scheme[0].length);
  }

  // CIDR before anything that splits on "/".
  const cidr = /^([^/]+)\/(\d{1,3})$/.exec(text);
  if (cidr) {
    const [, addr = "", bits = ""] = cidr;
    const prefix = Number(bits);
    if (IPV4.test(addr) && prefix <= 32) return { raw, value: `${addr}/${prefix}`, kind: "cidr4", host: addr, issues };
    if (isIpv6(addr) && prefix <= 128) return { raw, value: `${addr}/${prefix}`, kind: "cidr6", host: addr, issues };
  }

  const slash = text.indexOf("/");
  let hostPart = slash >= 0 ? text.slice(0, slash) : text;
  let path = slash >= 0 ? text.slice(slash) : "";
  if (path === "/") {
    issues.push("trailing-slash");
    path = "";
  }

  // A port stays: the API takes example.com:8443 as a URL pattern. Bare IPv6 colons aren't a port.
  let port = "";
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPart);
  if (bracketed) {
    hostPart = bracketed[1]!;
    if (bracketed[2]) port = `:${bracketed[2]}`;
  } else if (!isIpv6(hostPart)) {
    const m = /^(.*):(\d+)$/.exec(hostPart);
    if (m) {
      hostPart = m[1]!;
      port = `:${m[2]}`;
    }
  }

  if (hostPart.endsWith(".") && hostPart !== ".") {
    issues.push("trailing-dot");
    hostPart = hostPart.replace(/\.+$/, "");
  }

  const rest = port + path;
  if (IPV4.test(hostPart)) return { raw, value: hostPart + rest, kind: rest ? "url" : "ipv4", host: hostPart, issues };
  if (isIpv6(hostPart)) {
    const shown = port ? `[${hostPart}]` : hostPart;
    return { raw, value: shown + rest, kind: rest ? "url" : "ipv6", host: hostPart, issues };
  }

  // Everything: "*" or "*.*". Nothing a site list can hold.
  if (hostPart === "*" || hostPart === "*.*") {
    return { raw, value: "", kind: "wildcard", host: "", issues: [...issues, "wildcard"] };
  }

  // A top-level domain or public suffix written with a leading dot: .com, .co.uk.
  if (hostPart.startsWith(".") && !rest) {
    const tld = hostPart.slice(1);
    if (isHostName(tld)) return { raw, value: `.${tld}`, kind: "tld", host: tld, issues };
    return { raw, value: "", kind: "invalid", host: tld, issues: [...issues, "bad-characters"] };
  }

  const wildcard = hostPart.startsWith("*.");
  const host = wildcard ? hostPart.slice(2) : hostPart;
  if (!isHostName(host)) return { raw, value: "", kind: "invalid", host, issues: [...issues, "bad-characters"] };
  if (wildcard) issues.push("wildcard");
  if (!host.includes(".")) issues.push("no-dot");
  if (rest) return { raw, value: host + rest, kind: "url", host, issues };
  return { raw, value: host, kind: wildcard ? "wildcard" : "domain", host, issues };
}

/** Issues that mean the entry can't go into a site list as written. */
const REWRITE: SiteIssue[] = ["scheme", "wildcard", "whitespace", "trailing-dot", "trailing-slash", "empty", "bad-characters"];

/** True when the entry needs rewriting before it goes into a site list. */
export function needsRewrite(site: ParsedSite): boolean {
  return site.kind === "invalid" || site.issues.some((i) => REWRITE.includes(i));
}

/**
 * Two-label public suffixes common in the regions Sophos sells into. A site
 * list entry equal to one of these covers every business under it.
 */
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "asn.au",
  "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz", "school.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.sg", "org.sg", "net.sg", "edu.sg", "gov.sg",
  "com.my", "org.my", "net.my", "com.ph", "com.hk", "org.hk", "com.tw", "co.kr", "co.in", "org.in", "net.in", "co.id", "co.th", "com.vn",
  "com.br", "com.mx", "com.ar", "co.za", "co.il", "com.tr", "com.cn", "com.sa", "ae.org",
]);

/**
 * Domains where anyone can publish content under their own subdomain or path.
 * Allowing one of these allows every site hosted there, not one vendor.
 */
const SHARED_PLATFORMS = new Set([
  "amazonaws.com", "s3.amazonaws.com", "cloudfront.net", "awsapps.com",
  "azurewebsites.net", "blob.core.windows.net", "web.core.windows.net", "azureedge.net", "azurefd.net", "cloudapp.net", "cloudapp.azure.com", "trafficmanager.net", "windows.net",
  "appspot.com", "googleusercontent.com", "googleapis.com", "storage.googleapis.com", "firebaseapp.com", "web.app", "run.app", "sites.google.com",
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io",
  "herokuapp.com", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "r2.dev", "onrender.com", "fly.dev", "glitch.me", "repl.co", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
  "wordpress.com", "blogspot.com", "wixsite.com", "weebly.com", "squarespace.com", "webflow.io", "notion.site",
  "sharepoint.com", "dropboxusercontent.com", "dl.dropboxusercontent.com",
]);

export type BroadReason = "everything" | "top-level-domain" | "public-suffix" | "wide-ip-range" | "shared-platform";

export interface Broadness {
  broad: boolean;
  reason?: BroadReason;
  /** One line for the scorecard. */
  why?: string;
}

/** Whether an entry covers far more than one business system. */
export function broadness(site: ParsedSite): Broadness {
  if (site.kind === "wildcard" && site.host === "") {
    return { broad: true, reason: "everything", why: "matches every site" };
  }
  if (site.kind === "invalid") return { broad: false };
  if (site.kind === "tld") {
    return PUBLIC_SUFFIXES.has(site.host)
      ? { broad: true, reason: "public-suffix", why: `matches every .${site.host} site` }
      : { broad: true, reason: "top-level-domain", why: `matches every .${site.host} site` };
  }
  if (site.kind === "cidr4") {
    const prefix = Number(site.value.split("/")[1]);
    if (prefix < 24) return { broad: true, reason: "wide-ip-range", why: `a /${prefix} range covers ${2 ** (32 - prefix)} addresses` };
    return { broad: false };
  }
  if (site.kind === "cidr6") {
    const prefix = Number(site.value.split("/")[1]);
    if (prefix < 48) return { broad: true, reason: "wide-ip-range", why: `a /${prefix} IPv6 range is wider than one site` };
    return { broad: false };
  }
  if (site.kind === "ipv4" || site.kind === "ipv6") return { broad: false };
  const host = site.host;
  if (!host.includes(".")) return { broad: true, reason: "top-level-domain", why: `matches every .${host} site` };
  if (PUBLIC_SUFFIXES.has(host)) return { broad: true, reason: "public-suffix", why: `matches every .${host} site` };
  if (site.kind !== "url") {
    for (const platform of SHARED_PLATFORMS) {
      if (host === platform) return { broad: true, reason: "shared-platform", why: `anyone can host content on ${platform}` };
    }
  }
  return { broad: false };
}
