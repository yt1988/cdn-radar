#!/usr/bin/env node
// Refreshes the location data in data/ from public sources. Run by hand (every few months, or when a CDN opens new
// locations) and commit the output; the build only reads data/.
//   data/pops.json   the CDNs whose full location list is public: Cloudflare (its status page, 345+ data centers, the
//                    China Network's marked), Bunny (its region API) and Wikimedia (its seven data centers)
//   data/places.json where a code or a city is: IATA airport codes (OurAirports, public domain), the metro codes some
//                    CDNs use (TYO, SEL…), and city names by country (what Akamai reports)
// Usage: node scripts/data.mjs
import { writeFile, mkdir } from "node:fs/promises";

const out = new URL("../data/", import.meta.url);
const get = async (u, type = "json") => {
  const r = await fetch(u, { headers: { "user-agent": "cdn-radar data refresh (+https://github.com/yt1988/cdn-radar)" } });
  if (!r.ok) throw new Error(u + ": HTTP " + r.status);
  return type === "json" ? r.json() : r.text();
};
const r2 = n => Math.round(n * 100) / 100, r1 = n => Math.round(n * 10) / 10;

// OurAirports: one row per airport. The ones with an IATA code and scheduled service, big ones first, so a code or a
// city name lands on its main airport.
function csv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };
const airports = csv(await get("https://davidmegginson.github.io/ourairports-data/airports.csv", "text"))
  .filter(a => /^[A-Z]{3}$/.test(a.iata_code) && a.type in RANK)
  .sort((a, b) => RANK[a.type] - RANK[b.type] || (b.scheduled_service === "yes") - (a.scheduled_service === "yes"));
// Only airports with scheduled flights go to the page (a CDN's location is a city with one); the rest still place
// Cloudflare's list here. Coordinates to 0.1° (about 10 km): enough for a distance, and half the size.
const ALL = {}, IATA = {};
for (const a of airports) {
  if (ALL[a.iata_code]) continue;
  ALL[a.iata_code] = [r2(+a.latitude_deg), r2(+a.longitude_deg), a.iso_country, a.municipality || a.name];
  if (a.type !== "small_airport" && a.scheduled_service === "yes") IATA[a.iata_code] = [r1(+a.latitude_deg), r1(+a.longitude_deg), a.iso_country, a.municipality || a.name];
}
// Codes some CDNs still use for places OurAirports has closed or lacks
const EXTRA = { TXL: [52.52, 13.4, "DE", "Berlin"], QWJ: [-22.74, -47.33, "BR", "Americana"], KIV: [47.01, 28.86, "MD", "Chișinău"],
  ZDM: [31.9, 35.2, "PS", "Ramallah"], JXG: [30.75, 120.76, "CN", "Jiaxing"], FRU: [42.87, 74.59, "KG", "Bishkek"] };
for (const [k, v] of Object.entries(EXTRA)) { ALL[k] = ALL[k] || v; IATA[k] = IATA[k] || v; }

// Metro codes (IATA city codes for places with several airports): Azure Front Door names its edges by them
const METRO = {
  TYO: ["NRT", "Tokyo"], OSA: ["KIX", "Osaka"], SEL: ["ICN", "Seoul"], BJS: ["PEK", "Beijing"], SHA: ["PVG", "Shanghai"],
  LON: ["LHR", "London"], PAR: ["CDG", "Paris"], MIL: ["MXP", "Milan"], ROM: ["FCO", "Rome"], STO: ["ARN", "Stockholm"],
  MOW: ["SVO", "Moscow"], BER: ["BER", "Berlin"], NYC: ["JFK", "New York"], CHI: ["ORD", "Chicago"], WAS: ["IAD", "Washington"],
  YTO: ["YYZ", "Toronto"], YMQ: ["YUL", "Montreal"], SAO: ["GRU", "São Paulo"], RIO: ["GIG", "Rio de Janeiro"],
  BUE: ["EZE", "Buenos Aires"], JKT: ["CGK", "Jakarta"], BKK: ["BKK", "Bangkok"],
};
for (const [m, [ap, city]] of Object.entries(METRO)) if (ALL[ap]) IATA[m] = [r1(ALL[ap][0]), r1(ALL[ap][1]), ALL[ap][2], city];

// City names by country, written the way Akamai does (upper case, no spaces or punctuation): "JP" + "TOKYO"
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
const CITY = {};
for (const a of airports) {
  if (a.type === "small_airport" || a.scheduled_service !== "yes" || !a.municipality) continue;
  // the whole name, and its first word for names Akamai shortens ("Frankfurt am Main" → FRANKFURT)
  for (const name of a.municipality.split(/[/,(]/)) for (const k of [norm(name), norm(name.trim().split(/[\s-]+/)[0])]) {
    if (k.length > 2 && !CITY[a.iso_country + ":" + k]) CITY[a.iso_country + ":" + k] = [r1(+a.latitude_deg), r1(+a.longitude_deg), name.trim()];
  }
}

// Cloudflare: every data center on the status page, "City, Country - (IATA)", grouped by region; the China Network's
// are the ones whose country is China
const comp = (await get("https://www.cloudflarestatus.com/api/v2/components.json")).components;
const cloudflare = [];
for (const c of comp) {
  const m = /^(.+?)\s+-\s+\(([A-Z]{3})\)$/.exec(c.name);
  if (!m) continue;
  const [, place, code] = m, parts = place.split(",").map(s => s.trim());
  const city = parts[0], at = ALL[code];
  if (!at) { console.warn("cloudflare: no place for " + code + " (" + place + ")"); continue; }
  // the status page's city wins over the airport's (SJW is Hengshui, not Shijiazhuang); its coordinates are the
  // airport's unless the city is known on its own
  const own = CITY[at[2] + ":" + norm(city)];
  cloudflare.push([code, city, at[2], ...(own && code !== "TXL" ? own.slice(0, 2) : at.slice(0, 2))]);
}
cloudflare.sort((a, b) => a[0].localeCompare(b[0]));

// Bunny: its region API, with coordinates. Its edges name themselves by RegionCode plus a number (BunnyCDN-JP1-1195)
const bunny = (await get("https://api.bunny.net/region")).map(r => {
  const city = r.Name.replace(/^[^:]+:\s*/, "").replace(/,\s*[^,]+$/, "").trim();
  return [r.RegionCode, city, r.CountryCode, r2(r.Latitude), r2(r.Longitude)];
}).sort((a, b) => a[0].localeCompare(b[0]));

// Wikimedia: seven data centers, by their own names; a cache host's first digit says which (cp5029: 5, eqsin)
const wikimedia = [
  ["eqiad", "Ashburn", "US", 39.04, -77.49], ["codfw", "Dallas", "US", 32.9, -97.04], ["esams", "Amsterdam", "NL", 52.31, 4.76],
  ["ulsfo", "San Francisco", "US", 37.62, -122.38], ["eqsin", "Singapore", "SG", 1.36, 103.99], ["drmrs", "Marseille", "FR", 43.44, 5.22],
  ["magru", "São Paulo", "BR", -23.43, -46.47],
];

await mkdir(out, { recursive: true });
await writeFile(new URL("pops.json", out), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), cloudflare, bunny, wikimedia }) + "\n");
await writeFile(new URL("places.json", out), JSON.stringify({ iata: IATA, city: CITY }) + "\n");
console.log(`cloudflare ${cloudflare.length} (China ${cloudflare.filter(x => x[2] === "CN").length}), bunny ${bunny.length}, wikimedia ${wikimedia.length}; ` +
  `places: ${Object.keys(IATA).length} codes, ${Object.keys(CITY).length} cities`);
