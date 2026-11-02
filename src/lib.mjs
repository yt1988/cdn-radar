// Pure logic shared by the page, the Worker and the tests: distances, what a result means, and results in links.

import { IDS, BY } from "./cdns.mjs";

// Great-circle distance in km
export function km(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The fastest a round trip over that distance can be: light in fiber covers about 200 km per ms, there and back
export const floorMs = d => d / 100;

// How far a location is, in tiers: near (same metro or region), mid, far, and another continent
export const TIERS = [[500, "t1", "near"], [1500, "t2", "region"], [4000, "t3", "far"], [Infinity, "t5", "away"]];
export const tierOf = d => TIERS.find(([max]) => d < max);

// A round trip that takes much longer than the distance needs went a long way round (or waited in a queue): more
// than twice the floor plus 40 ms, as the floor is a straight line and real routes are 1.5-2 times longer
export const detoured = (ms, d) => ms > floorMs(d) * 2 + 40;

// The nearest location of a CDN whose list is known, to a point: [code, place, km], or null
export function nearest(map, lat, lon, skip) {
  let best = null;
  for (const [code, p] of Object.entries(map || {})) {
    if (code === skip) continue;
    const d = km(lat, lon, p[2], p[3]);
    if (!best || d < best[2]) best = [code, p, d];
  }
  return best;
}

// A location answered that is much farther than the CDN's nearest one: not chosen by distance (a cheaper route, the
// site's plan, or the network's peering). 1000 km and twice the distance, so that a neighboring city doesn't count.
export const missedNearest = (d, near) => !!near && d - near[2] > 1000 && d > near[2] * 2;

export const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };

/* ---------- exits: which route each CDN's request took ---------- */
// A rule-based proxy picks the route per destination, so one test can reach some CDNs from the visitor's own line
// (direct, D) and others through a proxy (P). Through a proxy the CDN picks its location by the proxy's address, and
// the round trip includes the way to the proxy. The page finds the exits (as 1ms.dog's EgressLens does, at length),
// works out which one each row took, and measures each row's distance from its own exit.

// networks of hosting companies and VPNs: an exit on one is a proxy (EgressLens's list)
export const DC_RE = /amazon|google|microsoft|azure|digitalocean|vultr|choopa|constant company|linode|akamai|ovh|hetzner|oracle|alibaba|aliyun|tencent|huawei|m247|datacamp|cloudflare|leaseweb|contabo|hostinger|it7|racknerd|colocrossing|psychz|zenlayer|g-core|gcore|hostwinds|scaleway|ionos|kamatera|upcloud|bandwagon|dmit|cogent|quadranet|servers\.com|packet|equinix|fastly|cdn77|datapacket|tzulo|hostdare|greencloud|nexeon|frantech|buyvm|hosting|vps|data ?cent|mullvad|proton|nord|express ?vpn|surfshark|private internet|ucloud|kingsoft|baidu cloud|bytedance|volcano/i;
const isV6 = ip => String(ip).includes(":");
const v6g = a => {
  const [h, tl = ""] = a.toLowerCase().split("::"), H = h ? h.split(":") : [], T = tl ? tl.split(":") : [];
  return [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T].map(g => g.padStart(4, "0"));
};
// carrier-grade NAT pools and temporary IPv6 addresses move around inside a /16 or /64: the same network
const netOf = ip => isV6(ip) ? v6g(ip).slice(0, 4).join(":") : ip.split(".").slice(0, 2).join(".");
export const sameNet = (a, b) => isV6(a) === isV6(b) && netOf(a) === netOf(b);
const geoOf = (geo, ip) => geo[ip] || geo[Object.keys(geo).find(x => sameNet(x, ip))] || null;

