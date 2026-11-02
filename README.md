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
- **Direct (D) or proxy (P), row by row.** Behind a rule-based proxy some CDNs are reached from your own line and others through the proxy, which changes both the location and the round trip. The page finds your exits (the address a mainland-China site, IPIP, sees; the one this site sees, from the 1ms.dog shell's `/_ms/me` or the Worker's `/geo`; the ones Cloudflare's traces see; each placed by Cloudflare or ip.sb, and a proxy by the Cloudflare location it reaches) and marks each CDN with the exit it took: named by its trace, its location far nearer one exit, a round trip too short for any proxy, or inferred from the mainland-China direct list of common rules (geosite:cn). Ones it can't tell get "?" and stay out of the verdict. "Test only direct or only proxy" gives rules (Clash / mihomo, Surge, Quantumult X) that send every test host one way.
- **Distance and the least it allows.** Each distance starts at the exit the row took: your place (or your browser's, when you ask) for direct, the proxy's for proxy. Light in fiber covers about 200 km per ms, so a round trip over d km can't take less than d ÷ 100 ms; a time far above twice that is a long way round. For the CDNs that publish every location (Cloudflare, Bunny, Wikimedia), it also says when you didn't get the nearest one.
- **Checks a website**: its CDN from its DNS (CNAME, or Cloudflare's addresses; the Worker's `/dns` asks Cloudflare's resolver, so a censored answer can't mislead it), its location when the site lets pages read it, and the round trip.
- **A page per CDN and per location**: `/cloudflare/`, `/cloudflare/hkg/`, `/bunny/jp/`… with the location's nearest neighbors and a test of whether it's the one you reach. 10 languages.
- **Shares a result** as an image or a link (`/r/…`) with the shared 1ms.dog dialog. The link has the locations, round trips and each row's exit (the letter only); your city (and your proxies' places, for their rows' distances), its coordinates (to about 10 km) and your network only when you tick the box; never your IP address.
- **Collects nothing**: requests go from your browser to the CDNs, IPIP, and ip.sb (which gets your exits' addresses to place them). The Worker only answers `/geo` and the site check's `/dns` (neither stored nor logged), and gives shared links their preview title.

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

## License

[MIT](LICENSE). The shiba illustration and the 1ms.dog logo are the project's brand: if you run a public copy under another name, use your own. Map data: Natural Earth via world-atlas; airports: OurAirports (public domain).
