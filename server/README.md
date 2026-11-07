# CDN Radar's server jobs

Two optional scheduled jobs. They feed the page's "seen from Tokyo" section and its ISP table (on 1ms.dog they run in
Tokyo). They open no ports. Their results go to a directory (`OUT`, `<data-dir>` below) that any static file server
publishes read-only. The site's Worker fetches them from `DATA_URL` in `src/worker.js` and passes them to the page as
`/tokyo` and `/ecs`. The server needs no Cloudflare token. Without these jobs the page works as before, just without
those two sections.

| Job | Suggested schedule | What | Output |
|---|---|---|---|
| `watch.mjs` | Every 10 minutes | Runs the page's own test from the server, over IPv4 and IPv6, and records which location of each CDN answers and the round trip to it. | `watch/days/<date>.json` (kept 400 days); `watch/summary.json` (the last run, the last 30 days, the last 50 location changes) |
| `ecs.mjs` | Daily | Asks CloudFront's own name servers for the test host, once per big ISP. Each query carries one of that ISP's /24s as the client subnet (`data/ecs-nets.json`). Then it asks each edge address it got which location it is, with one HTTPS request using the host's name. Akamai answers every subnet alike to a resolver it doesn't list, so it's left out. | `ecs/latest.json`; `ecs/days/<date>.json` |

- Both jobs read each CDN's location with the page's own rules (`src/cdns.mjs`), so the server and the browser can't
  disagree on what an answer says.
- `ecs` walks the CNAMEs and delegations itself over UDP 53, with the client subnet on every query. It sends at most
  10 queries a second. A public resolver can't be used here: it caches, and may rewrite or drop the subnet.
- `data/ecs-nets.json` comes from `npm run ecs-nets` (RIPEstat). For each ISP it picks the /24 in the middle of the
  largest prefix the ISP announces. It is one typical block per ISP, not every region the ISP covers.
- `watch/days/` is the only data that can't be rebuilt. Back it up. After restoring it, run `watch` once to rebuild
  `summary.json`.

## Install (as root)

Needs Node 20 or later (the runtime only, no npm), a plain system user `<user>`, and outbound TCP 443 (plus UDP 53
for `ecs`).

```
/opt/<app>/src/cdns.mjs        from src/cdns.mjs
/opt/<app>/server/*.mjs        from server/
/opt/<app>/data/ecs-nets.json  from data/
/opt/<app>/package.json        {"type":"module"}
<data-dir>                     owned by <user>
/etc/systemd/system/*.service, *.timer   from server/, with the user and paths changed to yours
systemctl daemon-reload && systemctl enable --now <the two timers>
```

The unit files in this folder are the ones 1ms.dog uses, so their names, user and paths are 1ms.dog's. They cap
memory at 80 MB, let the job write only its output directory, and send standard output nowhere (errors go to the
journal).

## Check

```
systemd-run --wait --collect -p User=<user> -p MemoryMax=80M -p WorkingDirectory=/opt/<app> -E OUT=<data-dir> -p ReadWritePaths=<data-dir> -p ProtectSystem=strict /usr/bin/node /opt/<app>/server/watch.mjs
curl -s <data-url>/watch/summary.json | head -c 300
curl -s 'https://<your-domain>/tokyo?cdn=cloudflare'
```

`systemd-run` prints the memory peak when the job ends. Measured: about 19 MB for `watch`, about 46 MB for `ecs`.

Privacy: neither job touches visitor data. Both measure only from the server to the CDNs and their name servers.
