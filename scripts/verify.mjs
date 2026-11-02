#!/usr/bin/env node
// Checks every CDN's test file in src/cdns.mjs from where it runs: the page only works if each still answers, and the
// ones it reads still let a page read the location.
//   - every file answers, without a redirect (a 429 from the edge itself counts: it names and times the edge)
//   - read "trace": a CORS answer whose body has colo=
//   - read "h:<header>": a CORS answer that exposes the header (Access-Control-Expose-Headers lists it, or *), and the
//     header names a location the parser knows
//   - read "st:<name>": Timing-Allow-Origin, and a Server-Timing entry <name> the parser knows
//   - the fastest of three requests on a reused connection, printed: it should be about one round trip to a nearby
//     edge; much more means the file comes from the origin, which the page would count as distance
// Run it from a few networks (a laptop in Asia, a server in Europe): a CDN may answer differently by region.
// Usage: node scripts/verify.mjs      exit 1 when a file fails
import { request, Agent } from "node:https";
import { CDNS, PARSE } from "../src/cdns.mjs";

const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const get = url => new Promise((res, rej) => {
  const u = new URL(url), t0 = performance.now();
  const req = request({ host: u.hostname, path: u.pathname + u.search, agent, timeout: 10000,
    headers: { origin: "https://cdn.1ms.dog", "user-agent": "Mozilla/5.0 cdn-radar verify", "cache-control": "no-cache" } }, r => {
    const ttfb = performance.now() - t0;
    let body = ""; r.setEncoding("utf8"); r.on("data", c => { body += c; }); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body, ttfb }));
  });
  req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", rej); req.end();
});

let bad = 0;
const say = (okay, what, why = "") => { if (!okay) bad++; console.log(`${okay ? "ok  " : "FAIL"} ${what.padEnd(12)} ${why}`); };

for (const c of CDNS) {
  for (const [f, read] of [[c.url, c.read], ...(c.alt ? [[c.alt.url, c.alt.read]] : [])]) {
    const what = c.id + (f === c.url ? "" : " (alt)");
    try {
      const first = await get(f);
      if (first.status >= 300 && first.status < 400) { say(false, what, `redirects to ${first.headers.location}`); continue; }
      const times = [];
      for (let i = 0; i < 3; i++) times.push((await get(f)).ttfb);
      const best = Math.min(...times), h = first.headers;
      let code = null, why = "";
      if (read === "trace") { code = PARSE.trace(first.body); why = h["access-control-allow-origin"] ? "" : "no CORS"; }
      else if (read && read.startsWith("h:")) {
        const name = read.slice(2), exp = String(h["access-control-expose-headers"] || "").toLowerCase().split(/\s*,\s*/);
        code = PARSE[name](h[name]);
        why = !h["access-control-allow-origin"] ? "no CORS" : !exp.includes(name) && !exp.includes("*") ? `${name} not exposed` : "";
      } else if (read && read.startsWith("st:")) {
        const name = read.slice(3), st = String(h["server-timing"] || ""), m = new RegExp(`${name};desc="?([^",;]+)`).exec(st);
        code = m ? PARSE[name](m[1]) : null;
        why = h["timing-allow-origin"] ? "" : "no Timing-Allow-Origin";
      }
      if (read && !code) why = why || "no location in the answer";
      // a 429 the edge wrote itself (Wikimedia's rate limit, "int-front") still names the edge and times it
      say(!why && (first.status < 400 || first.status === 429 && !!code), what, `${first.status} ${code || (read ? "" : "(timed only)")} best ${best.toFixed(0)} ms${why ? "  " + why : ""}`);
    } catch (e) {
      say(false, what, e.code || e.message);
    }
  }
}
agent.destroy();
process.exitCode = bad ? 1 : 0;
