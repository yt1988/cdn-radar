# AGENTS.md

写给在这个仓库里干活的人和 AI 代理（Claude Code、Codex、Cursor 等都适用）。如果有 `CLAUDE.md`，它只指向这里。

## 这是什么

CDN 雷达（[cdn.1ms.dog](https://cdn.1ms.dog)）：在浏览器里测出各家大 CDN（Cloudflare、Akamai、CloudFront、Fastly、Azure Front Door、Bunny、Wikimedia 等）把访客分到了哪个节点、离访客多远、延迟多少；也能查任意网站用的是哪家 CDN、哪个节点。10 种语言，每家 CDN、每个公开节点都有自己的页面。

- 页面是静态的，由 `scripts/build.mjs` 从 `src/`、`data/`、`static/` 生成到 `public/`（不提交）。
- `src/worker.js` 是 Cloudflare Worker，只处理静态文件以外的路径：`/geo`、`/dns`、`/places`、`/tokyo`、`/ecs`、分享链接 `/r/…`。每个路径的作用写在文件开头。
- 读出节点的规则全在 `src/cdns.mjs`。页面、Worker 和服务器上的定时任务都用这一份，不要另写一套。
- 设计上定下来的规则、否决过的方案，见 [docs/decisions.md](docs/decisions.md)。改界面、改文案、改测法之前先读它。
- 1ms.dog 的运营说明（导航条、统计、分享组件、VPS 全局配置、账号和维护者）在私有仓库 1ms-shell。这个仓库只管 CDN 雷达自己。

## 目录

| 路径 | 内容 |
|---|---|
| `src/app.js` | 页面脚本：测量、结论、表格、分享卡片 |
| `src/probe.mjs` | 浏览器里测一家 CDN：第一次请求只建连接，不计时；之后 3 次计时取中位数 |
| `src/lib.mjs` | 页面和 Worker 共用的纯逻辑：距离、结论（`summary`）、远节点归因（`blame`）、分享链接编码 |
| `src/i18n/*.mjs` | 10 种语言的文字，每种语言的键和占位符必须一致（测试会查） |
| `src/page.html`、`style.css`、`base.css`、`fonts.css` | 页面模板和样式（样式在构建时内联进每个页面） |
| `data/pops.json`、`data/places.json` | 公开节点列表和地名，由 `npm run data` 生成 |
| `data/ecs-nets.json` | 各地主要运营商的代表网段，由 `npm run ecs-nets` 生成，给服务器任务用 |
| `server/` | VPS 上的两个定时任务和它们的 systemd unit，见下文 |
| `static/` | 原样复制的文件：字体、图标、预览图、公共分享组件 `assets/share/`（来自 1ms-shell，不要在这里改） |

## 本地运行

需要 Node 20 以上。

```
npm install
npm run build      # 生成 public/
npm run dev        # wrangler dev，http://127.0.0.1:8800
```

- 本地页面能测各家 CDN，但下面两样只有部署在 1ms.dog 上才有，本地不出现不算故障：
  - 「你的 DNS 服务器」那一行和远节点的原因行（要用 1ms.dog 自己的 DNS 服务器）；
  - 「从东京看」和运营商调度表（要用 VPS 上的数据）。
- `wrangler dev` 重新构建后可能还在用旧的文件清单，带哈希的新文件会 404。重新构建后要重启它。

## 测试：按改动范围选

| 改了什么 | 跑什么 |
|---|---|
| 任何改动，提交前 | `npm test`（先构建，再跑 `test/*.test.mjs`：语言键和占位符、页面契约和 SEO、Worker 路由、结论逻辑） |
| 文字 | 另外核对 10 种语言都改了。写法和统一译法见 1ms-shell 的 `docs/translation.md` |
| `src/cdns.mjs` 里的测试文件或读取规则 | `npm run verify`：从你所在的网络检查每个测试文件仍能访问、仍能读出节点 |
| 节点列表、地名 | `npm run data`，提交 `data/` |
| 预览图的标题或 CDN 名单 | `npm run assets`，提交 `static/og/` |
| 页面布局或文字（上线后） | 在 1ms-shell 目录里跑 `npm run check -- cdn` 和 `npm run mobile -- cdn`（手机宽度，中文和俄语） |
| `server/` | 在服务器上手动各跑一次，见下文「验证」 |

## 部署

- 推送 `main` 就是上线：Workers Builds 会先跑 `npm run build`，再部署。要先得到站长同意；改界面和文案的，先给站长看效果。
- 部署完一两分钟后，在 1ms-shell 里跑 `npm run check -- cdn`，全部 ok 才算上线。
- 自己部署（不在 1ms.dog 上）：`npm run deploy`，然后在 Cloudflare 后台绑定自己的域名，见 README。

## VPS 上的定时任务

两个任务都在 1ms.dog 的东京 VPS 上运行，不开端口。它们的结果写进 `/srv/1ms-data/cdn/`，由服务器上的 Caddy 只读发布在 `https://data.1ms.dog:2083/cdn/`，再由 Worker 拉取，以 `/tokyo` 和 `/ecs` 提供给页面。服务器上不放任何令牌。系统用户、目录、端口和服务名的分配以 1ms-shell 的 `docs/processes.md`「专用服务器」为准，主机的连接方式见 1ms-shell 的 `docs/handover.md`。

| 服务 | 何时 | 做什么 | 结果 |
|---|---|---|---|
| `1ms-cdn-watch` | 每 10 分钟，第 4 分 | 用页面同样的测法从东京测各家 CDN，IPv4 和 IPv6 都测 | `watch/days/<日期>.json`（保留 400 天）、`watch/summary.json` |
| `1ms-cdn-ecs` | 每天 04:20 UTC | 带上各地运营商的网段（ECS）直接问 CloudFront 的权威 DNS，再问每个边缘 IP 是哪个节点 | `ecs/latest.json`、`ecs/days/<日期>.json` |

细节见 [server/README.md](server/README.md)。

### 从零装上

前提是机器上已经有系统用户 `1ms-cdn`、目录 `/opt/1ms/cdn/` 和 `/srv/1ms-data/cdn/`（属主 `1ms-cdn`），以及 Debian 自带的 `nodejs` 包（只要运行时，不要 npm）。这些属于机器的全局配置，由 1ms-shell 的 `vps/` 负责。

1. 打包（在仓库根目录）：

   ```
   tar -czf cdn-server.tgz src/cdns.mjs server/common.mjs server/watch.mjs server/ecs.mjs data/ecs-nets.json server/*.service server/*.timer
   ```

2. 上传到服务器并展开（以 root 身份）：

   ```
   tar -xzf cdn-server.tgz -C /opt/1ms/cdn/
   echo '{"type":"module"}' > /opt/1ms/cdn/package.json
   mv /opt/1ms/cdn/server/1ms-cdn-*.service /opt/1ms/cdn/server/1ms-cdn-*.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now 1ms-cdn-watch.timer 1ms-cdn-ecs.timer
   ```

   unit 文件里限制了内存（`MemoryMax=80M`），服务只能写 `/srv/1ms-data/cdn`，标准输出直接丢弃，只记错误。改 unit 文件时改仓库里的 `server/*.service`、`server/*.timer`，再重新上传。

3. 只更新代码时，重复第 1、2 步即可。timer 下一次运行就会用上新代码，不用重启。

### 验证

```
systemctl list-timers '1ms-cdn*'
systemd-run --wait --collect -p User=1ms-cdn -p MemoryMax=80M -p WorkingDirectory=/opt/1ms/cdn -E OUT=/srv/1ms-data/cdn -p ReadWritePaths=/srv/1ms-data/cdn -p ProtectSystem=strict /usr/bin/node /opt/1ms/cdn/server/watch.mjs
curl -s https://data.1ms.dog:2083/cdn/watch/summary.json | head -c 300
curl -s 'https://cdn.1ms.dog/tokyo?cdn=cloudflare'
curl -s -o /dev/null -w '%{http_code}\n' 'https://cdn.1ms.dog/ecs?cdn=cloudfront'
```

- `systemd-run` 跑完会打印内存峰值。2026-11-04 实测：watch 约 19 MB，跑约 14 秒；ecs 约 46 MB，跑约 17 秒。
- 正常情况下，东京测 Cloudflare 应该是 NRT，延迟几毫秒。
- 页面 `/zh-cn/cloudfront/` 上应该出现「从东京看」和「各地运营商会被分到哪里」两块。

### 数据：哪些丢了能自己长回来，哪些不能

- **能自己长回来的：** `watch/summary.json` 和 `ecs/` 下的文件，装好后跑一轮就重新生成。
- **丢了就回不来的：** `watch/days/`，最多 400 天的东京调度记录，每天一个文件，每个约 180 KB（一次运行约 1.3 KB，一天 144 次）。`summary.json` 和页面上的 30 天统计都是从它算出来的。
- **备份方案**由 1ms-shell 的 `vps/README.md`「数据」一节统一管理。写这份文档时那里还是「待定」，以那里为准。
- **手动做一份备份**（在任意能连上服务器的机器上）：

  ```
  ssh <服务器> 'tar -czf - -C /srv/1ms-data/cdn watch/days' > cdn-watch-days-$(date +%F).tgz
  ```

- **从备份恢复：**

  ```
  tar -xzf cdn-watch-days-<日期>.tgz -C /srv/1ms-data/cdn/
  chown -R 1ms-cdn:1ms-cdn /srv/1ms-data/cdn/watch
  systemctl start 1ms-cdn-watch     # 重新算出 summary.json
  ```

  恢复的文件和新生成的文件同名时，以文件内容较多的那份为准。同一天的两份可以合并：每个文件都是按时间排列的 JSON 数组。

## 规矩

- 推送 `main` 就是上线，要站长在当次对话里同意。
- 测法和结论的原则（结果不能先错后对、不加占位、隐私措辞）见 [docs/decisions.md](docs/decisions.md)。
- 分享组件 `static/assets/share/` 原样来自 1ms-shell，不要在这里改。
- 不写访问日志，不保存访客的测试结果。访客的 DNS 服务器信息只在当次测试里用，不进分享链接、分享卡片，也不进问题报告。
- 提交说明用英文，代码注释用英文，这份文档和 `docs/` 用中文。
- 密钥和私有信息不进这个仓库，它是公开的。
