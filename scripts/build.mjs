#!/usr/bin/env node
// Builds the site in public/ (not committed: Workers Builds runs this before deploying) from src/, data/ and static/:
//   index.html, <lang>/index.html                 the test, every CDN's row drawn in it
//   <cdn>/index.html, <lang>/<cdn>/…              the same test as a page about one CDN: its row first, how its
//                                                 location is read, and its locations when it publishes them
//   <list>/<code>/index.html, <lang>/<list>/<code>/…   one page per location of the CDNs that publish theirs
//                                                 (Cloudflare, Bunny, Wikimedia: data/pops.json), with a test of
//                                                 whether it's the one that serves you
//   assets/app.<hash>.js, .css, l.<lang>.<hash>.js the page's code, styles and strings
//   assets/pops.<hash>.json, places.<hash>.json   the locations and where codes are (data/), fetched by the page
//   assets/map.<hash>.svg                         the world's land for the map (world-atlas, Natural Earth 1:110m)
//   rules/clash.yaml, surge.list, loon.list, quanx.list, singbox.json   the test hosts as rule sets for proxy clients
//   sitemap.xml (and one per language), robots.txt, llms.txt, _headers
//   static/…                                      copied as they are: fonts, logos, the share dialog, icons, og/
// The Worker (src/worker.js: /geo and shared results under /r/) is deployed from source by wrangler.
// Usage: node scripts/build.mjs
import { mkdir, readFile, readdir, writeFile, rm, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as bundle, transform } from "esbuild";
import { feature } from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";
import { CDNS, BY, HOSTS, nameOf } from "../src/cdns.mjs";
import { km } from "../src/lib.mjs";

const SITE = (process.env.SITE_URL || "https://cdn.1ms.dog").replace(/\/+$/, "");
const root = new URL("../", import.meta.url), pub = new URL("public/", root), src = new URL("src/", root);
// language, URL folder, og:locale; the first is the root
export const LANGS = [["en", "", "en_US"], ["zh-CN", "zh-cn", "zh_CN"], ["zh-TW", "zh-tw", "zh_TW"], ["ja", "ja", "ja_JP"], ["ko", "ko", "ko_KR"],
  ["es", "es", "es_ES"], ["fr", "fr", "fr_FR"], ["de", "de", "de_DE"], ["pt", "pt", "pt_BR"], ["ru", "ru", "ru_RU"]];
// the CDNs whose every location has a page
export const LISTS = ["cloudflare", "bunny", "wikimedia"];
// Cloudflare locations linked from the home page: the ones Asia, the Americas and Europe land on most, and the
// biggest of the China Network's
const HOT = ["HKG", "TPE", "NRT", "KIX", "ICN", "SIN", "BKK", "BOM", "LAX", "SJC", "SEA", "IAD", "ORD", "FRA", "AMS", "LHR", "CDG", "SYD", "GRU", "DXB", "SHA", "PKX", "CAN", "CTU"];

// Runs before first paint: apply the saved theme. On an English page, send visitors to their language's (a saved
// choice first, then the browser languages), and a shared result /r/<code> to /<lang>/r/<code>; crawlers and English
// readers stay.
const PREPAINT = `(function(){var d=document.documentElement,th=null,s=null;try{th=localStorage.getItem("cdnradar:theme");s=localStorage.getItem("cdnradar:lang")}catch(e){}if(th==="light"||th==="dark")d.setAttribute("data-theme",th);if(!d.hasAttribute("data-root"))return;var P=JSON.parse(d.getAttribute("data-paths")||"{}"),l=null;try{var q=new URLSearchParams(location.search).get("lang");if(P[q])l=q}catch(e){}if(!l&&P[s])l=s;for(var ls=navigator.languages||[navigator.language||"en"],i=0;!l&&!s&&i<ls.length;i++){var x=String(ls[i]).toLowerCase(),b=x.split("-")[0];l=b==="zh"?(/tw|hk|mo|hant/.test(x)?"zh-TW":"zh-CN"):P[b]?b:null}var p=location.pathname,t=p===P.en?"":p.indexOf("/r/")===0?p.slice(1):null;if(l&&l!=="en"&&t!==null)location.replace(P[l]+t+location.search+location.hash)})();`;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 10);
const sha = s => createHash("sha256").update(s).digest("base64");
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);
const pathOf = (slug, dir = "") => "/" + (slug ? slug + "/" : "") + dir;
const json = x => JSON.stringify(x).replace(/</g, "\\u003c");
const EXT = '<svg class="ext" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';

