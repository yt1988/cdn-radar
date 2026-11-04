// 1ms-cdn-ecs: once a day, where the CDNs that pick a location by DNS (Akamai, CloudFront) send the users of each big
// ISP. For every ISP in data/ecs-nets.json it asks the CDN's own name servers for the test host, walking the CNAMEs and
// delegations itself over UDP 53, with one of that ISP's /24s as the client subnet (EDNS Client Subnet, RFC 7871): the
// answer the ISP's own resolver would get. Then it asks each address it got, once, over HTTPS with the host's name,
// which location that edge is (the answer's location header, read as the page reads it). Public resolvers are no use
// here: they cache, and rewrite or drop the client subnet.
//
//   ecs/latest.json, ecs/days/<YYYY-MM-DD>.json   { t, nets: [{ asn, cc, name, net }],
//     cdns: { <cdn>: { <asn>: { ip, code, scope } | { err } } } }   scope: the subnet length the answer holds for
//                                                                  (0: the same answer for everyone)
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { BY } from "../src/cdns.mjs";
import { OUT, get, readPop, writeJSON, wait } from "./common.mjs";

const TESTS = ["akamai", "cloudfront"];
const QPS_GAP = 100;   // at most 10 queries a second, to anyone
const NETS = JSON.parse(await readFile(new URL("../data/ecs-nets.json", import.meta.url), "utf8"));

// --- a DNS message with a client subnet, and its answer -------------------------------------------------------------
function query(name, net) {
  const [ip, len] = net.split("/"), bits = +len, bytes = ip.split(".").slice(0, Math.ceil(bits / 8)).map(Number);
  const qname = Buffer.concat([...name.replace(/\.$/, "").split(".").map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const id = Math.floor(Math.random() * 65536);
  const head = Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);            // no recursion; 1 question, 1 OPT
  const q = Buffer.concat([qname, Buffer.from([0, 1, 0, 1])]);                              // A, IN
  const opt = Buffer.from([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);  // name ., type 41, 4096 bytes, rdlen later
  const ecs = Buffer.from([0, 8, 0, 4 + bytes.length, 0, 1, bits, 0, ...bytes]);            // option 8: family 1, source bits, scope 0
  opt.writeUInt16BE(41, 1); opt.writeUInt16BE(1232, 3); opt.writeUInt16BE(ecs.length, 9);
  return { id, buf: Buffer.concat([head, q, opt.subarray(0, 11), ecs]) };
}

function parse(b) {
  let o = 12;
  const name = () => {
    const labels = []; let p = o, jumped = false;
    for (let guard = 0; guard < 128; guard++) {
      const l = b[p];
      if (l === 0) { p++; break; }
      if ((l & 0xc0) === 0xc0) { if (!jumped) o = p + 2; jumped = true; p = ((l & 0x3f) << 8) | b[p + 1]; continue; }
      labels.push(b.toString("latin1", p + 1, p + 1 + l)); p += 1 + l;
    }
    if (!jumped) o = p;
    return labels.join(".").toLowerCase();
  };
  const qd = b.readUInt16BE(4), counts = [b.readUInt16BE(6), b.readUInt16BE(8), b.readUInt16BE(10)];
  for (let i = 0; i < qd; i++) { name(); o += 4; }
  const sections = counts.map(n => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const owner = name(), type = b.readUInt16BE(o), len = b.readUInt16BE(o + 8), start = o + 10;
      o = start;
      let data = null;
      if (type === 1) data = [...b.subarray(start, start + 4)].join(".");
      else if (type === 5 || type === 2) data = name();
      else if (type === 41) {   // OPT: the client subnet's scope
        for (let p = start; p + 4 <= start + len;) { const code = b.readUInt16BE(p), l = b.readUInt16BE(p + 2); if (code === 8) data = b[p + 7]; p += 4 + l; }
      }
      o = start + len;
      out.push({ owner, type, data });
    }
    return out;
  });
  return { rcode: b[3] & 15, an: sections[0], ns: sections[1], ar: sections[2] };
}

