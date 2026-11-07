# AGENTS.md

写给在这个仓库里干活的人和 AI 代理（Claude Code、Codex、Cursor 等都适用）。如果有 `CLAUDE.md`，它只指向这里。1ms.dog 的运营说明在私有仓库 1ms-shell。

## 这是什么

CDN 雷达：在浏览器里测出各家大 CDN（Cloudflare、Akamai、CloudFront、Fastly、Azure Front Door、Bunny、Wikimedia 等）把访客分到了哪个节点、离访客多远、延迟多少，也能查任意网站用的是哪家 CDN、哪个节点。10 种语言，每家 CDN、每个公开节点都有自己的页面。

- 页面是静态的，由 `scripts/build.mjs` 从 `src/`、`data/`、`static/` 生成到 `public/`（不提交）。
- `src/worker.js` 是 Cloudflare Worker，只处理静态文件以外的路径：`/geo`、`/dns`、`/places`、`/tokyo`、`/ecs`，以及分享链接 `/r/…`。每个路径做什么写在文件开头。
- 读出节点的规则全在 `src/cdns.mjs`。页面、Worker 和服务器上的定时任务用的都是这一份，不要另写一套。
- 测法的规则、设计理由、测过的结论、否决过的技术方案，见 [docs/decisions.md](docs/decisions.md)。改测法、结论或文案之前先读它。

## 目录

| 路径 | 内容 |
|---|---|
| `src/app.js` | 页面脚本：测量、结论、表格、分享卡片 |
| `src/probe.mjs` | 在浏览器里测一家 CDN：第一次请求只建连接、不计时，之后计时 3 次取中位数 |
| `src/lib.mjs` | 页面和 Worker 共用的纯逻辑：距离、结论（`summary`）、远节点归因（`blame`）、分享链接编码 |
| `src/i18n/*.mjs` | 10 种语言的文字，各语言的键和占位符必须一致（测试会查） |
| `src/page.html`、`style.css`、`base.css`、`fonts.css` | 页面模板和样式；构建时把样式内联进每个页面 |
| `data/pops.json`、`data/places.json` | 公开的节点列表和地名，由 `npm run data` 生成 |
| `data/ecs-nets.json` | 各地主要运营商的代表网段，由 `npm run ecs-nets` 生成，给服务器任务用 |
| `server/` | 可选的两个服务器定时任务，以及它们的 systemd unit，见下文 |
| `static/` | 原样复制的文件：字体、图标、预览图、分享组件 `assets/share/`（来自上游，不要在这里改） |

## 本地运行

需要 Node 20 以上。

```
npm install
npm run build      # 生成 public/
npm run dev        # wrangler dev，http://127.0.0.1:8800
```

- 本地页面能测各家 CDN。下面两样依赖外部服务，本地不出现不算故障：
  - 「你的 DNS 服务器」那一行和远节点的原因行：要有一台能看到访客解析器的权威 DNS，见 `src/app.js` 的 `askResolver`；只在 1ms.dog 上启用。
  - 「从东京看」和运营商调度表：要有 `server/` 的定时任务和它们的数据地址。
- `wrangler dev` 重新构建后可能还在用旧的文件清单，带哈希的新文件会 404。重新构建后要重启它。

## 测试：按改动范围选

| 改了什么 | 跑什么 |
|---|---|
| 任何改动，提交前 | `npm test`：先构建，再跑 `test/*.test.mjs`，检查语言键和占位符、页面结构和 SEO、Worker 路由、结论逻辑 |
| 文字 | 另外核对 10 种语言都改了 |
| `src/cdns.mjs` 里的测试文件或读取规则 | `npm run verify`：从你所在的网络检查每个测试文件仍能访问、仍能读出节点 |
| 节点列表、地名 | `npm run data`，提交 `data/` |
| 预览图的标题或 CDN 名单 | `npm run assets`，提交 `static/og/` |
| `server/` | 在服务器上手动各跑一次，见下文「验证」 |

## 部署

- `npm run deploy`：构建并上传到 Cloudflare Workers，然后在 Cloudflare 后台绑定自己的域名，见 README。
- 接了 Workers Builds 的话，推送 `main` 就会先构建再部署。
- 1ms.dog 上的上线规矩和上线后的巡检，见私有仓库 1ms-shell。

## 服务器上的定时任务（可选）

