// What the two jobs on 1ms.dog's Tokyo server share: one HTTPS request read the way the page reads a CDN's answer,
// and files written whole (to a temporary name, then renamed), so the site never fetches half of one.
import https from "node:https";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { PARSE, parserOf } from "../src/cdns.mjs";

export const OUT = process.env.OUT || "/srv/1ms-data/cdn";
export const UA = "1ms.dog CDN Radar (+https://cdn.1ms.dog)";

// GET url over agent; ip: connect to this address instead of the name's (the name still goes in SNI and Host).
// → { status, headers, body, ms (request sent to first byte of the answer), ip }
export function get(url, { agent, ip, family, timeout = 6000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    // timed from the request: on a kept-alive connection (the warm-up request opened it) that is one round trip
    const t0 = performance.now();
    const req = https.request({ host: ip || u.hostname, servername: u.hostname, path: u.pathname + u.search, family, agent,
      headers: { host: u.hostname, "user-agent": UA, accept: "*/*" }, timeout }, res => {
      const ms = performance.now() - t0, chunks = [], addr = res.socket && res.socket.remoteAddress;
      res.on("data", c => { if (chunks.length < 64) chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms, ip: addr || null }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

// The location an answer names, by the CDN's read rule; Server-Timing read from the header (a browser reads it from
// the resource timing entry)
export function readPop(read, x) {
  if (!read || !x) return null;
  if (read === "trace") return PARSE.trace(x.body);
  if (read.startsWith("h:")) return parserOf(read)(x.headers[read.slice(2)]);
  if (read.startsWith("st:")) {
    const name = read.slice(3), m = new RegExp(`(?:^|,)\\s*${name}\\s*;[^,]*desc="?([^",;]+)`).exec(x.headers["server-timing"] || "");
    return m ? PARSE[name](m[1]) : null;
  }
  return null;
}

export async function writeJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, path);
}

export const wait = ms => new Promise(r => setTimeout(r, ms));
export const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : null; };