// Rule sets of every host the test fetches from (HOSTS), for proxy clients to subscribe to (the page's "Test only
// direct or only proxy" dialog). They carry no policy: the visitor's config sends them DIRECT or through the proxy.
// Exact hosts only, so nothing else changes route. As 1ms.dog's Me2Cloud publishes its own.
function ruleSets() {
  const head = c => `${c} CDN Radar: the ${HOSTS.length} hosts its test fetches from, to send all one way (direct or proxy).\n${c} ${SITE}/ · https://github.com/yt1988/cdn-radar\n`;
  const list = line => HOSTS.map(line).join("\n") + "\n";
  return {
    "clash.yaml": head("#") + "payload:\n" + list(h => `  - DOMAIN,${h}`),
    "surge.list": head("#") + list(h => `DOMAIN,${h}`),
    "loon.list": head("#") + list(h => `DOMAIN,${h}`),
    "quanx.list": head("#") + list(h => `host, ${h}, direct`),
    "singbox.json": JSON.stringify({ version: 2, rules: [{ domain: HOSTS }] }, null, 2) + "\n",
  };
}

async function loadI18n() {
  const out = {};
  for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs")))
    out[f.slice(0, -4)] = (await import(new URL("i18n/" + f, src).href + "?" + Date.now())).default;
  return out;
}

// Strings only the build uses (the page has them already); the rest go to the browser
const BUILD_ONLY = new Set(["name", "seo_title", "seo_desc", "seo_kw", "og_sub", "h1", "docs", "lang_label", "faq_h", "h_cdns", "cdns_sub", "c_cdn", "c_pop",
  "c_dist", "c_ms", "h_timed", "st_near", "st_near_s", "st_med", "st_far", "you_k", "precise", "h_site", "site_ph", "site_go", "egress_link", "cost_link",
  "speed_link", "home_link", "share_title", "share_desc", "cdn_title", "cdn_desc", "cdn_desc_list", "cdn_kw", "cdn_h1", "cdn_og", "cdn_title_timed", "cdn_desc_timed", "cdn_kw_timed",
  "cdn_h1_timed", "cdn_og_timed", "cond_note", "cond_ctl", "rules_h", "rules_intro", "rules_mode", "rules_d", "rules_p", "rules_fmt", "rules_tip", "how_h", "how_trace", "how_header",
  "how_timing", "how_none", "list_h", "list_cn", "more_cdns", "pop_title", "pop_desc", "pop_kw", "pop_h1", "pop_intro", "f_code", "f_city", "f_country",
  "f_coord", "f_net", "pop_cn", "pop_global", "near_h", "cc_h", "hl_cdns", "hl_pops", "hl_n", "hl_read", "hl_timed"]);

// The map's land: Natural Earth 1:110m (world-atlas), on an equirectangular world from 84°N to 58°S, 1 unit a degree
async function mapSvg() {
  const topo = JSON.parse(await readFile(new URL("node_modules/world-atlas/land-110m.json", root), "utf8"));
  const proj = geoEquirectangular().scale(180 / Math.PI).translate([180, 84]).precision(.2);
  const d = geoPath(proj).digits(1)(feature(topo, topo.objects.land));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 142"><path d="${d}"/></svg>`;
}