// seen: [{ ip, src }] (src: "cn" the mainland probe, "self" this site's view, or the id of the CDN whose trace saw it);
// geo: ip → { cc, city, lat, lon, asn, org, edge, edgeCn } (edge: [lat, lon, city, cc] of the Cloudflare location the
// address reached, when known; edgeCn: the same on the China Network, which always answers from mainland China, so it
// only places a direct exit that has no place of its own).
// → [{ letter, kind: "D" | "P", ips, srcs, cc, city, lat, lon, asn, org, edge }], direct first,
// numbered (D1, D2…) only when there is more than one of a kind. One exit per network (its ASN when known). An exit on
// a hosting company's network is a proxy; when none is but there are several, the one the mainland probe took is
// direct and the others are proxies.
// A proxy's address is often placed wrong by IP geolocation (a VPS registered in the US, running in Tokyo). The
// Cloudflare location it reaches says where it is, since anycast takes a data center's traffic to its nearest edge,
// so that replaces it when the two are 1500 km apart or more (edge: true). Never for a direct exit: from many
// networks (mainland China's) Cloudflare answers from far away.
export function groupExits(seen, geo) {
  const E = [];
  for (const { ip, src } of seen) {
    if (!ip) continue;
    const g = geoOf(geo, ip), key = g && g.asn ? "as" + g.asn : "net" + netOf(ip);
    let e = E.find(x => x.key === key);
    if (!e) E.push(e = { key, ips: [], srcs: [], cc: "", city: "", lat: null, lon: null, asn: null, org: "", edge: false, at: null, atCn: null });
    if (!e.ips.includes(ip)) e.ips.push(ip);
    if (!e.srcs.includes(src)) e.srcs.push(src);
    if (!g) continue;
    for (const k of ["cc", "city", "asn", "org"]) e[k] = e[k] || g[k] || e[k];
    if (e.lat == null && g.lat != null) { e.lat = g.lat; e.lon = g.lon; }
    e.at = e.at || g.edge || null;
    e.atCn = e.atCn || g.edgeCn || null;
  }
  const dc = e => !!e.org && DC_RE.test(e.org), anyDc = E.some(dc), cnSeen = E.some(e => e.srcs.includes("cn"));
  for (const e of E) e.kind = anyDc ? (dc(e) ? "P" : "D") : E.length > 1 && cnSeen && !e.srcs.includes("cn") ? "P" : "D";
  for (const e of E) {
    const at = e.kind === "P" ? e.at && (e.lat == null || km(e.lat, e.lon, e.at[0], e.at[1]) >= 1500) && e.at : e.lat == null && e.atCn;
    if (at) Object.assign(e, { lat: at[0], lon: at[1], city: at[2] || "", cc: at[3] || e.cc, edge: true });
    delete e.at; delete e.atCn;
  }
  E.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || b.srcs.length - a.srcs.length);
  for (const k of ["D", "P"]) { const of = E.filter(e => e.kind === k); of.forEach((e, i) => { e.letter = of.length > 1 ? k + (i + 1) : k; }); }
  return E;
}
export const exitOfIp = (exits, ip) => ip ? exits.find(e => e.ips.includes(ip)) || exits.find(e => e.ips.some(i => sameNet(i, ip))) || null : null;

// The exits the CDNs' requests can have taken: the direct ones, and the proxies a CDN's trace was seen using. A proxy
// only this site's own request took says nothing about the CDNs: rules that send the test hosts direct usually leave
// this site on the proxy (it is slow direct from some networks). When no CDN's trace answered, all of them.
const viaCdn = e => e.srcs.some(s => s !== "self" && s !== "cn");
export const cdnExits = exits => exits.some(viaCdn) ? exits.filter(e => e.kind === "D" || viaCdn(e)) : exits;

