# CDN Radar

**English** · [简体中文](README.zh-CN.md)

Which location of each big CDN answers you, how far it is, and how long a round trip takes. [CDN Radar](https://cdn.1ms.dog) tests Cloudflare, Akamai, Amazon CloudFront, Fastly, Azure Front Door, Bunny, Wikimedia and others from your browser, puts each answer on a map, and checks any website's CDN too.

**Live:** https://cdn.1ms.dog

## What it does

- **Reads the location that answered.** Every CDN writes it into its answer, but a browser may only read what the server lets it. Each CDN is tested through a public file whose answer allows it:

  | CDN | File | Where the location is |
  |---|---|---|
  | Cloudflare | `www.cloudflare.com/cdn-cgi/trace` | the body: `colo=HKG` |
  | Cloudflare China Network | `www.cloudflare-cn.com/cdn-cgi/trace` | the same, on the data centers run with JD Cloud |
  | Amazon CloudFront | `static.figma.com` | `Server-Timing: cdn-pop;desc="NRT57-P11"` (with `Timing-Allow-Origin`) |
  | Akamai | `res-1.cdn.office.net` | `Akamai-Request-BC: …n=JP_13_TOKYO…` (a city, not a code) |
  | Fastly | `fastly.jsdelivr.net` | `X-Served-By: …-NRT` |
  | Azure Front Door | `res-2.cdn.office.net` | `X-Azure-Ref: …C1TYO…` |
  | Bunny | `fonts.bunny.net` | `Server: BunnyCDN-JP1-…` |
  | Wikimedia | `upload.wikimedia.org` | `X-Cache: cp5029 …` (5 is Singapore) |

  Google, Alibaba Cloud, Tencent EdgeOne, Wangsu, Gcore and CDN77 let no page read their location from any public file found, so they are timed only.
- **Distance and the least it allows.** Your location comes from Cloudflare's IP geolocation of your request (`/geo`), or your browser's when you ask. Light in fiber covers about 200 km per ms, so a round trip over d km can't take less than d ÷ 100 ms; a time far above twice that is a long way round. For the CDNs that publish every location (Cloudflare, Bunny, Wikimedia), it also says when you didn't get the nearest one.
- **Test only direct or only proxy.** A page can't choose the route; your proxy client does. The results reflect your network and routing rules as they are, and the dialog gives every test host as a remote rule set (`/rules/clash.yaml`, `surge.list`, `loon.list`, `quanx.list`, `singbox.json`, built with the page) for Clash / Mihomo, Surge, Shadowrocket, Quantumult X, Loon and sing-box, or as rules to paste, sent DIRECT or through the proxy.
- **Checks a website**: its CDN from its DNS (CNAME, or Cloudflare's addresses; the Worker's `/dns` asks Cloudflare's resolver, so a censored answer can't mislead it), its location when the site lets pages read it, and the round trip.
- **A page per CDN and per location**: `/cloudflare/`, `/cloudflare/hkg/`, `/bunny/jp/`… with the location's nearest neighbors and a test of whether it's the one you reach. 10 languages.
- **Shares a result** as an image or a link (`/r/…`) with the shared 1ms.dog dialog. The link has the locations and round trips; your city, its coordinates (to about 10 km) and your network only when you tick the box; never your IP address.
- **Collects nothing**: requests go from your browser to the CDNs. The Worker only answers `/geo` and the site check's `/dns` (neither stored nor logged), and gives shared links their preview title.

## How a round trip is measured

The first request to each CDN only opens the connection (DNS, TCP, TLS) and isn't counted; three more reuse it, and the median is the round trip to the edge. No cache-busting query: a CDN answers a cached file from the edge and an uncached one from its origin, which isn't what this measures; `cache: "no-store"` keeps the browser's own cache out.

`npm run verify` checks every test file: it answers without a redirect, the location is still readable (CORS and `Access-Control-Expose-Headers`, or `Timing-Allow-Origin`), and prints the fastest of three requests on a warm connection (much more than a round trip means the origin answers). GitHub Actions runs it every week.

## Self-hosting

```bash
git clone https://github.com/yt1988/cdn-radar
cd cdn-radar
npm install
npx wrangler login
npm run deploy        # builds public/ (about 4,900 pages) and deploys it with src/worker.js
```

`wrangler.toml` turns off the `*.workers.dev` and preview URLs. Bind your own domain in **Workers & Pages → cdn-radar → Settings → Domains & Routes**. It must be on Cloudflare: the visitor's location comes from the Worker's `/geo`. To build for your domain:

```bash
SITE_URL=https://cdn.example.com npm run build
SITE_URL=https://cdn.example.com node scripts/assets.mjs   # the link preview images, committed in static/og/
```

On 1ms.dog the page also gets the site's shared top bar, analytics and cross-tool theme and language sync. With a `<meta name="shortener">` on the page, share links are shortened.

## Development

```bash
npm install
npm run dev        # http://localhost:8800 (build first)
npm run build      # public/ from src/, data/ and static/ (public/ isn't committed)
npm test           # builds, then: the page contract, SEO, strings in all 10 languages, and the logic's unit tests
npm run verify     # every CDN's test file
npm run data       # refresh data/ from Cloudflare's status page, Bunny's region API and OurAirports
npm run assets     # the link preview images (Windows system fonts)
```

On 1ms.dog, every push to `main` deploys (Cloudflare Workers Builds runs `npm ci && npm test`, then `npx wrangler deploy`).

```
src/page.html        page template
src/app.js           browser: timing, reading locations, map, verdict, site check, share
src/probe.mjs        one request, timed; reading a location from an answer; DNS over HTTPS
src/cdns.mjs         the CDNs, their test files and how each writes its location; CNAMEs for the site check
src/lib.mjs          distances, the verdict, results in links (unit-tested)
src/worker.js        /geo, /dns, and shared results (/r/…) with their preview title
src/i18n/*.mjs       strings in 10 languages; every language has every key (tested)
data/pops.json       every location of Cloudflare, Bunny and Wikimedia (npm run data)
data/places.json     where IATA codes, metro codes and cities are (OurAirports, public domain)
static/              fonts, logos, the 1ms.dog share dialog (copied from 1ms-shell), icons, og/ images
scripts/build.mjs    public/: pages per language, CDN and location; sitemaps; robots, llms.txt, _headers
```

### Changing a CDN's test file

- The answer must come from the edge (a cached file, or one the edge writes itself), without a redirect, and be small.
- For a location: CORS with the header in `Access-Control-Expose-Headers`, or `Timing-Allow-Origin` with the location in `Server-Timing`. Check from a few networks: some sites send a different CDN by region (`res.cdn.office.net` is Akamai or Azure; `res-1` is always Akamai, `res-2` always Azure).
- Run `npm run verify` and add a sample of the new header to `test/lib.test.mjs`.

<!-- 1ms-repos: generated by 1ms-shell scripts/repos.mjs; edit sites.js or the script there, not here -->
## More from 1ms.dog

Free, open-source network tools from [1ms.dog](https://1ms.dog).

**Speed & connectivity**

| Tool | What it answers | Source |
|---|---|---|
| [1ms.dog](https://1ms.dog) | Where your traffic exits, and how far the services you use are | [1ms.dog](https://github.com/yt1988/1ms.dog) |
| [Network X-Ray](https://check.1ms.dog) | Eight of these tests in one run, one grade | [connection-checkup](https://github.com/yt1988/connection-checkup) |
| [Speed Test](https://speed.1ms.dog) | Download, upload, ping and bufferbloat | [speed-test](https://github.com/yt1988/speed-test) |
| [DNS Test](https://dns.1ms.dog) | Which public DNS is fastest from your network | [dns-test](https://github.com/yt1988/dns-test) |
| [IPv6 Test](https://ipv6.1ms.dog) | Whether your network really supports IPv6, scored out of 10 | [ipv6-test](https://github.com/yt1988/ipv6-test) |

**IP & privacy**

| Tool | What it answers | Source |
|---|---|---|
| [EgressLens](https://egress.1ms.dog) | Every exit IP your traffic uses, and which sites see which | [egresslens](https://github.com/yt1988/egresslens) |
| [IP Quality Test](https://ipqs.1ms.dog) | How clean your IP is, scored 0–100 from a dozen sources | [ip-quality-test](https://github.com/yt1988/ip-quality-test) |
| [Who Are You](https://who.1ms.dog) | What any website can tell about you without asking | [who-are-you](https://github.com/yt1988/who-are-you) |
| [ASN Lookup](https://asn.1ms.dog) | Who owns an IP, and the prefixes and peers of every AS | [asn-lookup](https://github.com/yt1988/asn-lookup) |
| [Streaming & AI Unlock Check](https://unlock.1ms.dog) | Which streaming and AI services work on your IP | [unlock-check](https://github.com/yt1988/unlock-check) |

**Cloud & costs**

| Tool | What it answers | Source |
|---|---|---|
| [Me2Cloud](https://m2c.1ms.dog) | Latency, jitter and loss to every region of the big clouds | [me2cloud](https://github.com/yt1988/me2cloud) |
| [Lightsail Cost Saver](https://ls.1ms.dog) | Forecast Lightsail transfer overage, and the cheapest way to add more | [lightsail-cost-saver](https://github.com/yt1988/lightsail-cost-saver) |
| [Cloud Cost Planner](https://cost.1ms.dog) | The cheapest VPS, storage and CDN setup for your traffic | [cloud-cost-planner](https://github.com/yt1988/cloud-cost-planner) |

**Command line**

| Tool | What it answers | Source |
|---|---|---|
| [`httpslatency`](https://github.com/yt1988/https-latency-test-cli) | 1ms.dog's latency test, run from a server or router | [https-latency-test-cli](https://github.com/yt1988/https-latency-test-cli) |
| [`vps2cloud`](https://github.com/yt1988/vps2cloud) | Me2Cloud from a server: latency to every region of the big clouds | [vps2cloud](https://github.com/yt1988/vps2cloud) |
| [`dnstest`](https://github.com/yt1988/dns-test-cli) | DNS Test from a server, over UDP, TCP, DoT, DoH and DoQ | [dns-test-cli](https://github.com/yt1988/dns-test-cli) |
<!-- /1ms-repos -->

## License

[MIT](LICENSE). The shiba illustration and the 1ms.dog logo are the project's brand: if you run a public copy under another name, use your own. Map data: Natural Earth via world-atlas; airports: OurAirports (public domain).
