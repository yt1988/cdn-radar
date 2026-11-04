// The built pages keep the 1ms.dog tool contract (1ms-shell docs/tool-contract.md): run after scripts/build.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { LANGS, LISTS } from "../scripts/build.mjs";
import { CDNS } from "../src/cdns.mjs";

const SITE = "https://cdn.1ms.dog";
const pops = JSON.parse(await readFile(new URL("../data/pops.json", import.meta.url), "utf8"));
const page = path => readFile(new URL(`../public/${path}index.html`, import.meta.url), "utf8");
const one = (h, re) => (re.exec(h) || [])[1];
const at = (slug, dir = "") => (slug ? slug + "/" : "") + dir;

// the pages of one language: the test, a CDN's page, a CDN with no list, two locations (one on the China Network)
const SAMPLES = ["", "cloudflare/", "google/", "cloudflare/hkg/", "cloudflare/sjw/", "bunny/jp/", "wikimedia/eqsin/"];

test("every page keeps the shell contract and its SEO", async () => {
  for (const [lang, slug] of LANGS) for (const dir of SAMPLES) {
    const h = await page(at(slug, dir)), what = `${lang} /${at(slug, dir)}`;
    assert.match(h, new RegExp(`<html lang="${lang}"`), what);
    assert.match(h, /<head>\r?\n<meta charset="utf-8">\r?\n<script>/, what + ": charset first, then the pre-paint script");
    assert.match(h, /id="helpBtn"[^>]*aria-haspopup="dialog"/, what + ": help button");
    assert.match(h, /<div class="scrim" id="help" hidden>/, what + ": help dialog hidden");
    assert.match(h, /class="logo-light" src="\/assets\/logo-light.svg" width="90" height="36"[^>]*loading="lazy"/, what + ": logo");
    assert.ok(!/\{\{[\w:]+\}\}/.test(h), what + ": unfilled placeholder");
    assert.ok(h.length < 90000, what + ": page is " + h.length + " bytes");
    assert.equal((h.match(/<script>/g) || []).length, 1, what + ": the only inline script is the pre-paint one");
    assert.equal((h.match(/<div data-ms-more><\/div>/g) || []).length, 1, what + ": one place for the shell's tool list");
    assert.ok(h.indexOf("data-ms-more") < h.indexOf('class="scrim"'), what + ": tool list before the dialogs");
    const order = ['id="lang"', 'id="helpBtn"', 'class="icon-btn gh"', 'id="theme"'].map(s => h.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order, what + ": header button order");
    assert.equal(one(h, /<link rel="canonical" href="(.*?)">/), SITE + "/" + at(slug, dir), what + ": canonical");
    for (const [l, s] of LANGS) assert.ok(h.includes(`hreflang="${l}" href="${SITE}/${at(s, dir)}"`), what + ": alternate " + l);
    assert.ok(h.includes(`hreflang="x-default" href="${SITE}/${dir}"`), what + ": x-default");
    assert.ok(h.includes(`og:image" content="${SITE}/og/${lang.toLowerCase()}.png"`), what + ": og:image");
    assert.equal((h.match(/<h1>/g) || []).length, 1, what + ": one h1");
    JSON.parse(one(h, /<script type="application\/ld\+json">(.*?)<\/script>/));
    // the home page has every CDN's row or tile; a CDN's page only its own (1ms-shell tool-contract: subpages)
    const rows = (h.match(/<div class="(?:cr|tt) wait[^"]*" data-c="/g) || []).length;
    if (dir === "") assert.equal(rows, CDNS.length, what + ": every CDN's row or tile");
    else if (dir.split("/").length === 2) assert.equal(rows, 1, what + ": only this CDN's row or tile");
  }
});

test("the home page links to every CDN's page and the busiest locations", async () => {
  for (const [lang, slug] of LANGS) {
    const h = await page(at(slug));
    for (const c of CDNS) assert.ok(h.includes(`href="/${at(slug, c.id + "/")}"`), lang + ": " + c.id);
    assert.ok(h.includes(`href="/${at(slug, "cloudflare/hkg/")}"`), lang + ": HKG");
  }
});

test("each page has its own title", async () => {
  for (const [lang, slug] of LANGS) {
    const titles = await Promise.all(SAMPLES.map(async d => one(await page(at(slug, d)), /<title>(.*?)<\/title>/)));
    assert.equal(new Set(titles).size, titles.length, lang + ": " + titles.join(" | "));
  }
});

test("a page for every CDN and every listed location, in every language", async () => {
  for (const [, slug] of LANGS) {
    for (const c of CDNS) await page(at(slug, c.id + "/"));
    for (const l of LISTS) {
      const dirs = new Set(await readdir(new URL(`../public/${at(slug, l + "/")}`, import.meta.url)));
      for (const p of pops[l]) assert.ok(dirs.has(p[0].toLowerCase()), `${slug}/${l}/${p[0]}`);
    }
  }
});

test("the sitemaps list every page in every language", async () => {
  const index = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.equal((index.match(/<sitemap>/g) || []).length, LANGS.length);
  const n = 1 + CDNS.length + LISTS.reduce((a, l) => a + pops[l].length, 0);
  for (const [lang, slug] of LANGS) {
    const sm = await readFile(new URL(`../public/sitemap-${lang.toLowerCase()}.xml`, import.meta.url), "utf8");
    assert.equal((sm.match(/<loc>/g) || []).length, n, lang);
    assert.ok(sm.includes(`<loc>${SITE}/${at(slug, "cloudflare/hkg/")}</loc>`), lang);
  }
});

test("the share dialog is the shell's, unchanged, and loaded only on demand", async () => {
  const js = await readdir(new URL("../public/assets/", import.meta.url));
  const app = await readFile(new URL("../public/assets/" + js.find(f => /^app\..+\.js$/.test(f)), import.meta.url), "utf8");
  // with its version: /assets/ is cached for a week, and an older copy has no received()
  assert.match(app, /"\/assets\/share\/share\.js\?v=\d+"/);
  assert.match(app, /import\(\w+\)/);
  assert.ok(!/id="shareDlg"/.test(await page("")));
});

test("the rule sets for proxy clients list every test host, and only those", async () => {
  const { HOSTS } = await import("../src/cdns.mjs");
  const file = f => readFile(new URL(`../public/rules/${f}`, import.meta.url), "utf8");
  const hosts = (text, re) => [...text.matchAll(re)].map(m => m[1]);
  assert.deepEqual(hosts(await file("clash.yaml"), /^  - DOMAIN,(\S+)$/gm), HOSTS);
  for (const f of ["surge.list", "loon.list"]) assert.deepEqual(hosts(await file(f), /^DOMAIN,(\S+)$/gm), HOSTS, f);
  assert.deepEqual(hosts(await file("quanx.list"), /^host, (\S+), direct$/gm), HOSTS);
  assert.deepEqual(JSON.parse(await file("singbox.json")).rules[0].domain, HOSTS);
  assert.ok(HOSTS.includes("www.cloudflare.com") && !HOSTS.some(h => h.includes("1ms.dog")));
  assert.match(await readFile(new URL("../public/_headers", import.meta.url), "utf8"), /\/rules\/\*\n  Access-Control-Allow-Origin: \*\n  Content-Type: text\/plain/);
});