// Which exit each row's request took (exits: cdnExits()). rows: [{ id, ip?, place?, ms }] (ip: the address its trace saw; place: [city,
// cc, lat, lon] of its location); exits: groupExits(); cnVia: the letter of the mainland probe's exit.
// → id → { x: letter, how } or { x: null } when it can't be told. how, most certain first:
//   one   there is only one exit
//   ip    the CDN's own answer names the address
//   pop   its location is far nearer one exit than any other (a CDN places a request by the address it comes from):
//         at most half the distance, and 1000 km nearer
//   ms    the round trip is under FAST and shorter than any proxy found allows (light in fiber to it, or 60% of the fastest answer
//         through it from a location near it): direct
//   rule  inferred: its domain is on the mainland list that proxy rules send direct (cdns.mjs, cn), and the mainland
//         probe went direct
export function routes(rows, exits, cnVia) {
  const out = {};
  if (!exits.length) return out;
  const at = exits.filter(e => e.lat != null), Ds = exits.filter(e => e.kind === "D"), Ps = exits.filter(e => e.kind === "P");
  const dist = (e, p) => km(e.lat, e.lon, p[2], p[3]);
  for (const r of rows) {
    if (exits.length === 1) { out[r.id] = { x: exits[0].letter, how: "one" }; continue; }
    const e = exitOfIp(exits, r.ip);
    if (e) { out[r.id] = { x: e.letter, how: "ip" }; continue; }
    if (r.place && at.length > 1) {
      const ds = at.map(x => [x, dist(x, r.place)]).sort((a, b) => a[1] - b[1]);
      if (ds[1][1] >= ds[0][1] * 2 && ds[1][1] - ds[0][1] >= 1000) { out[r.id] = { x: ds[0][0].letter, how: "pop" }; continue; }
    }
    out[r.id] = { x: null };
  }
  // the fastest answer each proxy carried from a location within 1000 km of it: about the way to the proxy
  const hop = {};
  for (const r of rows) {
    const o = out[r.id], e = o.x && exits.find(x => x.letter === o.x);
    if (e && e.kind === "P" && r.ms != null && (o.how === "ip" || o.how === "pop") && r.place && e.lat != null && dist(e, r.place) < 1000)
      hop[e.letter] = Math.min(hop[e.letter] ?? Infinity, r.ms);
  }
  const D0 = Ds.length === 1 ? Ds[0] : null, cnE = cnVia && exits.find(e => e.letter === cnVia);
  for (const r of rows) {
    if (out[r.id].x || r.ms == null) continue;
    const least = p => Math.max(D0.lat != null && p.lat != null ? floorMs(km(D0.lat, D0.lon, p.lat, p.lon)) : 0, hop[p.letter] != null ? hop[p.letter] * .6 : 0);
    // and under FAST: a proxy the probes never saw (one rule's proxy among several) can be nearer than the ones found
    if (D0 && Ps.length && r.ms < FAST && Ps.every(p => r.ms < least(p))) out[r.id] = { x: D0.letter, how: "ms" };
    else if (BY[r.id] && BY[r.id].cn && cnE && cnE.kind === "D" && Ps.length) out[r.id] = { x: cnE.letter, how: "rule" };
  }
  return out;
}

// A location that serves the visitor badly: 1500 km or more away, or a round trip far beyond what its distance needs.
// dp: the whole way, when the row went through a proxy: to the proxy, then on to the location (d)
export const isFar = r => r.d >= 1500 || detoured(r.ms, r.dp ?? r.d);
export const FAST = 30;   // ms: a round trip this short is a nearby edge, whatever the distance says

