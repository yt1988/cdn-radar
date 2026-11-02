#!/usr/bin/env node
// Renders the link-preview images with resvg (dev dependency), 1200 × 630: static/og/<lang>.png for each language.
// Run when the headline, the subtitle or the CDN names change, and commit the output. Uses system fonts for the text
// (Windows: Segoe UI, Microsoft YaHei, Microsoft JhengHei, Yu Gothic UI, Malgun Gothic, Consolas), as the other
// 1ms.dog tools' scripts do. The picture is the world's land (the page's map) with a few edges answering.
// Usage: node scripts/assets.mjs
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { feature } from "topojson-client";
import { geoEquirectangular, geoPath } from "d3-geo";

const root = new URL("../", import.meta.url), out = new URL("static/og/", root), src = new URL("src/", root);
const HOST = new URL(process.env.SITE_URL || "https://cdn.1ms.dog").host;
const FONTS = { "zh-CN": "Microsoft YaHei", "zh-TW": "Microsoft JhengHei", ja: "Yu Gothic UI", ko: "Malgun Gothic" };
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const render = svg => new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" } }).render().asPng();

// the map: 548 × 216 in the right-hand card
const topo = JSON.parse(await readFile(new URL("node_modules/world-atlas/land-110m.json", root), "utf8"));
const MW = 540, MH = MW * 142 / 360, MX = 626, MY = 176, k = MW / 360;
const land = geoPath(geoEquirectangular().scale(180 / Math.PI * k).translate([MX + 180 * k, MY + 84 * k]).precision(.3)).digits(1)(feature(topo, topo.objects.land));
const at = (lat, lon) => [MX + (lon + 180) * k, MY + (84 - lat) * k];
// a visitor in Beijing and where five CDNs might answer
const ME = at(39.9, 116.4);
const EDGES = [["#f38020", 33.9, -118.4], ["#0096d6", 35.6, 139.8], ["#ff282d", 22.3, 114.2], ["#8c4fff", 37.5, 126.5], ["#9a9a9a", 1.36, 103.9]];
const arcs = EDGES.map(([c, lat, lon]) => {
  const p = at(lat, lon), mx = (ME[0] + p[0]) / 2, my = (ME[1] + p[1]) / 2 - Math.min(60, Math.hypot(p[0] - ME[0], p[1] - ME[1]) / 4);
  return `<path d="M${ME[0].toFixed(1)} ${ME[1].toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>` +
    `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="7" fill="${c}" stroke="#232323" stroke-width="2"/>`;
}).join("");

async function card(lang, d) {
  const ff = `${FONTS[lang] ? `'${FONTS[lang]}', ` : ""}'Segoe UI', 'Microsoft YaHei', sans-serif`;
  const logo = Buffer.from(await readFile(new URL("static/assets/logo-dark.svg", root))).toString("base64");
  // headline and subtitle fit the left column (480 px): wrapped by estimated width, wide characters counting double
  const wide = ch => /[　-鿿가-힯＀-￯]/.test(ch), est = (t, px) => [...t].reduce((a, ch) => a + (wide(ch) ? 1 : .56) * px, 0);
  const wrap = (text, px, max = 480) => {
    const out = [];
    let cur = "";
    for (const word of text.split(/(?<=[ ，、？?,：:])/)) {
      for (const piece of est(word, px) > max ? [...word] : [word]) {
        if (cur && est(cur + piece, px) > max) { out.push(cur.trim()); cur = ""; }
        cur += piece;
      }
    }
    return [...out, cur.trim()];
  };
  let size = 56, lines;
  for (; (lines = wrap(d.h1, size)).length > 2 && size > 40; size -= 4);
  const subs = wrap(d.og_sub, 25).slice(0, 3);
  const top = 222 - (lines.length - 1) * 26;
  const head = lines.map((l, i) => `<text x="72" y="${top + i * (size + 12)}" font-size="${size}" font-weight="700" fill="#ededed">${esc(l)}</text>`).join("");
  const subY = top + (lines.length - 1) * (size + 12) + 56;
  const subText = subs.map((l, i) => `<text x="72" y="${subY + i * 36}" font-size="25" fill="#a0a0a0">${esc(l)}</text>`).join("");
  const barY = subY + (subs.length - 1) * 36 + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${ff}">
<rect width="1200" height="630" fill="#1c1c1c"/>
<rect x="606" y="150" width="580" height="330" rx="20" fill="#232323" stroke="#363636"/>
<clipPath id="m"><rect x="${MX}" y="${MY}" width="${MW}" height="${MH.toFixed(1)}"/></clipPath>
<g clip-path="url(#m)"><path d="${land}" fill="#4a4a4a"/></g>
${arcs}
<circle cx="${ME[0].toFixed(1)}" cy="${ME[1].toFixed(1)}" r="13" fill="none" stroke="#ededed" stroke-width="2" opacity=".6"/>
<circle cx="${ME[0].toFixed(1)}" cy="${ME[1].toFixed(1)}" r="7" fill="#ededed"/>
<image x="72" y="56" width="180" height="72" href="data:image/svg+xml;base64,${logo}"/>
${head}
${subText}
<rect x="72" y="${barY}" width="120" height="6" rx="3" fill="#38bdf8"/>
<text x="72" y="574" font-size="26" font-weight="600" fill="#38bdf8">${HOST}</text>
<text x="1128" y="574" font-size="21" fill="#a0a0a0" text-anchor="end">Cloudflare · Akamai · CloudFront · Fastly · Azure</text>
</svg>`;
}

await mkdir(out, { recursive: true });
for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs"))) {
  const lang = f.slice(0, -4), d = (await import(new URL("i18n/" + f, src).href)).default;
  const png = render(await card(lang, d));
  await writeFile(new URL(`${lang.toLowerCase()}.png`, out), png);
  console.log(`og/${lang.toLowerCase()}.png ${Math.round(png.length / 1024)} KB`);
}
