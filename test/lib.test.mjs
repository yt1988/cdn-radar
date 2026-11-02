// The logic the page and the Worker share: reading each CDN's location, distances, and results in links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CDNS, PARSE, placeOf, popMaps, cdnOfName, isCloudflareIP } from "../src/cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, encode, decode, sharePath, hostOf, groupExits, routes } from "../src/lib.mjs";

const pops = popMaps(JSON.parse(await readFile(new URL("../data/pops.json", import.meta.url), "utf8")));
const places = JSON.parse(await readFile(new URL("../data/places.json", import.meta.url), "utf8"));

test("each CDN's location is read from what it writes (samples seen 2026-11)", () => {
  assert.equal(PARSE.trace("fl=1\nip=1.2.3.4\nts=1\nvisit_scheme=https\ncolo=HKG\nloc=CN\n"), "HKG");
  assert.equal(PARSE["cdn-pop"]("NRT57-P11"), "NRT");
  assert.equal(PARSE["x-amz-cf-pop"]("FRA60-P11"), "FRA");
  assert.equal(PARSE["akamai-request-bc"]("[a=23.54.206.4,b=1231256469,c=g,n=DE_HE_FRANKFURT,o=20940],[c=p,n=DE_HE_FRANKFURT,o=20940]"), "DE-FRANKFURT");
  assert.equal(PARSE["akamai-request-bc"]("[a=2.17.40.235,b=3108410630,c=g,n=GB_EN_LONDON,o=20940]"), "GB-LONDON");
  assert.equal(PARSE["akamai-request-bc"]("[a=23.205.44.10,b=286317260,c=g,n=JP_13_TOKYO,o=20940]"), "JP-TOKYO");
  // a chain of caches: the last is the edge that answered
  assert.equal(PARSE["x-served-by"]("cache-fra-eddf8230169-FRA, cache-nrt-rjtf7700081-NRT"), "NRT");
  assert.equal(PARSE["x-azure-ref"]("20261102T015436Z-15b5db6f675rddfxhC1SELmpyn000000048000000000ancm"), "SEL");
  assert.equal(PARSE["x-azure-ref"]("20261102T021804Z-r1d4bcfd98bg978bhC1LAXuxr000000006yg0000000025wb"), "LAX");
  assert.equal(PARSE.server("BunnyCDN-JP1-1195"), "JP");
  assert.equal(PARSE.server("BunnyCDN-SYD-881"), "SYD");
  assert.equal(PARSE.server("nginx"), null);
  assert.equal(PARSE["x-cache"]("cp5029 miss, cp5029 hit/20268"), "eqsin");
  assert.equal(PARSE["x-cache"]("HIT"), null);
});

test("every code the readers give has a place", () => {
  const cases = [["cloudflare", "HKG"], ["cfchina", "SJW"], ["cloudfront", "NRT"], ["fastly", "BUR"], ["azure", "SEL"], ["azure", "TYO"],
    ["akamai", "DE-FRANKFURT"], ["akamai", "US-LOSANGELES"], ["akamai", "CO-BOGOTA"], ["bunny", "JP"], ["bunny", "LA"], ["wikimedia", "eqsin"]];
  for (const [id, code] of cases) {
    const p = placeOf(id, code, pops, places);
    assert.ok(p && typeof p[2] === "number" && typeof p[3] === "number", `${id} ${code}: ${JSON.stringify(p)}`);
  }
  assert.equal(placeOf("cloudflare", "SJW", pops, places)[0], "Hengshui", "the status page's city, not the airport's");
});