// What the results say together: rows = [{ id, code, place, ms, d, near, unsure }] (d: km from the row's exit when its
// location is known; near: the CDN's nearest location to it, when its list is known; unsure: there are several exits
// and which one this row took can't be told, so its distance isn't counted). →
//   key       the headline: v_good (three in four located ones nearby), v_mixed, v_far, v_noloc, v_none
//   near/far  how many located ones are nearby / far; located: how many say where they are; med: the median round trip
//   farthest  the located row farthest away
//   findings  what to tell, most important first, at most four: [{ kind: "bad" | "warn" | "ok", key, ids?, row?, n? }]
//             f_fail      these didn't answer
//             f_far       this one serves from far away (row.near set when it isn't its nearest location)
//             f_slowpath  this one is near, but the round trip is much longer than the distance needs
//             f_more      n more serve from far away
//             f_fast      these answer within FAST ms
export function summary(rows) {
  const ok = rows.filter(r => r.ms != null), failed = rows.filter(r => r.ms == null);
  const findings = [];
  if (failed.length) findings.push({ kind: "bad", key: "f_fail", ids: failed.map(r => r.id) });
  if (!ok.length) return { key: "v_none", near: 0, far: 0, located: 0, med: null, farthest: null, findings };
  const located = ok.filter(r => r.d != null && !r.unsure);
  const far = located.filter(isFar).sort((a, b) => b.d - a.d), near = located.filter(r => !isFar(r));
  for (const r of far.slice(0, 2)) findings.push({ kind: "warn", key: r.d >= 1500 ? "f_far" : "f_slowpath", row: r });
  if (far.length > 2) findings.push({ kind: "warn", key: "f_more", n: far.length - 2 });
  const fast = ok.filter(r => r.ms < FAST).sort((a, b) => a.ms - b.ms);
  if (fast.length) findings.push({ kind: "ok", key: "f_fast", ids: fast.map(r => r.id) });
  const share = located.length ? near.length / located.length : 0;
  const key = !located.length ? "v_noloc" : share >= .75 ? "v_good" : share <= .34 ? "v_far" : "v_mixed";
  const farthest = [...located].sort((a, b) => b.d - a.d)[0] || null;
  return { key, near: near.length, far: far.length, located: located.length, med: median(ok.map(r => r.ms)), farthest, findings: findings.slice(0, 4) };
}

