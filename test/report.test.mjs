// The report dialog's contract (1ms-shell docs/tool-contract.md, section 4; the audit yt1988/1ms-shell#97): the line,
// the JSON and the picks have the dialog's limits, and nothing that would place the visitor travels with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportOf, MAX_SUMMARY, MAX_DATA, MAX_PICKS, MAX_PICK } from "../src/report.mjs";

const dict = async lang => (await import(`../src/i18n/${lang}.mjs`)).default;
const EN = await dict("en"), ZH = await dict("zh-CN");
// the page's own translator and round-trip formatter (src/app.js, src/lib.mjs)
const ts = d => { const t = k => d[k] ?? k; const msTxt = ms => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms))) + " ms"; return { t, msTxt }; };
const { t, msTxt } = ts(EN);

// a full home page's readings: eight CDNs that name a data center, five timed only, one that failed
const ROWS = [
  { id: "cloudflare", name: "Cloudflare", code: "HKG", ms: 8.2, read: true },
  { id: "cfchina", name: "Cloudflare China Network", code: "HKG", ms: 9.1, read: true },
  { id: "cloudfront", name: "Amazon CloudFront", code: "NRT57", ms: 41.6, read: true },
  { id: "akamai", name: "Akamai", code: "GB-LONDON", ms: 210, read: true },
  { id: "fastly", name: "Fastly", code: null, ms: null, err: "timeout", read: true },
  { id: "azure", name: "Azure Front Door", code: "NRT", ms: 44.4, read: true },
  { id: "bunny", name: "Bunny CDN", code: "JP", ms: 39.2, read: true },
  { id: "wikimedia", name: "Wikimedia", code: "eqsin", ms: 55.5, read: true },
  { id: "google", name: "Google", code: null, ms: 38.2, read: false },
  { id: "alibaba", name: "Alibaba Cloud", code: null, ms: 61, read: false },
  { id: "tencent", name: "Tencent EdgeOne", code: null, ms: 52.7, read: false },
  { id: "wangsu", name: "Wangsu (CDNetworks)", code: null, ms: 88.1, read: false },
  { id: "gcore", name: "Gcore", code: null, ms: 60, read: false },
  { id: "cdn77", name: "CDN77", code: null, ms: 70.2, read: false },
];
const HOME = {
  at: 1793584000000, lang: "en", kind: "home", cdn: null, pop: null, shared: false,
  context: "", head: "CDNs serve you from nearby", sub: "14 CDNs showed their data center: 10 nearby, 4 far away.",
  med: 41.6, medLabel: "Typical latency", verdict: "v_good", far: ["akamai"], counts: { tested: 14, answered: 13, located: 10, near: 7, far: 3 },
  rows: ROWS, site: null, tokyo: null, ecs: null, list: { up: "2026-11-02", file: "pops.0123456789.json" }, t, msTxt,
};
const bytes = o => new TextEncoder().encode(JSON.stringify(o, null, 1)).length;

test("a home page's line says what was tested and what it said", () => {
  const r = reportOf(HOME);
  assert.equal(r.summary, "CDNs serve you from nearby · 14 CDNs showed their data center: 10 nearby, 4 far away. · Typical latency 42 ms");
  assert.ok(r.summary.length <= MAX_SUMMARY);
});

test("the readings are one compact row per CDN, with what failed apart", () => {
  const { data } = reportOf(HOME);
  assert.equal(data.v, 1);
  assert.equal(data.page, "home");
  assert.equal(data.cdn, null);
  assert.equal(data.shared, 0);
  assert.equal(data.verdict, "v_good");
  assert.deepEqual(data.n, { tested: 14, answered: 13, located: 10, near: 7, far: 3 });
  assert.equal(data.far, "akamai");
  assert.equal(data.list.up, "2026-11-02");
  assert.equal(data.list.file, "pops.0123456789.json");
  // "id.code.ms", "-" for no location and for no answer; the reason for a failure in its own field
  assert.equal(data.rows.split(";").length, 14);
  assert.equal(data.rows.split(";")[0], "cloudflare.HKG.8.2");
  assert.equal(data.rows.split(";")[3], "akamai.GB-LONDON.210");
  assert.equal(data.rows.split(";")[8], "google.-.38.2");
  assert.equal(data.rows.split(";")[4], "fastly.-.-");
  assert.equal(data.fail, "fastly:timeout");
  // 6 KB as the dialog prints it, one key per line
  assert.ok(bytes(data) <= MAX_DATA, bytes(data) + " bytes");
});

