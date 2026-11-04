# CDN Radar's jobs on 1ms.dog's Tokyo server

Two scheduled jobs that run on the 1ms.dog server in Tokyo. They open no ports. Their results go to
`/srv/1ms-data/cdn/`, which the server publishes read-only at `https://data.1ms.dog:2083/cdn/`. The site's Worker
fetches them and passes them to the page as `/tokyo` and `/ecs`. The server holds no Cloudflare token. Ports,
directories and the user follow the allocation in 1ms-shell `docs/processes.md`.

| Service | When | What | Output |
|---|---|---|---|
| `1ms-cdn-watch` | Every 10 minutes, at minute 4 | The page's own test from Tokyo, over IPv4 and IPv6. It records which location of each CDN answers and the round trip to it. | `watch/days/<date>.json` (kept 400 days); `watch/summary.json` (the last run, the last 30 days, the last 50 location changes) |
| `1ms-cdn-ecs` | Daily, 04:20 UTC | Asks CloudFront's own name servers (Akamai answers every subnet alike to a resolver it doesn't list, so it's left out) for the test host, once per big ISP. Each query carries one of that ISP's /24s as the client subnet (`data/ecs-nets.json`). Then it asks each edge address it got which location it is: one HTTPS request with the host's name. | `ecs/latest.json`; `ecs/days/<date>.json` |

- Both jobs read each CDN's location with the page's own rules (`src/cdns.mjs`), so the server and the browser can't
  disagree on what an answer says.
- `ecs` walks the CNAMEs and delegations itself over UDP 53, with the client subnet on every query. It sends at most
  10 queries a second. A public resolver can't be used here: it caches, and may rewrite or drop the subnet.
- `data/ecs-nets.json` comes from `npm run ecs-nets` (RIPEstat). For each ISP it picks the /24 in the middle of the
  largest prefix the ISP announces. It is one typical block per ISP, not every region the ISP covers.

## Install (as root; the user, directories and nodejs are Public's)

```
/opt/1ms/cdn/src/cdns.mjs        from src/cdns.mjs
/opt/1ms/cdn/server/*.mjs        from server/
/opt/1ms/cdn/data/ecs-nets.json  from data/
/opt/1ms/cdn/package.json        {"type":"module"}
/etc/systemd/system/1ms-cdn-{watch,ecs}.{service,timer}
systemctl daemon-reload && systemctl enable --now 1ms-cdn-watch.timer 1ms-cdn-ecs.timer
```

## Check

```
systemctl list-timers '1ms-cdn*'
systemctl start 1ms-cdn-watch && systemctl show -p MemoryPeak 1ms-cdn-watch
curl -s https://data.1ms.dog:2083/cdn/watch/summary.json | head -c 300
curl -s 'https://cdn.1ms.dog/tokyo?cdn=cloudflare'
```

Privacy: neither job touches visitor data. Both measure only from this server to the CDNs and their name servers.