/* ---------- a result in a link: /r/<code>, or /<lang folder>/r/<code> ---------- */
// The Worker reads it to put the locations in the link's preview title; the page reads it to draw the result. It never
// holds an address. The visitor's city (and where it is, to 0.1°, for the distances) and network only when they tick
// the box: without them the link has the locations and round trips but no distances, which would place the visitor.
//
// Format 1:  1~<time, base 36 seconds>~<where>~<network>~<rows>~<site>
//   where:   <cc>.<lat>.<lon>.<city>  lat/lon in tenths of a degree from -90/-180, base 36; city base64url (UTF-8);
//            "-" when not shown
//   network: base64url of the network's name, or "-"
//   rows:    <id>.<code>.<ms>  joined by "_"; ms in tenths, base 36, empty when it didn't answer; code empty when the
//            CDN didn't say
//   site:    <cdn or ->.<code>.<ms>.<host>  the site check, or "-"
//   exits:   (optional) <letter>.<lat>.<lon> joined by "_": where each exit is, for the distances of the rows that
//            took it; only with the visitor's place, absent otherwise
// A row may end in .<route>: the exit it took and how that was told, "P" + "i" (routes(): o one, i ip, p pop, m ms,
// r rule). Links from before routes have neither; their readers skip both.
// Ids the reader doesn't know are skipped, so links keep working when CDNs are added. A later format gets a new
// first number; old links keep theirs.
export const FORMAT = 1;
const n36 = v => v == null ? "" : Math.max(0, Math.round(v * 10)).toString(36);
const p36 = s => !s ? null : /^[0-9a-z]+$/.test(s) ? parseInt(s, 36) / 10 : NaN;
const b64u = s => { const b = new TextEncoder().encode(s); let x = ""; for (const c of b) x += String.fromCharCode(c); return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = s => { try { const x = atob(s.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(x, c => c.charCodeAt(0))); } catch (e) { return null; } };
const CODE = /^[A-Z0-9-]{1,40}$/, HOST = /^[a-z0-9.-]{1,253}$/;

const HOW = { one: "o", ip: "i", pop: "p", ms: "m", rule: "r" }, HOW_OF = Object.fromEntries(Object.entries(HOW).map(([k, v]) => [v, k]));
const LETTER = /^[DP]\d?$/;
const ll36 = (lat, lon) => [Math.round((lat + 90) * 10).toString(36), Math.round((lon + 180) * 10).toString(36)];

// { ts, where: { cc, lat, lon, city } | null, isp, rows: [{ id, code, ms, route? }], site: { cdn, code, ms, host } | null,
//   exits?: [{ letter, lat, lon }] } → code (route: { x, how } from routes())
export function encode({ ts, where, isp, rows, site, exits }) {
  const w = where && /^[A-Z]{2}$/.test(where.cc || "") && where.lat != null ? [where.cc, ...ll36(where.lat, where.lon), b64u(where.city || "")].join(".") : "-";
  const rt = x => x.route && LETTER.test(x.route.x || "") && HOW[x.route.how] ? [x.route.x + HOW[x.route.how]] : [];
  const r = rows.map(x => [x.id, x.code || "", n36(x.ms), ...rt(x)].join(".")).join("_");
  const s = site && HOST.test(site.host) ? [site.cdn && /^[\w ]+$/.test(site.cdn) ? b64u(site.cdn) : "-", site.code || "", n36(site.ms), site.host].join(".") : "-";
  const ex = w !== "-" && exits ? exits.filter(e => LETTER.test(e.letter) && e.lat != null).map(e => [e.letter, ...ll36(e.lat, e.lon)].join(".")).join("_") : "";
  return [FORMAT, Math.round(ts / 1000).toString(36), w, isp ? b64u(isp) : "-", r || "-", s, ...(ex ? [ex] : [])].join("~");
}

// code → { ts, where, isp, rows, site }, or null when it isn't a result this page can read
export function decode(code) {
  if (typeof code !== "string" || code.length > 3000) return null;
  const [v, ts, w, isp, r, s, ex] = code.split("~");
  if (v !== "1" || !/^[0-9a-z]+$/.test(ts || "") || r == null || s == null) return null;
  let where = null;
  if (w && w !== "-") {
    const [cc, la, lo, city] = w.split(".");
    if (!/^[A-Z]{2}$/.test(cc) || !/^[0-9a-z]+$/.test(la) || !/^[0-9a-z]+$/.test(lo)) return null;
    where = { cc, lat: parseInt(la, 36) / 10 - 90, lon: parseInt(lo, 36) / 10 - 180, city: city ? unb64u(city) || "" : "" };
  }
  const rows = [], seen = new Set();
  for (const part of r === "-" ? [] : r.split("_")) {
    const [id, c, ms, rt] = part.split(".");
    if (!BY[id] || seen.has(id)) continue;
    const x = { id, code: c && CODE.test(c) ? c : null, ms: p36(ms) };
    if (Number.isNaN(x.ms)) return null;
    const m = /^([DP]\d?)([a-z])$/.exec(rt || "");
    if (m && HOW_OF[m[2]]) x.route = { x: m[1], how: HOW_OF[m[2]] };
    seen.add(id); rows.push(x);
  }
  let site = null;
  if (s !== "-") {
    const [cdn, c, ms, ...h] = s.split("."), host = h.join(".");
    if (!HOST.test(host)) return null;
    site = { cdn: cdn && cdn !== "-" ? unb64u(cdn) : null, code: c && CODE.test(c) ? c : null, ms: p36(ms), host };
    if (Number.isNaN(site.ms)) return null;
  }
  if (!rows.length && !site) return null;
  // the exits' places come with the visitor's only
  const exits = [];
  if (where && ex) for (const part of ex.split("_")) {
    const [letter, la, lo] = part.split(".");
    if (LETTER.test(letter) && /^[0-9a-z]+$/.test(la || "") && /^[0-9a-z]+$/.test(lo || "")) exits.push({ letter, lat: parseInt(la, 36) / 10 - 90, lon: parseInt(lo, 36) / 10 - 180 });
  }
  return { ts: parseInt(ts, 36) * 1000, where, isp: isp && isp !== "-" ? unb64u(isp) || "" : "", rows, site, exits };
}

// /r/<code> or /<lang folder>/r/<code> → { slug, code }, or null
export function sharePath(pathname) {
  const m = /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?r\/([0-9A-Za-z~._-]+)\/?$/.exec(pathname);
  return m ? { slug: m[1] || "", code: m[2] } : null;
}

// A host name from what someone typed: a URL, a name with a path, upper case… → "www.example.com", or null
export function hostOf(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
  try {
    const h = new URL(s).hostname.replace(/\.$/, "");
    return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(h) ? h : null;
  } catch (e) { return null; }
}

export const KNOWN = IDS;