两个任务给页面提供「从东京看」和「各地运营商会被分到哪里」。没有它们，页面照常运行，只是不显示这两块。它们不开端口，结果写进一个目录，由任意静态文件服务器只读发布出去，再由 Worker 拉取，以 `/tokyo` 和 `/ecs` 提供给页面。数据地址写在 `src/worker.js` 的 `DATA_URL`，自部署时改成你自己的地址。

| 任务 | 建议频率 | 做什么 | 结果 |
|---|---|---|---|
| `watch` | 每 10 分钟 | 用页面同样的测法从服务器测各家 CDN，IPv4 和 IPv6 都测 | `watch/days/<日期>.json`（保留 400 天）、`watch/summary.json` |
| `ecs` | 每天一次 | 带上各地运营商的网段（ECS）直接问 CloudFront 的权威 DNS，再问每个边缘 IP 是哪个节点 | `ecs/latest.json`、`ecs/days/<日期>.json` |

细节见 [server/README.md](server/README.md)。以下用占位符：`<app>` 是代码目录名，`<user>` 是运行任务的系统用户，`<data-dir>` 是结果目录，`<data-url>` 是它对外的地址。

### 从零装上

需要 Node 20 以上（只要运行时，不要 npm）、一个普通系统用户 `<user>`、代码目录 `/opt/<app>/`，以及属主为 `<user>` 的结果目录 `<data-dir>`。出站要能走 TCP 443；ecs 还要走 UDP 53。

1. 打包（在仓库根目录）：

   ```
   tar -czf cdn-server.tgz src/cdns.mjs server/common.mjs server/watch.mjs server/ecs.mjs data/ecs-nets.json server/*.service server/*.timer
   ```

2. 上传到服务器并展开（以 root 身份）：

   ```
   tar -xzf cdn-server.tgz -C /opt/<app>/
   echo '{"type":"module"}' > /opt/<app>/package.json
   ```

3. 安装 systemd unit：
   - `server/*.service` 和 `server/*.timer` 是 1ms.dog 用的版本，里面的用户名和路径要换成 `<user>`、`/opt/<app>/`、`<data-dir>`；
   - 放进 `/etc/systemd/system/`，然后 `systemctl daemon-reload`，再 `systemctl enable --now` 两个 timer。
   - unit 文件里限制了内存（80 MB），服务只能写结果目录，标准输出直接丢弃，只记错误。

4. 只更新代码时，重复第 1、2 步即可。timer 下一次运行就会用上新代码，不用重启。

### 验证

```
systemd-run --wait --collect -p User=<user> -p MemoryMax=80M -p WorkingDirectory=/opt/<app> -E OUT=<data-dir> -p ReadWritePaths=<data-dir> -p ProtectSystem=strict /usr/bin/node /opt/<app>/server/watch.mjs
curl -s <data-url>/watch/summary.json | head -c 300
curl -s 'https://<your-domain>/tokyo?cdn=cloudflare'
```

- `systemd-run` 跑完会打印内存峰值。实测：watch 约 19 MB，跑约 14 秒；ecs 约 46 MB，跑约 17 秒。
- 页面 `/<lang>/cloudfront/` 上应该出现「从东京看」和「各地运营商会被分到哪里」两块。

### 哪些数据丢了回不来

- **丢了能自己长回来：** `watch/summary.json` 和 `ecs/` 下的文件，跑一轮就重新生成。
- **丢了就回不来：** `watch/days/`，最多 400 天的记录，每天一个文件，约 180 KB（一次运行约 1.3 KB，一天 144 次）。`summary.json` 和页面上的 30 天统计都是从它算出来的。
- **备份：** 把 `<data-dir>/watch/days/` 打成 tar 包存到别处即可。
- **恢复：** 解压回原处，把属主改回 `<user>`，然后手动跑一次 watch，它会重新算出 `summary.json`。每个日文件都是按时间排列的 JSON 数组；同一天有两份时，可以合并，或者留内容多的那份。

## 规矩

- 测法和结论的原则（结果不能先错后对、不加占位、隐私措辞）见 [docs/decisions.md](docs/decisions.md)。
- 分享组件 `static/assets/share/` 原样来自上游，不要在这里改。
- 不写访问日志，不保存访客的测试结果。访客的 DNS 服务器信息只在当次测试里用，不进分享链接、分享卡片，也不进问题报告。
- 提交说明和代码注释用英文；这份文档和 `docs/` 用中文。
- 这个仓库是公开的：密钥和私有信息不要放进来。