test("the picks are the verdict, then each row's reading, at most eight short lines", () => {
  const r = reportOf(HOME);
  assert.equal(r.picks.length, MAX_PICKS);
  assert.equal(r.picks[0], "CDNs serve you from nearby");
  for (const p of r.picks) assert.ok(p.length <= MAX_PICK, p);
  assert.ok(r.picks.includes("Cloudflare: HKG · 8.2 ms"));
  assert.ok(r.picks.includes("Akamai: GB-LONDON · 210 ms"));
  assert.ok(r.picks.includes("Fastly: Timed out"));
  // a CDN timed only (no location to read) offers its round trip alone
  const one = reportOf({ ...HOME, rows: [{ id: "google", name: "Google", code: null, ms: 38.2, read: false }] });
  assert.ok(one.picks.includes("Google: 38 ms"), one.picks.join(" | "));
});

test("nothing that would place the visitor goes with the report", () => {
  const { data, summary, picks } = reportOf({ ...HOME, site: { host: "example.com", name: "Cloudflare", cdn: "cloudflare", code: "HKG", ms: 61.3 } });
  const json = JSON.stringify(data);
  // no address (the page never sees one), no city, coordinates, distance or network name, no state a share link hides
  for (const k of ["lat", "lon", "city", "isp", "ip", "dist", "km", "asn", "org", "loc"]) assert.ok(!new RegExp(`"${k}"`).test(json), k);
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(json), "an address in the JSON");
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(summary + picks.join(" ")), "an address in the line or a pick");
  assert.match(summary, /^CDNs serve you from nearby/);
});

test("a location page's line names the location, and its latency is not said twice", () => {
  const rows = [{ id: "cloudflare", name: "Cloudflare", code: "HKG", ms: 32.4, read: true }];
  const r = reportOf({ ...HOME, kind: "pop", cdn: "cloudflare", pop: "HKG", rows, counts: { tested: 1, answered: 1, located: 1, near: 1, far: 0 }, med: 32.4,
    context: "Cloudflare HKG", head: "You're connected to this data center. Latency 32 ms.", sub: "", verdict: "pr_same" });
  assert.equal(r.summary, "Cloudflare HKG · You're connected to this data center. Latency 32 ms.");
  assert.equal(r.data.page, "pop");
  assert.equal(r.data.pop, "HKG");
  assert.equal(r.data.verdict, "pr_same");
  assert.equal(r.data.rows, "cloudflare.HKG.32.4");
  assert.ok(r.picks.includes("Cloudflare: HKG · 32 ms"));
});

test("a CDN page adds the Tokyo readings and the ISP table's date", () => {
  const rows = [{ id: "akamai", name: "Akamai", code: "GB-LONDON", ms: 210, read: true }];
  const r = reportOf({ ...HOME, kind: "cdn", cdn: "akamai", rows, counts: { tested: 1, answered: 1, located: 1, near: 0, far: 1 }, med: 210, medLabel: "Latency", verdict: "pv_pop",
    head: "Akamai serves you from GB-LONDON London", sub: "",
    tokyo: { at: "2026-11-09T13:00:00.000Z", v4: "LHR/190", v6: "LHR/191" }, ecs: { at: "2026-11-09T04:20:00.000Z" } });
  assert.equal(r.summary, "Akamai serves you from GB-LONDON London · Latency 210 ms");
  assert.equal(r.data.page, "cdn");
  assert.equal(r.data.cdn, "akamai");
  assert.equal(r.data.tokyo.v4, "LHR/190");
  assert.equal(r.data.ecs.at, "2026-11-09T04:20:00.000Z");
  assert.ok(bytes(r.data) <= MAX_DATA);
});

test("Chinese reads with its own separator, and a long line is cut at the dialog's limit", () => {
  const { t: tz, msTxt: mz } = ts(ZH);
  const r = reportOf({ ...HOME, lang: "zh-CN", t: tz, msTxt: mz, head: "主目录 CDN ".repeat(80) });
  assert.ok(r.summary.length <= MAX_SUMMARY);
  assert.equal(r.summary.length, MAX_SUMMARY);
  assert.ok(r.picks.some(p => p.startsWith("Cloudflare：HKG")), r.picks.join(" | "));
});

test("a site check's result goes in the JSON and offers itself as a pick", () => {
  const r = reportOf({ ...HOME, site: { host: "example.com", name: "Cloudflare", cdn: "cloudflare", code: "HKG", ms: 61.3 } });
  assert.deepEqual(r.data.site, { host: "example.com", cdn: "cloudflare", code: "HKG", ms: 61.3 });
  assert.equal(r.picks[1], "example.com: Cloudflare HKG");
});

test("no result yet: nothing to report", () => {
  assert.equal(reportOf(null), null);
  assert.equal(reportOf({ ...HOME, rows: [] }), null);
});