export async function build() {
  const I = await loadI18n(), en = I.en;
  const langs = LANGS.filter(([l]) => I[l]);
  for (const [l] of langs) for (const k of Object.keys(en)) if (!(k in I[l])) throw new Error(`i18n/${l}.mjs is missing "${k}"`);
  const tpl = await readFile(new URL("page.html", src), "utf8");
  const POPS = JSON.parse(await readFile(new URL("data/pops.json", root), "utf8"));
  const PLACES = await readFile(new URL("data/places.json", root), "utf8");

  const js = (await bundle({ entryPoints: [fileURLToPath(new URL("app.js", src))], bundle: true, minify: true, format: "iife", target: "es2020",
    legalComments: "none", write: false, absWorkingDir: fileURLToPath(root), external: ["/assets/share/*"] })).outputFiles[0].text;
  const css = (await transform((await Promise.all(["fonts.css", "base.css", "style.css"].map(f => readFile(new URL(f, src), "utf8")))).join("\n"),
    { loader: "css", minify: true, legalComments: "none" })).code;
  const popsJ = JSON.stringify(POPS), map = await mapSvg();
  const F = { js: `app.${hash(js)}.js`, css: `app.${hash(css)}.css`, pops: `pops.${hash(popsJ)}.json`, places: `places.${hash(PLACES)}.json`, map: `map.${hash(map)}.svg` };
  const files = { ["assets/" + F.js]: js, ["assets/" + F.css]: css, ["assets/" + F.pops]: popsJ, ["assets/" + F.places]: PLACES.trim(), ["assets/" + F.map]: map };
  const sitemaps = Object.fromEntries(langs.map(([l]) => [l, []]));

  for (const [lang, slug, locale] of langs) {
    const d = I[lang], T = (k, v) => { if (!(k in d)) throw new Error(`i18n/${lang}.mjs has no "${k}"`); return v ? fill(d[k], v) : d[k]; };
    const strings = Object.fromEntries(Object.keys(en).filter(k => !BUILD_ONLY.has(k)).map(k => [k, T(k)]));
    const sjs = `window.L1MS=${json(strings)};\n`, sName = `l.${lang.toLowerCase()}.${hash(sjs)}.js`;
    files["assets/" + sName] = sjs;
    const regions = new Intl.DisplayNames([lang], { type: "region" }), country = cc => { try { return regions.of(cc); } catch (e) { return cc; } };
    const cname = c => nameOf(c, lang);
    const docs = T("docs").map(([q, a]) => ({ q, h: a.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join(""), t: a.replace(/\n+/g, " ") }));
    const helpNav = docs.map((x, i) => `<button type="button" role="tab" data-hq="${i}" aria-selected="${i === 0}">${esc(x.q)}</button>`).join("");
    const helpC = docs.map((x, i) => `<article data-hqb="${i}"${i ? " hidden" : ""}><h3>${esc(x.q)}</h3>${x.h}</article>`).join("");
    const langOpts = langs.map(([l]) => `<option value="${l}"${l === lang ? " selected" : ""}>${esc(I[l].name)}</option>`).join("");
    const popHref = Object.fromEntries(LISTS.map(l => [l, pathOf(slug, l + "/")]));
    const linkOut = (id, k) => `<a id="${id}" hidden target="_blank" rel="noopener"><span>${esc(T(k))}</span>${EXT}</a>`;

    // One CDN whose location is read: name, location, distance, and the round trip with a bar; filled as it answers
    const rowHTML = (c, me) => `<div class="cr wait${me ? " me" : ""}" data-c="${c.id}" style="--c:${c.c}"><span class="cn"><i class="dot"></i><a href="${pathOf(slug, c.id + "/")}">${esc(cname(c))}</a></span>` +
      `<span class="cp"><b>…</b> <span></span></span><span class="cd"><b>…</b></span><span class="cm"><b>…</b><i class="rb"><i></i></i></span></div>`;
    // One CDN that is timed only: a tile with its round trip
    const tileHTML = (c, me) => `<div class="tt wait${me ? " me" : ""}" data-c="${c.id}" style="--c:${c.c}"><a href="${pathOf(slug, c.id + "/")}"><i class="dot"></i>${esc(cname(c))}</a><b>…</b><i class="rb"><i></i></i></div>`;
    const stat = (id, k, s) => `<div class="stat"><span class="k">${esc(k)}</span><b id="${id}">–</b><span class="s" id="${id}S">${s ? esc(s) : "&nbsp;"}</span></div>`;

    // the test: the verdict with what matters in four numbers and a few lines, the site check, then every CDN (the
    // ones timed only as tiles). On a CDN's page the verdict and the numbers are that CDN's: where it serves you from,
    // how far, how long; its row comes first, and the others follow for comparison.
    const toolMain = ({ h1, intro, first }) => {
      const order = first ? [BY[first], ...CDNS.filter(c => c.id !== first)] : CDNS;
      const rows = order.filter(c => c.read).map(c => "      " + rowHTML(c, c.id === first)).join("\n");
      const tiles = order.filter(c => !c.read).map(c => "        " + tileHTML(c, c.id === first)).join("\n");
      return `    <section class="hero card${first ? " one" : ""}">
      <h1>${esc(h1)}</h1>${intro ? `\n      <p class="intro">${esc(intro)}</p>` : ""}
      <div class="verd"><div class="vline"><p class="verdict" id="verdict">${esc(T("v_wait"))}</p><button class="btn sm" id="shareBtn" type="button" aria-haspopup="dialog" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 9v4.5h10V9"/></svg><span>${esc(T("share"))}</span></button></div>
      <p class="ctl"><span>${esc(T("cond_note"))}</span><button class="lnk" id="rulesBtn" type="button" aria-haspopup="dialog" aria-controls="rules">${esc(T("cond_ctl"))}</button></p></div>
      <div class="stats">
        ${first ? stat("stPop", T("c_pop")) + stat("stDist", T("c_dist")) + stat("stMs", T("c_ms"))
          : stat("stNear", T("st_near"), T("st_near_s")) + stat("stMed", T("st_med")) + stat("stFar", T("st_far"))}
        <div class="stat you"><span class="k">${esc(T("you_k"))}<button class="lnk" id="precise" type="button">${esc(T("precise"))}</button></span><b id="you"><i class="skl"></i></b><span class="s" id="youNet">&nbsp;</span></div>
      </div>
      <ul class="finds" id="finds">${first ? `<li class="wait"><i class="skl"></i></li>` : `<li class="wait"><i class="skl"></i></li><li class="wait"><i class="skl"></i></li><li class="wait"><i class="skl"></i></li>`}</ul>
      <div class="bar">
        <div class="prog" id="prog"><i></i></div>
        <span class="prog-t" id="progTxt">&nbsp;</span>
        <button class="btn pri" id="rerun" type="button" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg><span>${esc(T("rerun"))}</span></button>
      </div>
    </section>

    <section class="site card">
      <form class="site-f" id="siteForm"><label class="site-k" for="siteIn">${esc(T("h_site"))}</label><input id="siteIn" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(T("site_ph"))}"><button class="btn pri" type="submit">${esc(T("site_go"))}</button></form>
      <p class="site-res" id="siteRes" hidden></p>
    </section>

    <section class="cdns card" aria-labelledby="cdnsT">
      <div class="cdns-h"><h2 id="cdnsT">${esc(T("h_cdns"))}</h2><span class="sub">${esc(T("cdns_sub"))}</span></div>
      <div class="cr ch"><span>${esc(T("c_cdn"))}</span><span>${esc(T("c_pop"))}</span><span>${esc(T("c_dist"))}</span><span>${esc(T("c_ms"))}</span></div>
${rows}
      <h3 class="tt-h">${esc(T("h_timed"))}</h3>
      <div class="tts">
${tiles}
      </div>
      <p class="links">${linkOut("egressLink", "egress_link")}${linkOut("speedLink", "speed_link")}${linkOut("homeLink", "home_link")}${linkOut("costLink", "cost_link")}</p>
    </section>`;
    };

    // Routing rules that send every test host one way, for a test all direct or all through the proxy: the script fills
    // the box for the route and client picked (src/app.js, ruleRemote / ruleInline)
    const rulesHTML = `<div class="scrim" id="rules" hidden>
  <div class="dialog rules" role="dialog" aria-modal="true" aria-labelledby="rulesT">
    <div class="dlg-h"><h2 id="rulesT">${esc(T("rules_h"))}</h2>
      <button class="icon-btn" data-close type="button" aria-label="${esc(T("a_close"))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
    <div class="rules-b">
      ${T("rules_intro").split(/\n+/).map(p => `<p>${esc(p)}</p>`).join("")}
      <div class="rules-f">
        <label><span>${esc(T("rules_mode"))}</span><select id="rulesMode"><option value="d">${esc(T("rules_d"))}</option><option value="p">${esc(T("rules_p"))}</option></select></label>
        <label><span>${esc(T("rules_fmt"))}</span><select id="rulesFmt"><option value="clash">Clash / Mihomo</option><option value="surge">Surge</option><option value="shadowrocket">Shadowrocket</option><option value="quanx">Quantumult X</option><option value="loon">Loon</option><option value="singbox">sing-box</option></select></label>
      </div>
      <div id="rulesBody"></div>
      <p class="m" id="rulesNote"></p>
      <p class="m">${esc(T("rules_tip"))}</p>
    </div>
  </div>
</div>
`;

    // how a CDN's location is read, and its locations by country (linked to their pages)
    const cdnArticle = c => {
      const host = new URL(c.url).host, how = !c.read ? "how_none" : c.read === "trace" ? "how_trace" : c.read.startsWith("st:") ? "how_timing" : "how_header";
      let out = `<h2>${esc(T("how_h"))}</h2><p>${esc(T(how, { cdn: cname(c), host, header: c.read ? c.read.slice(c.read.indexOf(":") + 1).replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase()) : "" }))}</p>`;
      if (c.list) {
        const all = c.id === "cfchina" ? POPS.cloudflare.filter(p => p[2] === "CN") : POPS[c.list], by = {};
        for (const p of all) (by[p[2]] = by[p[2]] || []).push(p);
        const ccs = Object.keys(by).sort((a, b) => country(a).localeCompare(country(b), lang));
        out += `<h2>${esc(T("list_h", { n: all.length, cdn: cname(c) }))}</h2>`;
        if (c.id === "cloudflare") out += `<p>${esc(T("list_cn", { n: POPS.cloudflare.filter(p => p[2] === "CN").length }))}</p>`;
        out += `<dl class="plist">` + ccs.map(cc => `<dt>${esc(country(cc))}</dt><dd>` +
          by[cc].map(p => `<a href="${popHref[c.list]}${p[0].toLowerCase()}/">${esc(p[0])}<span>${esc(p[1])}</span></a>`).join("") + `</dd>`).join("") + `</dl>`;
      }
      out += `<h2>${esc(T("more_cdns"))}</h2><p class="others">` + CDNS.filter(x => x.id !== c.id).map(x => `<a href="${pathOf(slug, x.id + "/")}">${esc(cname(x))}</a>`).join("") + `</p>`;
      return `<article class="art card">${out}</article>`;
    };

    // a location: what and where it is, the test, its nearest neighbors and the other CDNs in its country
    const popMain = (list, p) => {
      const c = BY[list], [code, city, cc, lat, lon] = p, all = POPS[list], tested = list === "cloudflare" && cc === "CN" ? "cfchina" : list;
      const near = all.filter(x => x[0] !== code).map(x => [x, km(lat, lon, x[3], x[4])]).sort((a, b) => a[1] - b[1]).slice(0, 8);
      const others = LISTS.filter(l => l !== list).flatMap(l => POPS[l].filter(x => x[2] === cc).map(x => [l, x]));
      const kmF = v => T("r_km", { km: new Intl.NumberFormat(lang).format(Math.round(v)) });
      const facts = [[T("f_code"), code], [T("f_city"), city], [T("f_country"), country(cc)], [T("f_coord"), `${lat.toFixed(2)}, ${lon.toFixed(2)}`]];
      if (list === "cloudflare") facts.push([T("f_net"), cc === "CN" ? T("pop_cn") : T("pop_global")]);
      const X = lon + 180, Y = 84 - lat;
      return `    <section class="hero card popp">
      <nav class="crumbs"><a href="${pathOf(slug)}">${esc(T("app_name"))}</a><span>/</span><a href="${pathOf(slug, tested + "/")}">${esc(cname(BY[tested]))}</a><span>/</span><span>${esc(code)}</span></nav>
      <h1>${esc(T("pop_h1", { cdn: cname(c), city, code }))}</h1>
      <p class="intro">${esc(T("pop_intro", { cdn: cname(c), n: all.length }))}</p>
      <div class="sum">
        <div class="map" style="--map:url(/assets/${F.map})"><svg viewBox="0 0 360 142" aria-hidden="true"><circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="5" class="here-ring"/><circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="2.6" fill="${c.c}"/></svg><svg id="mapo" viewBox="0 0 360 142" aria-hidden="true"></svg></div>
        <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      </div>
      <div hidden>${rowHTML(BY[tested])}</div>
      <div class="pop-test"><p class="pop-res" id="popRes">${esc(T("v_wait"))}</p><p class="pop-dist m" id="popDist">&nbsp;</p>
        <p class="you"><span class="you-k">${esc(T("you_k"))}</span><span id="you"><i class="skl"></i></span> <span class="m" id="youNet"></span><button class="lnk" id="precise" type="button">${esc(T("precise"))}</button></p></div>
    </section>

    <section class="card near">
      <h2>${esc(T("near_h", { cdn: cname(c) }))}</h2>
      <ol class="nl">${near.map(([x, dd]) => `<li><a href="${popHref[list]}${x[0].toLowerCase()}/"><b>${esc(x[0])}</b><span>${esc(x[1])}, ${esc(country(x[2]))}</span></a><i>${esc(kmF(dd))}</i></li>`).join("")}</ol>
    </section>${others.length ? `

    <section class="card near">
      <h2>${esc(T("cc_h", { country: country(cc) }))}</h2>
      <ol class="nl">${others.map(([l, x]) => `<li><a href="${popHref[l]}${x[0].toLowerCase()}/"><b>${esc(cname(BY[l]))} ${esc(x[0])}</b><span>${esc(x[1])}</span></a><i>${esc(kmF(km(lat, lon, x[3], x[4])))}</i></li>`).join("")}</ol>
    </section>` : ""}`;
    };

    // every page of this language: the test, one per CDN, one per location
    // the home page's way into the rest: every CDN's page, and the Cloudflare locations people land on most
    const homeArticle = () => {
      const cdns = CDNS.map(c => {
        const n = c.list ? (c.id === "cfchina" ? POPS.cloudflare.filter(p => p[2] === "CN").length : POPS[c.list].length) : 0;
        return `<a href="${pathOf(slug, c.id + "/")}"><i class="dot" style="--c:${c.c}"></i>${esc(cname(c))}<span>${esc(n ? T("hl_n", { n }) : c.read ? T("hl_read") : T("hl_timed"))}</span></a>`;
      }).join("");
      const pops = HOT.map(code => POPS.cloudflare.find(p => p[0] === code)).filter(Boolean)
        .map(p => `<a href="${popHref.cloudflare}${p[0].toLowerCase()}/">${esc(p[0])}<span>${esc(p[1])}</span></a>`).join("");
      return `<article class="art card hl"><h2>${esc(T("hl_cdns"))}</h2><p class="others">${cdns}</p><h2>${esc(T("hl_pops"))}</h2><p class="others pops">${pops}</p></article>`;
    };
    const pages = [{ kind: "home", dir: "", title: T("seo_title"), desc: T("seo_desc"), kw: T("seo_kw"), og: T("og_sub"), main: toolMain({ h1: T("h1") }), article: homeArticle(), faq: true }];
    for (const c of CDNS) {
      const n = c.list ? (c.id === "cfchina" ? POPS.cloudflare.filter(p => p[2] === "CN").length : POPS[c.list].length) : 0, v = { cdn: cname(c), n };
      // a CDN that doesn't say where it answers from gets a latency page: its title can't promise a location
      const k = c.read ? "" : "_timed";
      pages.push({ kind: "cdn", cdn: c.id, dir: c.id + "/", title: T("cdn_title" + k, v), desc: T(n ? "cdn_desc_list" : "cdn_desc" + k, v), kw: T("cdn_kw" + k, v),
        og: T("cdn_og" + k, v), main: toolMain({ h1: T("cdn_h1" + k, v), first: c.id }), article: cdnArticle(c) });
    }
    for (const list of LISTS) for (const p of POPS[list]) {
      const v = { cdn: cname(BY[list]), city: p[1], code: p[0], country: country(p[2]), n: POPS[list].length };
      // the China Network's locations are tested through it: from China, the global network never reaches them
      pages.push({ kind: "pop", cdn: list === "cloudflare" && p[2] === "CN" ? "cfchina" : list, pop: { code: p[0], lat: p[3], lon: p[4] }, dir: list + "/" + p[0].toLowerCase() + "/",
        title: T("pop_title", v), desc: T("pop_desc", v), kw: T("pop_kw", v), og: T("pop_desc", v), main: popMain(list, p) });
    }

    for (const pg of pages) {
      const at = sl => pathOf(sl, pg.dir), url = SITE + at(slug);
      const alts = langs.map(([l, sl]) => `<link rel="alternate" hreflang="${l}" href="${SITE + at(sl)}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${SITE + at("")}">`;
      const graph = [{ "@type": "WebApplication", name: T("app_name") + " · 1ms.dog", url, applicationCategory: "UtilitiesApplication", operatingSystem: "Any",
        browserRequirements: "Requires JavaScript", description: pg.desc, inLanguage: lang, isAccessibleForFree: true, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } }];
      if (pg.faq) graph.push({ "@type": "FAQPage", mainEntity: docs.map(x => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.t } })) });
      if (pg.kind !== "home") graph.push({ "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: T("app_name"), item: SITE + pathOf(slug) },
        { "@type": "ListItem", position: 2, name: cname(BY[pg.cdn]), item: SITE + pathOf(slug, pg.cdn + "/") },
        ...(pg.kind === "pop" ? [{ "@type": "ListItem", position: 3, name: pg.pop.code, item: url }] : []),
      ] });
      const og = `${SITE}/og/${lang.toLowerCase()}.png`;
      const head = [
        `<title>${esc(pg.title)}</title>`,
        `<meta name="description" content="${esc(pg.desc)}">`,
        `<meta name="keywords" content="${esc(pg.kw)}">`,
        ...(lang === "zh-CN" ? [`<meta http-equiv="Cache-Control" content="no-transform">`, `<meta http-equiv="Cache-Control" content="no-siteapp">`, `<meta name="applicable-device" content="pc,mobile">`] : []),
        `<meta name="robots" content="index, follow, max-image-preview:large">`,
        `<meta name="application-name" content="${esc(T("app_name"))}">`,
        `<meta name="theme-color" content="#f6f6f7" media="(prefers-color-scheme: light)">`,
        `<meta name="theme-color" content="#1c1c1c" media="(prefers-color-scheme: dark)">`,
        `<link rel="canonical" href="${url}">`, alts,
        `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">`,
        `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="1ms.dog">`,
        `<meta property="og:title" content="${esc(pg.title)}">`, `<meta property="og:description" content="${esc(pg.og)}">`, `<meta property="og:url" content="${url}">`,
        `<meta property="og:locale" content="${locale}">`,
        `<meta property="og:image" content="${og}">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
        `<meta property="og:image:alt" content="${esc(pg.title)}">`,
        `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:image" content="${og}">`,
        `<meta name="twitter:title" content="${esc(pg.title)}">`, `<meta name="twitter:description" content="${esc(pg.og)}">`,
        `<script type="application/ld+json">${json({ "@context": "https://schema.org", "@graph": graph })}</script>`,
      ].join("\n");
      const paths = Object.fromEntries(langs.map(([l, sl]) => [l, at(sl)]));
      const data = { lang, kind: pg.kind, cdn: pg.cdn || null, pop: pg.pop || null, paths, home: pathOf(slug), popHref, files: { pops: F.pops, places: F.places } };
      const html = tpl
        .replace(/(<(\w+)\b[^>]*\sdata-i="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, k, inner, close) => open + esc(T(k)) + close)
        .replace(/\{\{a:(\w+)\}\}/g, (m, k) => esc(T(k)))
        .replace("{{lang}}", lang).replace("{{pathsAttr}}", esc(JSON.stringify(paths))).replace("{{rootAttr}}", slug ? "" : " data-root")
        .replace("{{prepaint}}", PREPAINT).replace("{{head}}", head).replace("{{css}}", F.css).replace("{{js}}", F.js).replace("{{strings}}", sName)
        .replace(pg.kind !== "home" ? ` aria-current="page"` : "{{none}}", "").split("{{homeHref}}").join(pathOf(slug)).replace("{{langOpts}}", langOpts)
        .replace("{{main}}", () => pg.main).replace("{{article}}", () => pg.article || "")
        .replace("{{helpNav}}", () => helpNav).replace("{{helpC}}", () => helpC).replace("{{rules}}", () => pg.kind === "pop" ? "" : rulesHTML)
        .replace("{{data}}", () => json(data));
      if (/\{\{[\w:]+\}\}/.test(html)) throw new Error("unfilled placeholder in " + at(slug) + ": " + /\{\{[\w:]+\}\}/.exec(html)[0]);
      files[at(slug).slice(1) + "index.html"] = html;
      sitemaps[lang].push(pg.dir);
    }
  }

  // one sitemap per language (each about 500 pages, with every page's other languages), and an index of them
  const dirs = sitemaps.en;
  for (const [lang, slug] of langs) {
    files[`sitemap-${lang.toLowerCase()}.xml`] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      dirs.map(dir => `<url><loc>${SITE + pathOf(slug, dir)}</loc>` + langs.map(([l, s2]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${SITE + pathOf(s2, dir)}"/>`).join("") +
        `<xhtml:link rel="alternate" hreflang="x-default" href="${SITE + pathOf("", dir)}"/></url>`).join("\n") + "\n</urlset>\n";
  }
  files["sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    langs.map(([l]) => `  <sitemap><loc>${SITE}/sitemap-${l.toLowerCase()}.xml</loc><lastmod>${POPS.updated}</lastmod></sitemap>`).join("\n") + "\n</sitemapindex>\n";
  files["robots.txt"] = `User-agent: *\nAllow: /\nDisallow: /r/\nDisallow: /*/r/\nDisallow: /geo\nDisallow: /dns\n\nSitemap: ${SITE}/sitemap.xml\n`;
  files["llms.txt"] = `# ${en.app_name} · 1ms.dog

> Free CDN location checker in the browser: for each big CDN, which of its locations (points of presence) answers the
> visitor, how far it is from them, and the round trip, next to the least that distance allows (light in fiber,
> about 100 km per ms of round trip). Locations are read from what each CDN writes into its answers, through public
> files whose answers a page may read: Cloudflare's /cdn-cgi/trace (colo), CloudFront's Server-Timing cdn-pop or
> X-Amz-Cf-Pop, Akamai-Request-BC (city), Fastly's X-Served-By, Azure Front Door's X-Azure-Ref, Bunny's Server header,
> Wikimedia's X-Cache. Google, Alibaba Cloud, Tencent EdgeOne, Wangsu, Gcore and CDN77 don't let pages read it, so
> they are timed only. A website check finds a site's CDN from its DNS (CNAME, Cloudflare's addresses) and its
> location when readable. Nothing is sent to this site; the visitor's location comes from Cloudflare's IP geolocation
> of their request (/geo), or the browser's when they ask.

- Page: ${SITE}/ (also ${langs.slice(1).map(([, s]) => "/" + s + "/").join(", ")})
- One page per CDN: ${CDNS.map(c => SITE + "/" + c.id + "/").join(", ")}
- One page per location of Cloudflare (${POPS.cloudflare.length}, ${POPS.cloudflare.filter(p => p[2] === "CN").length} of them on the China Network), Bunny (${POPS.bunny.length}) and Wikimedia (${POPS.wikimedia.length}): ${SITE}/cloudflare/hkg/, ${SITE}/bunny/jp/, ${SITE}/wikimedia/eqsin/
- Test files: ${CDNS.map(c => `${c.id}: ${new URL(c.url).host}`).join("; ")} (Cloudflare falls back to speed.cloudflare.com, then the page's own /cdn-cgi/trace)
- Source code: https://github.com/yt1988/cdn-radar
`;
  for (const [name, text] of Object.entries(ruleSets())) files["rules/" + name] = text;
  // The only inline script is the pre-paint snippet, identical on every page: one hash covers the site. connect-src
  // is https: since the site check asks any site the visitor names.
  const csp = ["default-src 'self'", `script-src 'self' 'sha256-${sha(PREPAINT)}'`, "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:",
    "connect-src 'self' https:", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
  files["_headers"] = `# Generated by scripts/build.mjs
/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()
/assets/*
  Cache-Control: public, max-age=604800
/assets/app.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/l.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/pops.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/places.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/map.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/fonts/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/share/*
  ! Cache-Control
  Cache-Control: public, max-age=0, must-revalidate
/og/*
  Cache-Control: public, max-age=604800
/llms.txt
  Access-Control-Allow-Origin: *
  Content-Type: text/plain; charset=utf-8
/rules/*
  Access-Control-Allow-Origin: *
  Content-Type: text/plain; charset=utf-8
  Cache-Control: public, max-age=3600
`;

  await rm(pub, { recursive: true, force: true });
  await cp(new URL("static/", root), pub, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    const to = new URL(f, pub);
    await mkdir(new URL(".", to), { recursive: true });
    await writeFile(to, body);
  }
  return Object.keys(files).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now(), n = await build();
  console.log(`wrote ${n} files to public/ in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
