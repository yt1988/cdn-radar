// 1ms-cdn-watch: every 10 minutes, from 1ms.dog's server in Tokyo, the same test the page runs, over IPv4 and IPv6:
// which location of each CDN answers and the round trip to it. It keeps every run, a day to a file, and sums up the
// last 30 days for the site (summary.json, fetched by the Worker through data.1ms.dog):
//
//   days/<YYYY-MM-DD>.json  [{ t, r: { "<cdn>/<4|6>": [code, ms, ip] | [null, null, null, err] } }]   kept 400 days
//   summary.json            { t, latest: <the last run>, keys: { "<cdn>/<4|6>": { n, ok, codes: { code: runs }, med,
//                             days: [[date, median ms, the day's usual code, answered share]] } },
//                             changes: [[t, key, from, to]] (the last 50 times a CDN moved Tokyo to another location) }
import https from "node:https";
import { readFile, readdir, unlink } from "node:fs/promises";
import { CDNS } from "../src/cdns.mjs";
import { OUT, get, readPop, writeJSON, wait, median } from "./common.mjs";

const TIMED = 3, GAP = 80, DAYS = 30, KEEP = 400;
const r1 = x => Math.round(x * 10) / 10;

// one CDN over one family, as src/probe.mjs does in the browser: the first request opens the connection, the timed
// ones reuse it; the second file stands in when the first doesn't answer, and gives the location when it has none
async function probe(cdn, family) {
  const urls = [{ url: cdn.url, read: cdn.read }, ...[].concat(cdn.alt || [])].filter(u => /^https:/.test(u.url));
  for (const [i, u] of urls.entries()) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1, family });
    try {
      const warm = await get(u.url, { agent, family });
      let code = readPop(u.read, warm);
      const ts = [];
      for (let k = 0; k < TIMED; k++) {
        await wait(GAP);
        try { const x = await get(u.url, { agent, family }); ts.push(x.ms); if (!code) code = readPop(u.read, x); } catch (e) {}
      }
      if (!code && urls[i + 1]) try { code = readPop(urls[i + 1].read, await get(urls[i + 1].url, { family })); } catch (e) {}
      return [code, r1(ts.length ? median(ts) : warm.ms), warm.ip];
    } catch (e) {
      if (!urls[i + 1]) return [null, null, null, /timeout/.test(e.message) ? "timeout" : e.code === "ENOTFOUND" || e.code === "ENODATA" ? "nodns" : "fail"];
    } finally { agent.destroy(); }
  }
}

const now = new Date(), day = now.toISOString().slice(0, 10);
const run = { t: now.toISOString().slice(0, 16) + "Z", r: {} };
for (const c of CDNS) for (const fam of [4, 6]) run.r[`${c.id}/${fam}`] = await probe(c, fam);

const dir = OUT + "/watch/days/";
const readDay = async d => { try { return JSON.parse(await readFile(dir + d + ".json", "utf8")); } catch (e) { return []; } };
const today = await readDay(day);
today.push(run);
await writeJSON(dir + day + ".json", today);

// the last 30 days, oldest first
const files = (await readdir(dir)).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
const since = new Date(now - DAYS * 864e5).toISOString().slice(0, 10), old = new Date(now - KEEP * 864e5).toISOString().slice(0, 10);
for (const f of files) if (f.slice(0, 10) < old) await unlink(dir + f);
const recent = files.filter(f => f.slice(0, 10) >= since);
const keys = {}, changes = [], last = {};
for (const f of recent) {
  const runs = f.slice(0, 10) === day ? today : await readDay(f.slice(0, 10)), byKey = {};
  for (const x of runs) for (const [k, [code, ms]] of Object.entries(x.r)) {
    const K = keys[k] ||= { n: 0, ok: 0, codes: {}, ms: [], days: [] }, D = byKey[k] ||= { n: 0, ms: [], codes: {} };
    K.n++; D.n++;
    if (ms != null) { K.ok++; K.ms.push(ms); D.ms.push(ms); }
    if (code) {
      K.codes[code] = (K.codes[code] || 0) + 1; D.codes[code] = (D.codes[code] || 0) + 1;
      if (last[k] && last[k] !== code) changes.push([x.t, k, last[k], code]);
      last[k] = code;
    }
  }
  for (const [k, D] of Object.entries(byKey)) {
    const top = Object.entries(D.codes).sort((a, b) => b[1] - a[1])[0];
    keys[k].days.push([f.slice(0, 10), D.ms.length ? r1(median(D.ms)) : null, top ? top[0] : null, Math.round(D.ms.length / D.n * 100) / 100]);
  }
}
for (const K of Object.values(keys)) { K.med = K.ms.length ? r1(median(K.ms)) : null; delete K.ms; }
await writeJSON(OUT + "/watch/summary.json", { t: run.t, latest: run, keys, changes: changes.slice(-50) });