const sock = dgram.createSocket("udp4");
const waiting = new Map();
sock.on("message", m => { const id = m.readUInt16BE(0), w = waiting.get(id); if (w) { waiting.delete(id); w(m); } });
let lastSent = 0;
async function ask(server, name, net) {
  const gap = lastSent + QPS_GAP - Date.now();
  if (gap > 0) await wait(gap);
  lastSent = Date.now();
  const { id, buf } = query(name, net);
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => { waiting.delete(id); reject(new Error("timeout")); }, 3000);
    waiting.set(id, m => { clearTimeout(tm); try { resolve(parse(m)); } catch (e) { reject(e); } });
    sock.send(buf, 53, server);
  });
}

// --- walking to the answer ------------------------------------------------------------------------------------------
// a zone's name servers' addresses, from the system resolver (the delegations above the CDN's zones don't depend on
// who asks); the walk then follows the CDN's own referrals with the client subnet on every query
const zoneNS = new Map();
async function serversOf(zone) {
  if (!zoneNS.has(zone)) zoneNS.set(zone, (async () => {
    const ns = await dns.resolveNs(zone);
    return (await Promise.all(ns.slice(0, 4).map(n => dns.resolve4(n).catch(() => [])))).flat();
  })());
  return zoneNS.get(zone);
}
const zoneOf = name => name.split(".").slice(-2).join(".");

async function resolve(host, net) {
  let name = host, servers = await serversOf(zoneOf(name)), scope = null;
  for (let step = 0; step < 16; step++) {
    let r = null;
    for (const s of servers.slice(0, 3)) { try { r = await ask(s, name, net); break; } catch (e) {} }
    if (!r) throw new Error("timeout");
    const opt = r.ar.find(x => x.type === 41);
    if (opt && opt.data != null) scope = opt.data;
    // follow the CNAMEs the answer holds; an address for the last name is the answer
    let cur = name;
    for (let k = 0; k < 8; k++) { const c = r.an.find(x => x.type === 5 && x.owner === cur); if (!c) break; cur = c.data; }
    const a = r.an.find(x => x.type === 1 && x.owner === cur);
    if (a) return { ip: a.data, scope };
    if (cur !== name) { name = cur; servers = await serversOf(zoneOf(name)); continue; }
    // a referral: the next servers, by their glue or looked up
    const ns = r.ns.filter(x => x.type === 2).map(x => x.data);
    if (!ns.length || r.rcode) throw new Error(r.rcode === 3 ? "nxdomain" : "noanswer");
    const glue = r.ar.filter(x => x.type === 1 && ns.includes(x.owner)).map(x => x.data);
    servers = glue.length ? glue : (await Promise.all(ns.slice(0, 3).map(n => dns.resolve4(n).catch(() => [])))).flat();
  }
  throw new Error("loop");
}

// --- the run --------------------------------------------------------------------------------------------------------
const now = new Date(), out = { t: now.toISOString().slice(0, 16) + "Z", nets: NETS, cdns: {} };
const where = new Map();   // edge address → its location, asked once
for (const id of TESTS) {
  const cdn = BY[id], host = new URL(cdn.url).hostname, res = out.cdns[id] = {};
  for (const n of NETS) {
    try {
      const { ip, scope } = await resolve(host, n.net);
      if (!where.has(ip)) where.set(ip, get(cdn.url, { ip, timeout: 8000 }).then(x => readPop(cdn.read, x)).catch(() => null));
      res[n.asn] = { ip, code: await where.get(ip), scope };
    } catch (e) { res[n.asn] = { err: e.message }; }
  }
}
sock.close();
await writeJSON(OUT + "/ecs/days/" + out.t.slice(0, 10) + ".json", out);
await writeJSON(OUT + "/ecs/latest.json", out);
