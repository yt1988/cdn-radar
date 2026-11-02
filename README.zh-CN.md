# CDN 雷达

[English](README.md) · **简体中文**

每家大 CDN 把你分到了哪个节点、离你多远、往返要多久。[CDN 雷达](https://cdn.1ms.dog) 在你的浏览器里测 Cloudflare、Akamai、Amazon CloudFront、Fastly、Azure Front Door、Bunny、Wikimedia 等 CDN，把每个应答节点画在地图上，也能查任意网站用的 CDN。

**线上地址：** https://cdn.1ms.dog

## 功能

- **读出应答的节点。** 每家 CDN 都会把节点写进响应，但浏览器只能读到服务器允许读的部分。所以每家都用一个允许读取的公开文件来测：

  | CDN | 文件 | 节点在哪里 |
  |---|---|---|
  | Cloudflare | `www.cloudflare.com/cdn-cgi/trace` | 响应内容：`colo=HKG` |
  | Cloudflare 中国网络 | `www.cloudflare-cn.com/cdn-cgi/trace` | 同上，由与京东云合作的机房应答 |
  | Amazon CloudFront | `static.figma.com` | `Server-Timing: cdn-pop;desc="NRT57-P11"`（带 `Timing-Allow-Origin`） |
  | Akamai | `res-1.cdn.office.net` | `Akamai-Request-BC: …n=JP_13_TOKYO…`（城市名，不是代码） |
  | Fastly | `fastly.jsdelivr.net` | `X-Served-By: …-NRT` |
  | Azure Front Door | `res-2.cdn.office.net` | `X-Azure-Ref: …C1TYO…` |
  | Bunny | `fonts.bunny.net` | `Server: BunnyCDN-JP1-…` |
  | Wikimedia | `upload.wikimedia.org` | `X-Cache: cp5029 …`（5 是新加坡） |

  Google、阿里云、腾讯云 EdgeOne、网宿、Gcore 和 CDN77 没有找到任何允许网页读取节点的公开文件，所以只测延迟。
- **距离和理论最低值。** 你的位置来自 Cloudflare 对请求 IP 的定位（`/geo`），或者在你同意后用浏览器定位。光在光纤里每毫秒约走 200 km，所以 d km 的往返不可能低于 d ÷ 100 ms；远超两倍就是绕远了。对公开了全部节点的 CDN（Cloudflare、Bunny、Wikimedia），还会指出你没有被分到最近的节点。
- **查网站**：从 DNS 认出 CDN（CNAME 或 Cloudflare 的地址；Worker 的 `/dns` 用 Cloudflare 的 DNS 查询，不受污染影响），网站允许时读出节点，再测往返时间。站长可以用「复制给别人的测试链接」，让对方在自己的网络上做这项检查。
- **每家 CDN、每个节点都有页面**：`/cloudflare/`、`/cloudflare/hkg/`、`/bunny/jp/`……包括最近的其他节点，以及测一测你连的是不是它。10 种语言。
- **分享结果**：用 1ms.dog 公共分享组件生成图片或链接（`/r/…`）。链接里有节点和往返时间；城市、坐标（约 10 公里精度）和运营商只有勾选后才加入；永远不含 IP。
- **不收集数据**：请求从浏览器直接发往各家 CDN。Worker 只回答 `/geo` 和查网站用的 `/dns`（都不保存、不记录），以及给分享链接生成预览标题。

## 往返时间怎么测

对每家 CDN 的第一个请求只用来建立连接（DNS、TCP、TLS），不计入；之后复用这条连接再发三次，取中位数，就是到边缘节点的往返时间。不加防缓存参数：CDN 对已缓存的文件由边缘节点应答，未缓存的会回源，那就不是这里要测的；`cache: "no-store"` 只是绕开浏览器自己的缓存。

`npm run verify` 检查每个测试文件：不跳转、节点仍然可读（CORS 加 `Access-Control-Expose-Headers`，或者 `Timing-Allow-Origin`），并打印热连接上三次请求中最快的一次（远超一次往返说明是源站应答）。GitHub Actions 每周跑一次。

## 自己部署

```bash
git clone https://github.com/yt1988/cdn-radar
cd cdn-radar
npm install
npx wrangler login
npm run deploy        # 生成 public/（约 4900 个页面），连同 src/worker.js 一起部署
```

`wrangler.toml` 关掉了 `*.workers.dev` 和预览地址。在 **Workers 和 Pages → cdn-radar → 设置 → 域和路由** 里绑定你自己的域名。域名必须在 Cloudflare 上：访客位置来自 Worker 的 `/geo`。为你的域名构建：

```bash
SITE_URL=https://cdn.example.com npm run build
SITE_URL=https://cdn.example.com node scripts/assets.mjs   # 链接预览图，提交在 static/og/
```

在 1ms.dog 上，页面还会加上全站的导航条、统计，以及跨工具的主题和语言同步。页面里有 `<meta name="shortener">` 时，分享链接会换成短链。

## 开发

```bash
npm install
npm run dev        # http://localhost:8800（先构建）
npm run build      # 从 src/、data/ 和 static/ 生成 public/（public/ 不提交）
npm test           # 先构建，再检查页面约定、SEO、10 种语言的文案，以及核心逻辑的单元测试
npm run verify     # 检查每家 CDN 的测试文件
npm run data       # 从 Cloudflare 状态页、Bunny 的 region 接口和 OurAirports 刷新 data/
npm run assets     # 生成链接预览图（用 Windows 系统字体）
```

1ms.dog 上，每次推送到 `main` 都会自动部署（Cloudflare Workers Builds 运行 `npm ci && npm test`，再运行 `npx wrangler deploy`）。

```
src/page.html        页面模板
src/app.js           浏览器端：测时、读节点、地图、结论、查网站、分享
src/probe.mjs        单次请求计时、从响应里读节点、DNS over HTTPS
src/cdns.mjs         CDN 清单、测试文件、各家写节点的方式；查网站用的 CNAME 规则
src/lib.mjs          距离、结论、分享链接（有单元测试）
src/worker.js        /geo、/dns，以及分享结果（/r/…）的预览标题
src/i18n/*.mjs       10 种语言的文案；每种语言都有全部的键（有测试）
data/pops.json       Cloudflare、Bunny、Wikimedia 的全部节点（npm run data）
data/places.json     IATA 代码、城市代码和城市的位置（OurAirports，公有领域）
static/              字体、logo、1ms.dog 分享组件（从 1ms-shell 复制）、图标、og/ 预览图
scripts/build.mjs    生成 public/：按语言、CDN、节点生成页面；sitemap、robots、llms.txt、_headers
```

### 更换某家 CDN 的测试文件

- 响应必须由边缘节点给出（已缓存的文件，或边缘自己生成的内容），不能跳转，体积要小。
- 要读节点：CORS 并把响应头列进 `Access-Control-Expose-Headers`，或者 `Timing-Allow-Origin` 加上写在 `Server-Timing` 里的节点。换几个网络各测一次：有些网站按地区切换 CDN（`res.cdn.office.net` 有时是 Akamai、有时是 Azure；`res-1` 一直是 Akamai，`res-2` 一直是 Azure）。
- 运行 `npm run verify`，并把新响应头的样例加进 `test/lib.test.mjs`。

## 许可

[MIT](LICENSE)。柴犬插画和 1ms.dog 的 logo 属于本项目的品牌形象，如果你用别的名字公开运行一份，请换成你自己的。地图数据：Natural Earth（通过 world-atlas）；机场数据：OurAirports（公有领域）。