test("the CDN list: unique ids, a color, a read rule the parsers know", () => {
  assert.equal(new Set(CDNS.map(c => c.id)).size, CDNS.length);
  for (const c of CDNS) {
    assert.match(c.c, /^#[0-9a-f]{6}$/, c.id);
    assert.ok(c.url.startsWith("https://"), c.id);
    if (c.read) assert.ok(c.read === "trace" || PARSE[c.read.slice(c.read.indexOf(":") + 1)], c.id + ": " + c.read);
    // names that aren't a brand have all ten languages
    if (typeof c.name !== "string") assert.equal(Object.keys(c.name).length, 10, c.id);
  }
});

test("distances and what they mean", () => {
  assert.ok(Math.abs(km(22.31, 113.91, 33.94, -118.41) - 11650) < 50, "Hong Kong to Los Angeles");
  assert.equal(floorMs(1000), 10);
  assert.equal(tierOf(100)[2], "near");
  assert.equal(tierOf(12000)[2], "away");
  assert.ok(detoured(300, 1000));
  assert.ok(!detoured(45, 1000));
  const n = nearest(pops.cloudflare, 22.3, 114.2);
  assert.ok(["HKG", "SZX", "MFM"].includes(n[0]), n[0]);
  assert.ok(missedNearest(11650, n));
  assert.ok(!missedNearest(140, n));
});

test("the verdict and what stands out", () => {
  const near = { id: "cloudflare", code: "HKG", place: ["Hong Kong", "HK"], ms: 8, d: 20 };
  const far = { id: "akamai", code: "GB-LONDON", place: ["London", "GB"], ms: 200, d: 9600 };
  const s1 = summary([near, { ...near, id: "fastly" }, { ...near, id: "bunny" }, far]);
  assert.equal(s1.key, "v_good");
  assert.deepEqual([s1.near, s1.far, s1.located], [3, 1, 4]);
  assert.equal(s1.farthest.id, "akamai");
  assert.deepEqual(s1.findings.map(f => f.key), ["f_far", "f_fast"]);
  assert.equal(summary([near, far]).key, "v_mixed");
  assert.equal(summary([far, { ...far, id: "fastly" }, { ...far, id: "azure" }, near]).key, "v_far");
  assert.equal(summary([far, { ...far, id: "fastly", d: 9000 }, { ...far, id: "azure", d: 8000 }, near]).findings.find(f => f.key === "f_more").n, 1);
  // near, but a round trip far beyond what 20 km needs: the path goes a long way round
  assert.equal(summary([{ ...near, ms: 180 }]).findings[0].key, "f_slowpath");
  assert.equal(summary([{ ...near, d: null }]).key, "v_noloc");
  const none = summary([{ id: "google", ms: null }]);
  assert.equal(none.key, "v_none");
  assert.deepEqual(none.findings, [{ kind: "bad", key: "f_fail", ids: ["google"] }]);
  assert.equal(summary([near, { id: "alibaba", ms: 6, d: null }]).med, 7);
});

test("a result survives its link", () => {
  const r = { ts: 1793584000000, where: { cc: "CN", lat: 39.91, lon: 116.39, city: "北京" }, isp: "China Unicom",
    rows: [{ id: "cloudflare", code: "LAX", ms: 171.4 }, { id: "akamai", code: "JP-TOKYO", ms: 42 }, { id: "google", code: null, ms: 38.2 }, { id: "fastly", code: null, ms: null }],
    site: { cdn: "cloudfront", code: "NRT", ms: 61.3, host: "www.example.com" } };
  const code = encode(r), back = decode(code);
  assert.ok(sharePath("/zh-cn/r/" + code), "fits the path");
  assert.equal(back.ts, r.ts);
  assert.deepEqual(back.rows, r.rows);
  assert.equal(back.where.cc, "CN");
  assert.equal(back.where.city, "北京");
  assert.ok(Math.abs(back.where.lat - 39.9) < .06 && Math.abs(back.where.lon - 116.4) < .06);
  assert.equal(back.isp, "China Unicom");
  assert.deepEqual(back.site, r.site);
  // without the box ticked: no place, no network
  const bare = decode(encode({ ...r, where: null, isp: "" }));
  assert.equal(bare.where, null);
  assert.equal(bare.isp, "");
  // ids from a later version are skipped; nonsense is refused
  assert.equal(decode(code.replace("cloudflare.", "newcdn.")).rows.length, 3);
  assert.equal(decode("2~x~-~-~-~-"), null);
  assert.equal(decode("1~abc~-~-~-~-"), null);
  assert.equal(decode("1~abc~ZZ.!!~-~-~-"), null);
  assert.deepEqual(sharePath("/r/1~abc~-~-~x~-"), { slug: "", code: "1~abc~-~-~x~-" });
});

// The case that prompted routes (2026-11, a visitor in Hebei behind a rule-based proxy in Tokyo whose address IP
// geolocation puts in Los Angeles): mainland sites direct, the rest through the proxy.
const HEBEI = { cc: "CN", city: "Hengshui", lat: 37.7, lon: 115.7, asn: 4837, org: "CHINA UNICOM China169 Backbone" };
const VPS = { cc: "US", city: "Los Angeles", lat: 34.05, lon: -118.24, asn: 20473, org: "The Constant Company, LLC", edge: [35.77, 140.39, "Tokyo", "JP"] };
const split = () => groupExits([{ ip: "114.254.1.2", src: "cn" }, { ip: "45.76.1.2", src: "self" }, { ip: "45.76.9.9", src: "cloudflare" }, { ip: "114.254.7.7", src: "cfchina" }],
  { "114.254.1.2": HEBEI, "45.76.1.2": VPS });

test("exits: the visitor's own line and a proxy, each placed", () => {
  const E = split();
  assert.deepEqual(E.map(e => [e.letter, e.kind]), [["D", "D"], ["P", "P"]]);
  assert.deepEqual(E[0].srcs, ["cn", "cfchina"]);
  // the proxy is where the Cloudflare location it reaches is, not where its address is registered
  assert.equal(E[1].city, "Tokyo");
  assert.ok(E[1].edge && Math.abs(E[1].lat - 35.77) < .01);
  // no hosting network, two exits: the mainland probe's is direct
  const E2 = groupExits([{ ip: "1.2.3.4", src: "cn" }, { ip: "5.6.7.8", src: "self" }], { "1.2.3.4": { asn: 1, org: "Home ISP" }, "5.6.7.8": { asn: 2, org: "Other ISP" } });
  assert.deepEqual(E2.map(e => e.letter), ["D", "P"]);
  // one exit on a home network: direct, unnumbered; two proxies are numbered
  assert.deepEqual(groupExits([{ ip: "1.2.3.4", src: "cn" }, { ip: "1.2.200.1", src: "self" }], {}).map(e => e.letter), ["D"]);
  const PP = groupExits([{ ip: "45.76.1.2", src: "self" }, { ip: "8.8.4.4", src: "cloudflare" }], { "45.76.1.2": VPS, "8.8.4.4": { asn: 15169, org: "Google LLC" } });
  assert.deepEqual(PP.map(e => e.letter), ["P1", "P2"]);
  // a direct exit is never moved to a Cloudflare location (from China, Cloudflare often answers in the US)
  const D1 = groupExits([{ ip: "1.2.3.4", src: "cn" }], { "1.2.3.4": { ...HEBEI, edge: [33.94, -118.4, "Los Angeles", "US"] } });
  assert.equal(D1[0].city, "Hengshui");
  // … but the China Network's location places one that has no place of its own
  const D2 = groupExits([{ ip: "1.2.3.4", src: "cfchina" }], { "1.2.3.4": { edgeCn: [37.7, 115.7, "Hengshui", "CN"] } });
  assert.equal(D2[0].city, "Hengshui");
});

test("routes: which exit each CDN's request took, and how that was told", () => {
  const E = split(), place = (id, code) => placeOf(id, code, pops, places);
  const rows = [
    { id: "cloudflare", ip: "45.76.9.9", place: place("cloudflare", "NRT"), ms: 118 },
    { id: "cfchina", ip: "114.254.7.7", place: place("cfchina", "SJW"), ms: 28 },
    { id: "cloudfront", place: place("cloudfront", "NRT"), ms: 63 },
    { id: "akamai", place: place("akamai", "GB-LONDON"), ms: 173 },
    { id: "wangsu", ms: 10 },
    // fast, but a proxy the probes didn't see (Hong Kong, for one rule) could carry it: not called direct
    { id: "cdn77", ms: 56 },
    { id: "alibaba", ms: 68 },
    { id: "gcore", ms: 88 },
  ];
  const R = routes(rows, E, "D");
  assert.deepEqual(R.cloudflare, { x: "P", how: "ip" });
  assert.deepEqual(R.cfchina, { x: "D", how: "ip" });
  assert.deepEqual(R.cloudfront, { x: "P", how: "pop" });
  // London is about as far from Tokyo as from Hebei: can't tell
  assert.deepEqual(R.akamai, { x: null });
  // 10 ms: shorter than the way to Tokyo allows
  assert.deepEqual(R.wangsu, { x: "D", how: "ms" });
  assert.deepEqual(R.cdn77, { x: null });
  assert.deepEqual(R.alibaba, { x: "D", how: "rule" });
  assert.deepEqual(R.gcore, { x: null });
  // one exit: everything took it
  assert.deepEqual(routes([{ id: "gcore", ms: 88 }], E.slice(0, 1), "D").gcore, { x: "D", how: "one" });
  // the verdict leaves out the rows it can't place
  assert.equal(summary([{ id: "akamai", ms: 173, d: 8000, unsure: true }, { id: "cloudflare", ms: 20, d: 100 }]).located, 1);
});

test("a result's routes survive its link, and the exits' places only with the visitor's", () => {
  const r = { ts: 1793584000000, where: { cc: "CN", lat: 37.7, lon: 115.7, city: "" }, isp: "",
    rows: [{ id: "cloudflare", code: "NRT", ms: 118, route: { x: "P", how: "ip" } }, { id: "wangsu", code: null, ms: 10, route: { x: "D", how: "ms" } }, { id: "gcore", code: null, ms: 88 }],
    site: null, exits: [{ letter: "P", lat: 35.77, lon: 140.39 }] };
  const back = decode(encode(r));
  assert.deepEqual(back.rows, r.rows);
  assert.equal(back.exits.length, 1);
  assert.ok(Math.abs(back.exits[0].lon - 140.4) < .06);
  assert.deepEqual(decode(encode({ ...r, where: null })).exits, []);
  // links from before routes still read
  assert.deepEqual(decode("1~abc~-~-~cloudflare.LAX.1n4~-").rows, [{ id: "cloudflare", code: "LAX", ms: 212.8 }]);
});

test("host names from what people type", () => {
  assert.equal(hostOf("Example.com"), "example.com");
  assert.equal(hostOf("https://www.example.com/path?q=1"), "www.example.com");
  assert.equal(hostOf("cdn.1ms.dog."), "cdn.1ms.dog");
  assert.equal(hostOf("localhost"), null);
  assert.equal(hostOf("1.2.3.4"), null);
  assert.equal(hostOf("not a domain"), null);
});

test("a site's CDN from its DNS", () => {
  assert.equal(cdnOfName("d111111abcdef8.cloudfront.net."), "cloudfront");
  assert.equal(cdnOfName("e1234.dscb.akamaiedge.net"), "akamai");
  assert.equal(cdnOfName("www.example.com.edgekey.net"), "akamai");
  assert.equal(cdnOfName("dualstack.n.sni.global.fastly.net"), "fastly");
  assert.equal(cdnOfName("example.azurefd.net"), "azure");
  assert.equal(cdnOfName("example.b-cdn.net"), "bunny");
  assert.equal(cdnOfName("www.taobao.com.danuoyi.alikunlun.com"), "alibaba");
  assert.equal(cdnOfName("example.com.cdn.dnsv1.com"), "tencent");
  assert.equal(cdnOfName("example.com.wscdns.com"), "wangsu");
  assert.equal(cdnOfName("cname.vercel-dns.com"), "Vercel");
  assert.equal(cdnOfName("example.com"), null);
  assert.ok(isCloudflareIP("104.16.132.229"));
  assert.ok(isCloudflareIP("172.67.1.1"));
  assert.ok(isCloudflareIP("2606:4700::6810:84e5"));
  assert.ok(!isCloudflareIP("8.8.8.8"));
});
