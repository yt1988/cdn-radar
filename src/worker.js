// The CDN Radar Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
//   /dns?name=<host>      the site check's DNS, asked from the edge (Cloudflare's resolver): { cnames, ips }
//   /geo                  where Cloudflare places the visitor (its IP geolocation of this request): the page's
//                         distances start there. Never stored or logged; not cached.
//   /r/<code>, /<lang>/r/<code>   a shared result: that language's page with the locations in its title (what chat
//                         apps show as the link's preview), not indexed; the page itself reads the code and shows the
//                         result (src/lib.mjs)
//   anything else         a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it

import { BY, nameOf } from "./cdns.mjs";
import { decode, sharePath } from "./lib.mjs";
import en from "./i18n/en.mjs";
import zhCN from "./i18n/zh-CN.mjs";
import zhTW from "./i18n/zh-TW.mjs";
import ja from "./i18n/ja.mjs";
import ko from "./i18n/ko.mjs";
import es from "./i18n/es.mjs";
import fr from "./i18n/fr.mjs";
import de from "./i18n/de.mjs";
import pt from "./i18n/pt.mjs";
import ru from "./i18n/ru.mjs";

// each language's strings by its folder ("" is English, at the root), and its language code
const STR = { "": [en, "en"], "zh-cn": [zhCN, "zh-CN"], "zh-tw": [zhTW, "zh-TW"], ja: [ja, "ja"], ko: [ko, "ko"], es: [es, "es"], fr: [fr, "fr"], de: [de, "de"], pt: [pt, "pt"], ru: [ru, "ru"] };
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });
    if (url.pathname === "/geo") return geo(req);
    if (url.pathname === "/dns") return dns(url);
    const sp = sharePath(url.pathname);
    if (sp && sp.slug in STR && env.ASSETS) return shared(req, env, url, sp);
    return new Response(req.method === "HEAD" ? null : "Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
    });
  },
};

function geo(req) {
  const cf = req.cf || {}, n = v => v == null || v === "" ? null : +v;
  const body = { cc: cf.country || null, city: cf.city || null, region: cf.region || null, lat: n(cf.latitude), lon: n(cf.longitude),
    asn: cf.asn || null, org: cf.asOrganization || null, colo: cf.colo || null };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
    "x-robots-tag": "noindex" } });
}

// A site's DNS for the site check, asked from the edge: { cnames, ips }. Cloudflare's resolver, so the answer isn't a
// local resolver's (nor a censor's); cached five minutes, nothing kept.
async function dns(url) {
  const name = (url.searchParams.get("name") || "").toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(name)) return new Response("Bad name\n", { status: 400 });
  let ans;
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`, { headers: { accept: "application/dns-json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    ans = (await r.json()).Answer || [];
  } catch (e) { return new Response("DNS failed\n", { status: 502 }); }
  const body = { cnames: [...new Set(ans.filter(a => a.type === 5).map(a => String(a.data).replace(/\.$/, "")))], ips: [...new Set(ans.filter(a => a.type === 1).map(a => a.data))] };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
}

// A shared result: the language's page as it is, with the title, description and their Open Graph and Twitter copies
// naming the locations that answered. A code this page can't read goes to the language's page instead.
async function shared(req, env, url, { slug, code }) {
  const home = "/" + (slug ? slug + "/" : "");
  const r = decode(code);
  if (!r) return Response.redirect(new URL(home, url).toString(), 302);
  const [S, lang] = STR[slug];
  // the three fastest that said where they were: "Cloudflare HKG 38 ms · Akamai Tokyo 12 ms …"
  const top = r.rows.filter(x => x.ms != null && x.code).sort((a, b) => a.ms - b.ms).slice(0, 3)
    .map(x => `${BY[x.id].short || nameOf(BY[x.id], lang)} ${x.id === "akamai" ? x.code.split("-")[1].charAt(0) + x.code.split("-")[1].slice(1).toLowerCase() : x.code} ${fill(S.r_ms, { ms: Math.round(x.ms) })}`);
  // a site check leads: "www.example.com · Amazon CloudFront NRT 61 ms"
  const sc = r.site && (BY[r.site.cdn] ? nameOf(BY[r.site.cdn], lang) : r.site.cdn);
  const sum = r.site ? [r.site.host, [sc, r.site.code].filter(Boolean).join(" "), r.site.ms != null ? fill(S.r_ms, { ms: Math.round(r.site.ms) }) : ""].filter(Boolean).join(" · ") : top.join(" · ");
  const title = fill(S.share_title, { summary: sum || S.app_name });
  const desc = (r.site && top.length ? top.join(" · ") + " · " : "") + S.share_desc;
  const page = await env.ASSETS.fetch(new Request(new URL(home, url), { headers: req.headers }));
  if (!page.ok) return page;
  const attr = (val, name = "content") => ({ element: e => e.setAttribute(name, val) });
  const out = new HTMLRewriter()
    .on("title", { element: e => e.setInnerContent(title) })
    .on('meta[name="description"]', attr(desc))
    .on('meta[property="og:title"]', attr(title)).on('meta[name="twitter:title"]', attr(title))
    .on('meta[property="og:description"]', attr(desc)).on('meta[name="twitter:description"]', attr(desc))
    .on('meta[property="og:url"]', attr(url.origin + url.pathname))
    .on('meta[name="robots"]', attr("noindex, follow"))
    .transform(page);
  const h = new Headers(out.headers);
  h.delete("etag");
  h.set("cache-control", "public, max-age=3600");
  h.set("x-robots-tag", "noindex");
  return new Response(req.method === "HEAD" ? null : out.body, { status: 200, headers: h });
}
