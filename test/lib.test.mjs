// The logic the page and the Worker share: reading each CDN's location, distances, and results in links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CDNS, PARSE, placeOf, popMaps, cdnOfName, isCloudflareIP } from "../src/cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, encode, decode, sharePath, hostOf } from "../src/lib.mjs";

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
