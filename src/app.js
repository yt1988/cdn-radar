// CDN Radar page. Every CDN's row is in the HTML from the start; the CDNs are timed at once (src/probe.mjs) and fill
// their rows as they answer: which location answered, how far it is from the visitor, and the round trip next to the
// fastest one the distance allows. The map and the verdict follow. A location page (/<cdn>/<code>/) tests its one CDN.
// Strings: window.L1MS.
import { CDNS, BY, HOSTS, nameOf, placeOf, popMaps, SITE_HEADERS, SITE_TIMING, PARSE, cdnOfName, isCloudflareIP } from "./cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, median, FAST, isFar, groupExits, cdnExits, routes, exitOfIp, sameNet,
  encode as encodeShare, decode as decodeShare, sharePath, hostOf } from "./lib.mjs";
import { probe, dns, once, readPop } from "./probe.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const K = { theme: "cdnradar:theme", lang: "cdnradar:lang" };

  /* ---------- theme and language (synced across the 1ms.dog tools) ---------- */
  const thBtn = $("#theme"), TH = ["system", "light", "dark"];
  const applyTheme = th => {
    if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th); else document.documentElement.removeAttribute("data-theme");
    thBtn.dataset.th = th; thBtn.title = t("th_" + th); thBtn.setAttribute("aria-label", t("th_" + th));
  };
  applyTheme(TH.includes(store.get(K.theme)) ? store.get(K.theme) : "system");
  thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set(K.theme, n); applyTheme(n); };
  $("#lang").onchange = e => { const l = e.target.value; store.set(K.lang, l); location.href = D.paths[l] + location.search; };

  /* ---------- dialogs ---------- */
  function openDlg(id) { $("#" + id).hidden = false; document.documentElement.style.overflow = "hidden"; $("#" + id + " [data-close]").focus(); }
  function closeDlg() { $$(".scrim").forEach(s => { s.hidden = true; }); document.documentElement.style.overflow = ""; }
  $$("[data-close]").forEach(b => { b.onclick = closeDlg; });
  $$(".scrim").forEach(s => s.addEventListener("click", e => { if (e.target === s) closeDlg(); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDlg(); });
  // help: one answer at a time; a picker with previous / next on phones
  let helpIdx = 0;
  const helpN = $$("#helpNav [data-hq]").length;
  $("#helpSel").innerHTML = $$("#helpNav [data-hq]").map((b, i) => `<option value="${i}">${i + 1} / ${helpN} · ${esc(b.textContent)}</option>`).join("");
  function showHelp(i) {
    helpIdx = Math.max(0, Math.min(helpN - 1, i));
    $$("#helpNav [data-hq]").forEach(b => b.setAttribute("aria-selected", +b.dataset.hq === helpIdx));
    $$("#helpC [data-hqb]").forEach(a => { a.hidden = +a.dataset.hqb !== helpIdx; });
    $("#helpSel").value = helpIdx;
    $$("[data-hstep]").forEach(b => { b.disabled = helpIdx + +b.dataset.hstep < 0 || helpIdx + +b.dataset.hstep >= helpN; });
    $("#helpC").scrollTop = 0;
  }
  $("#helpBtn").onclick = () => { showHelp(helpIdx); openDlg("help"); };
  $$("#helpNav [data-hq]").forEach(b => { b.onclick = () => showHelp(+b.dataset.hq); });
  $("#helpSel").onchange = e => showHelp(+e.target.value);
  $$("[data-hstep]").forEach(b => { b.onclick = () => showHelp(helpIdx + +b.dataset.hstep); });

  /* ---------- routing rules: every test host direct, or every one through the proxy ---------- */
  // A page can't pick the route: the visitor's proxy client does. Every host the test fetches from (HOSTS in cdns.mjs)
  // sent one way, first as a remote rule set the client subscribes to (this site's /rules/, built by scripts/build.mjs:
  // it follows when test hosts change), then as rules to paste. As 1ms.dog's Me2Cloud does.
  const RULESETS = location.origin + "/rules/";
  // a policy as each client writes it; "PROXY" / "proxy" stands for the visitor's proxy group
  const POLICY = (f, d) => f === "quanx" || f === "singbox" ? (d ? "direct" : "proxy") : d ? "DIRECT" : "PROXY";
  function ruleRemote(f, d) {
    const p = POLICY(f, d), top = t("rules_top");
    switch (f) {
      case "clash": return `rule-providers:\n  cdn-radar:\n    type: http\n    behavior: classical\n    format: yaml\n    url: ${RULESETS}clash.yaml\n    path: ./ruleset/cdn-radar.yaml\n    interval: 86400\n\nrules:\n  - RULE-SET,cdn-radar,${p}   # ${top}`;
      case "surge": return `[Rule]\n# ${top}\nRULE-SET,${RULESETS}surge.list,${p},update-interval=86400`;
      case "shadowrocket": return `[Rule]\n# ${top}\nRULE-SET,${RULESETS}surge.list,${p}`;
      case "quanx": return `[filter_remote]\n${RULESETS}quanx.list, tag=CDN Radar, force-policy=${p}, update-interval=86400, opt-parser=false, enabled=true`;
      case "loon": return `[Remote Rule]\n${RULESETS}loon.list, policy=${p}, tag=CDN Radar, enabled=true`;
      case "singbox": return JSON.stringify({ route: { rule_set: [{ tag: "cdn-radar", type: "remote", format: "source", url: RULESETS + "singbox.json", download_detour: "direct", update_interval: "1d" }],
        rules: [{ rule_set: "cdn-radar", outbound: p }] } }, null, 2);
    }
  }
  function ruleInline(f, d) {
    const p = POLICY(f, d);
    if (f === "singbox") return JSON.stringify({ route: { rules: [{ domain: HOSTS, outbound: p }] } }, null, 2);
    const line = h => f === "clash" ? `  - DOMAIN,${h},${p}` : f === "quanx" ? `host, ${h}, ${p}` : `DOMAIN,${h},${p}`;
    const head = { clash: "rules:", surge: "[Rule]", shadowrocket: "[Rule]", loon: "[Rule]", quanx: "[filter_local]" }[f];
    return `${head}\n${f === "clash" ? "  " : ""}# ${t("rules_cmt")}\n` + HOSTS.map(line).join("\n");
  }
  const codeBox = (text, i) => `<div class="code"><textarea readonly spellcheck="false" rows="${Math.min(12, text.split("\n").length + 1)}" data-ta="${i}">${esc(text)}</textarea>` +
    `<button class="btn sm" type="button" data-copyta="${i}"><span>${esc(t("rules_copy"))}</span></button></div>`;
  function fillRules() {
    const d = $("#rulesMode").value === "d", f = $("#rulesFmt").value;
    $("#rulesBody").innerHTML = `<section class="rblk"><div class="rblk-h"><b>${esc(t("rules_remote_h"))}</b><span class="m">${esc(t("rules_remote_s"))}</span></div>${codeBox(ruleRemote(f, d), 0)}</section>` +
      `<details class="rblk"><summary>${esc(t("rules_inline_h", { n: HOSTS.length }))}</summary>${codeBox(ruleInline(f, d), 1)}</details>`;
    // sentences in Chinese and Japanese follow each other without a space
    const note = t("rules_note_" + f);
    $("#rulesNote").textContent = note + (d ? "" : (/[。！？]$/.test(note) ? "" : " ") + t("rules_proxy_note"));
  }
  if ($("#rulesBtn")) {
    $("#rulesBtn").onclick = () => { fillRules(); openDlg("rules"); };
    $("#rulesMode").onchange = fillRules; $("#rulesFmt").onchange = fillRules;
    $("#rulesBody").addEventListener("click", e => {
      const b = e.target.closest("[data-copyta]");
      if (!b) return;
      const ta = $(`#rulesBody [data-ta="${b.dataset.copyta}"]`), copied = () => { b.querySelector("span").textContent = t("copied"); };
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(copied, () => ta.select()); else ta.select();
    });
  }

  /* ---------- tooltips (data-why) ---------- */
  let tipEl;
  function showTip(el) {
    if (!tipEl) { tipEl = document.body.appendChild(Object.assign(document.createElement("div"), { className: "tip" })); addEventListener("scroll", () => tipEl.classList.remove("on"), { passive: true }); }
    tipEl.textContent = el.dataset.why;
    const b = el.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2)) + "px";
    tipEl.style.top = b.bottom + 6 + "px"; tipEl.classList.add("on");
  }
  document.addEventListener("mouseover", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el && el.dataset.why) showTip(el); else if (tipEl) tipEl.classList.remove("on"); });
  document.addEventListener("focusin", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el && el.dataset.why) showTip(el); });
  document.addEventListener("focusout", () => tipEl && tipEl.classList.remove("on"));

  /* ---------- other 1ms.dog tools (on 1ms.dog only: the shell's <meta>) ---------- */
  // every link to another tool ends with the external-link mark (1ms-shell docs/tool-contract.md, section 4)
  const EXT = '<svg class="ext" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';
  const tool = n => { const m = document.querySelector(`meta[name="${n}"]`); return m ? m.content.replace(/\/+$/, "") + D.home : null; };
  const ASN = tool("asn"), EGRESS = tool("egress"), COST = tool("cost"), HOME = tool("home"), SPEED = tool("speed");
  const link = (id, href) => { const a = $("#" + id); if (a && href) { a.href = href; a.hidden = false; } };
  link("egressLink", EGRESS); link("costLink", COST); link("speedLink", SPEED);
  // the home page's page for a service on this CDN (1ms.dog's own Cloudflare page tests www.cloudflare.com too)
  link("homeLink", HOME && D.cdn === "cloudflare" ? HOME + "cloudflare/" : null);

  /* ---------- numbers and names ---------- */
  const nf = new Intl.NumberFormat(D.lang);
  const fmtMs = ms => ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  const msTxt = ms => t("r_ms", { ms: fmtMs(ms) });
  const kmTxt = d => t("r_km", { km: nf.format(d < 10 ? Math.round(d * 10) / 10 : Math.round(d)) });
  const regionNames = (() => { try { return new Intl.DisplayNames([D.lang], { type: "region" }); } catch (e) { return null; } })();
  const country = cc => { try { return regionNames ? regionNames.of(cc) : cc; } catch (e) { return cc; } };
  const cdnName = id => BY[id] ? nameOf(BY[id], D.lang) : id;
  // a location for people: "HKG · Hong Kong, 香港" → code and where; Akamai names cities, not codes
  const popCode = (id, code) => id === "akamai" || id === "cdn77" ? "" : code;
  const placeTxt = p => p ? (p[0] && p[1] ? `${p[0]}, ${country(p[1])}` : p[0] || country(p[1])) : "";

  /* ---------- data: the locations of the CDNs that publish them, where codes are, and where the visitor is ---------- */
  const DATA = { pops: null, places: null };
  const getJ = (u, opt) => fetch(u, opt).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const popsP = getJ("/assets/" + D.files.pops).then(j => { DATA.pops = popMaps(j); }).catch(() => { DATA.pops = {}; });
  const placesP = getJ("/assets/" + D.files.places).then(j => { DATA.places = j; }).catch(() => { DATA.places = { iata: {}, city: {} }; });
  // This site's view of the connection: the address and Cloudflare's guess of where it is, and the Cloudflare location
  // it reached. The 1ms.dog shell's /_ms/me, else this site's Worker (/geo); null when self-hosted as plain files.
  let U = null, PRECISE = null;
  const num = v => v == null || v === "" ? null : +v;
  const loadSelf = () => getJ("/_ms/me", { cache: "no-store" })
    .then(j => ({ ip: j.ip, cc: j.country, city: j.city, lat: num(j.latitude), lon: num(j.longitude), asn: j.asn, org: j.org, colo: j.colo }))
    .catch(() => getJ("/geo", { cache: "no-store" })).then(j => { if (j && (j.ip || j.lat != null)) U = j; }).catch(() => {});
  let geoP = loadSelf();

  /* ---------- exits: the visitor's own line (D) and any proxies (P), and which one each CDN's request took ---------- */
  // Sources: this site's view (above), a mainland-China site (IPIP: proxy rules send it direct), and the address
  // Cloudflare's trace saw for each CDN read by trace. Each address is placed by IP geolocation (ip.sb) unless
  // Cloudflare placed it already. lib.mjs groups them into exits and works out each row's route.
  const EX = { seen: [], geo: {}, cn: null, list: [], rt: {}, ready: false };
  const sig6 = () => AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined;
  const ext = u => fetch(u, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: sig6() }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const asked = new Set();
  function addExit(ip, src, g) {
    if (!ip) return;
    if (!EX.seen.some(x => x.ip === ip && x.src === src)) EX.seen.push({ ip, src });
    if (g) EX.geo[ip] = { ...(EX.geo[ip] || {}), ...g };
    // placed already, or an address on the same network is
    if (Object.entries(EX.geo).some(([k, v]) => v.lat != null && sameNet(k, ip)) || asked.has(ip)) return;
    asked.add(ip);
    ext("https://api.ip.sb/geoip/" + encodeURIComponent(ip)).then(j => {
      EX.geo[ip] = { ...(EX.geo[ip] || {}), cc: j.country_code || "", city: j.city || "", lat: num(j.latitude), lon: num(j.longitude), asn: j.asn || null,
        org: j.asn_organization || j.organization || j.isp || "" };
      redraw();
    }).catch(() => {});
  }
  function findExits() {
    EX.seen = []; EX.cn = null; EX.list = []; EX.rt = {}; EX.ready = false;
    geoP.then(() => { if (U && U.ip) addExit(U.ip, "self", { cc: U.cc, city: U.city, lat: U.lat, lon: U.lon, asn: U.asn, org: U.org, colo: U.colo }); redraw(); });
    return ext("https://myip.ipip.net/json").then(j => { const ip = j && j.data && j.data.ip; if (ip) { EX.cn = ip; addExit(ip, "cn"); redraw(); } }).catch(() => {});
  }
  // a Cloudflare location code → [lat, lon, city, cc]
  const cfAt = code => { const p = code && DATA.pops && DATA.pops.cloudflare && DATA.pops.cloudflare[code]; return p ? [p[2], p[3], p[0], p[1]] : null; };
  // the exits and every row's route, from what has come in so far
  function regroup() {
    const geo = Object.fromEntries(Object.entries(EX.geo).map(([ip, g]) => [ip, { ...g, edge: cfAt(g.colo), edgeCn: cfAt(g.coloCn) }]));
    EX.list = groupExits(EX.seen, geo);
    const cnE = exitOfIp(EX.list, EX.cn);
    EX.rt = routes(LIST.filter(c => R[c.id]).map(c => ({ id: c.id, ip: R[c.id].ip, ms: R[c.id].ms, place: R[c.id].code && DATA.pops ? placeOf(c.id, R[c.id].code, DATA.pops, DATA.places) : null })),
      cdnExits(EX.list), cnE && cnE.letter);
  }
  // the exits the CDNs' requests can have taken (lib.mjs cdnExits); exitBy finds any, this site's own too
  const exits = () => SHOWN ? SHOWN.exits : cdnExits(EX.list);
  const exitBy = x => (SHOWN ? SHOWN.exits : EX.list).find(e => e.letter === x) || null;

  /* ---------- the map: the visitor and each location answered, on an equirectangular world (lat 84 to -58) ---------- */
  const X = lon => lon + 180, Y = lat => 84 - Math.max(-58, Math.min(84, lat));
  function drawMap(rows, me) {
    const svg = $("#mapo");
    if (!svg) return;
    let h = "";
    const u = me && me.lat != null ? [X(me.lon), Y(me.lat)] : null;
    for (const r of rows) {
      if (!r.place) continue;
      const p = [X(r.place[3]), Y(r.place[2])], c = BY[r.id] ? BY[r.id].c : "var(--ink)";
      if (u && Math.hypot(p[0] - u[0], p[1] - u[1]) > 1.5) {
        // a curve bowed toward the pole, as long routes look on a flat map
        const mx = (u[0] + p[0]) / 2, my = (u[1] + p[1]) / 2 - Math.min(30, Math.hypot(p[0] - u[0], p[1] - u[1]) / 4);
        h += `<path d="M${u[0].toFixed(1)} ${u[1].toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)}" stroke="${c}" class="arc"/>`;
      }
      h += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.2" fill="${c}" class="pop"><title>${esc(cdnName(r.id) + " · " + (popCode(r.id, r.code) ? popCode(r.id, r.code) + " · " : "") + placeTxt(r.place))}</title></circle>`;
    }
    if (u) h += `<circle cx="${u[0].toFixed(1)}" cy="${u[1].toFixed(1)}" r="3.4" class="me-ring"/><circle cx="${u[0].toFixed(1)}" cy="${u[1].toFixed(1)}" r="2" class="me"/>`;
    svg.innerHTML = h;
  }

  /* ---------- results ---------- */
  const ROW = Object.fromEntries($$(".cr[data-c], .tt[data-c]").map(r => [r.dataset.c, r]));
  const LIST = D.kind === "pop" ? [BY[D.cdn]] : CDNS;
  let R = {};            // results so far, by CDN id: { ms, code, err, loc? }
  let SHOWN = null;      // a shared result being shown: its visitor location (or null)
  let SITE = null;       // the site check's result
  // Where the visitor is: their own line's exit (the first direct one), else this site's view; the browser's position
  // when they ask for it. A shared result: the sharer's, when they showed it.
  const home = () => { const e = EX.list.find(x => x.kind === "D" && x.lat != null); return e ? { cc: e.cc, city: e.city, lat: e.lat, lon: e.lon, asn: e.asn, org: e.org } : U; };
  const me = () => SHOWN ? SHOWN.where : PRECISE ? { ...(home() || {}), ...PRECISE } : home();
  const listFmt = (() => { try { return new Intl.ListFormat(D.lang, { type: "conjunction" }); } catch (e) { return { format: a => a.join(", ") }; } })();
  const names = ids => listFmt.format(ids.map(cdnName));

  // A row's result with its place, route, distance and flags. Its distance starts at its exit: a proxy's place for a
  // row that went through one, the visitor's otherwise. unsure: there are several exits and this row's can't be told.
  function rowOf(id) {
    const x = R[id];
    if (!x) return null;
    const place = x.code && DATA.pops ? placeOf(id, x.code, DATA.pops, DATA.places) : null;
    const route = (SHOWN ? x.route : EX.rt[id]) || { x: null }, ex = route.x && exitBy(route.x);
    const multi = SHOWN ? SHOWN.multi : exits().length > 1;
    const m = ex && ex.kind === "P" && ex.lat != null ? ex : route.x && route.x[0] === "P" ? null : me();
    const d = place && m && m.lat != null ? km(m.lat, m.lon, place[2], place[3]) : null;
    // through a proxy the round trip also covers the way to it: the least it can take counts that too
    const you = me(), dp = d != null && m === ex && you && you.lat != null ? km(you.lat, you.lon, ex.lat, ex.lon) + d : null;
    const list = BY[id] && BY[id].list && DATA.pops && DATA.pops[BY[id].list];
    const near = d != null && list && m ? nearest(id === "cfchina" ? Object.fromEntries(Object.entries(list).filter(([, p]) => p[1] === "CN")) : list, m.lat, m.lon) : null;
    return { id, code: x.code, ms: x.ms, err: x.err, place, d, dp, near, route, multi, unsure: multi && !route.x };
  }

  // a round trip's color: near (t1) to far (t5)
  const msTier = ms => ms < FAST ? "t1" : ms < 80 ? "t2" : ms < 150 ? "t3" : ms < 250 ? "t4" : "t5";
  const tag = (txt, cls, why) => `<i class="tag ${cls}"${why ? ` data-why="${esc(why)}" tabindex="0"` : ""}>${esc(txt)}</i>`;
  // the bars share one scale: the slowest so far, at least 200 ms
  const scale = () => Math.max(200, ...Object.values(R).filter(x => x.ms != null).map(x => x.ms));
  const barHTML = ms => `<i class="rb"><i class="${msTier(ms)}" style="transform:scaleX(${Math.max(.02, Math.min(1, ms / scale())).toFixed(3)})"></i></i>`;

  // an exit for people: "Tokyo, Japan"
  const exitWhere = e => e ? [e.city, e.cc && country(e.cc)].filter(Boolean).join(", ") || e.letter : "";
  // The exit a row's request took, when the visitor's traffic has more than one: D, P (P1, P2…) or ?, and how that was
  // told on hover. One inferred from routing rules is drawn dashed.
  function routeBadge(el, x) {
    if (!el) return;
    const show = !!x && x.ms != null && x.multi;
    el.hidden = !show;
    if (!show) return;
    const r = x.route, e = r.x && exitBy(r.x);
    el.textContent = r.x || "?";
    el.className = "via " + (!r.x ? "rq" : r.x[0] === "D" ? "rd" : "rp") + (r.how === "rule" ? " guess" : "");
    el.dataset.why = r.x ? t("rt_" + r.how, { x: r.x, where: e ? exitWhere(e) : r.x, cdn: cdnName(x.id), ms: msTxt(x.ms) }) : t("rt_q");
    el.tabIndex = 0;
  }

  function fillRow(id) {
    const row = ROW[id];
    if (!row) return;
    const x = rowOf(id), cdn = BY[id];
    row.classList.toggle("wait", !x);
    row.classList.toggle("bad", !!x && x.ms == null);
    const failTxt = x && t(x.err === "timeout" ? "r_timeout" : "r_fail");
    routeBadge(row.querySelector(".via"), x);
    // timed only: a tile
    if (row.classList.contains("tt")) {
      row.querySelector("b").textContent = !x ? "…" : x.ms == null ? failTxt : msTxt(x.ms);
      row.querySelector("b").className = x && x.ms != null ? msTier(x.ms) : "";
      row.querySelector(".rb").outerHTML = x && x.ms != null ? barHTML(x.ms) : `<i class="rb"><i></i></i>`;
      return;
    }
    const cp = row.querySelector(".cp"), cd = row.querySelector(".cd"), cm = row.querySelector(".cm");
    if (!x) { cp.innerHTML = "<b>…</b>"; cd.innerHTML = "<b>…</b>"; cm.innerHTML = `<b>…</b><i class="rb"><i></i></i>`; return; }
    // where it answered from, and whether that is the CDN's nearest location
    if (x.code) {
      const c = popCode(id, x.code), href = cdn.list && D.popHref ? D.popHref[cdn.list] : null;
      const code = c ? (href && x.place ? `<a href="${esc(href + x.code.toLowerCase() + "/")}">${esc(c)}</a>` : esc(c)) : esc(x.place ? x.place[0] : x.code);
      const missed = x.d != null && !x.unsure && missedNearest(x.d, x.near)
        ? " " + tag(t("f_notnearest"), "warn", t("f_notnearest_tip", { cdn: cdnName(id), code: popCode(id, x.near[0]), place: placeTxt(x.near[1]), km: kmTxt(x.near[2]) })) : "";
      cp.innerHTML = `<b>${code}</b> <span>${esc(x.place ? (c ? placeTxt(x.place) : country(x.place[1])) : t("r_unknown"))}</span>${missed}`;
    } else cp.innerHTML = x.ms == null ? `<span class="bad">${esc(failTxt)}</span>` : `<b>—</b> <span>${esc(t("r_nopop"))}</span>`;
    // how far, from the exit it took; from the visitor, dimmed and not judged, when that can't be told
    if (x.d != null && x.unsure) cd.innerHTML = `<b class="m" data-why="${esc(t("rt_q"))}" tabindex="0">${esc(kmTxt(x.d))}?</b>`;
    else if (x.d != null) { const tier = tierOf(x.d); cd.innerHTML = `<b class="${tier[1]}">${esc(kmTxt(x.d))}</b> ${tag(t("d_" + tier[2]), tier[1])}`; }
    else cd.innerHTML = `<b>—</b>`;
    // how long: the least the distance allows on hover, "long way round" when it is far beyond that
    if (x.ms != null) {
      const sure = x.d != null && !x.unsure;
      const floor = sure ? t("r_floor", { ms: fmtMs(floorMs(x.dp ?? x.d)) }) : "";
      const slow = sure && detoured(x.ms, x.dp ?? x.d) ? tag(t("f_slow"), "warn", t("f_slow_tip", { floor: msTxt(floorMs(x.dp ?? x.d)), km: kmTxt(x.dp ?? x.d) })) + " " : "";
      cm.innerHTML = `<b><span>${slow}</span><span${floor ? ` data-why="${esc(floor)}"` : ""}>${esc(msTxt(x.ms))}</span></b>${barHTML(x.ms)}`;
    } else cm.innerHTML = `<b>—</b><i class="rb"><i></i></i>`;
  }

  // the hero: the verdict, four numbers, and what stands out
  const ICON = { ok: '<path d="M3.5 8.5l3 3 6-7"/>', warn: '<path d="M8 3.5v5.5M8 12v.5"/>', bad: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>' };
  function finding(f) {
    const r = f.row;
    if (f.key === "f_fail") return t("f_fail", { list: names(f.ids) });
    if (f.key === "f_fast") return t("f_fast", { list: names(f.ids), ms: msTxt(FAST) });
    if (f.key === "f_more") return t("f_more", { n: f.n });
    if (f.key === "f_slowpath") return t("f_slowpath", { cdn: cdnName(r.id), place: placeTxt(r.place), km: kmTxt(r.d), ms: msTxt(r.ms), floor: msTxt(floorMs(r.dp ?? r.d)) });
    const head = t("f_far", { cdn: cdnName(r.id), place: placeTxt(r.place), km: kmTxt(r.d), ms: msTxt(r.ms) });
    // sentences in Chinese and Japanese follow each other without a space
    return head + (missedNearest(r.d, r.near) ? (/[。！？]$/.test(head) ? "" : " ") + t("f_far_near", { near: [popCode(r.id, r.near[0]), placeTxt(r.near[1])].filter(Boolean).join(" · "), km: kmTxt(r.near[2]) }) : "");
  }
  // The test's conditions: the exits the visitor's traffic takes, and what that means for the results. One exit: all
  // direct (the visitor's own network) or all through a proxy (the proxy's network, not theirs). Several: how many CDNs
  // went each way, as the two can't be compared.
  function fillCond(final) {
    const el = $("#cond");
    if (!el) return;
    // the CDNs' exits decide the wording; one only this site went through is listed, marked as such
    const E = exits(), all = SHOWN ? E : EX.list, rows = LIST.map(c => rowOf(c.id)).filter(x => x && x.ms != null);
    const why = e => !E.includes(e) ? t("ex_site") : e.edge ? t("ex_edge") : "";
    const chip = e => `<i class="xc ${e.kind === "D" ? "rd" : "rp"}${E.includes(e) ? "" : " site"}"${why(e) ? ` data-why="${esc(why(e))}" tabindex="0"` : ""}><b>${esc(e.letter)}</b>${esc(t(!E.includes(e) ? "ex_site_k" : e.kind === "D" ? "ex_d" : "ex_p"))}` +
      (exitWhere(e) !== e.letter ? `<span>${esc(exitWhere(e))}${e.org ? " · " + esc(shortOrg(e.org)) : ""}</span>` : "") + `</i>`;
    let txt;
    if (SHOWN) txt = SHOWN.multi ? t("cond_shared") : "";
    else if (!E.length) txt = final ? t("cond_none") : t("cond_wait");
    else if (E.length === 1) txt = t(E[0].kind === "D" ? "cond_one_d" : "cond_one_p", { x: E[0].letter });
    else {
      const n = k => rows.filter(r => r.route.x && r.route.x[0] === k).length, q = rows.filter(r => !r.route.x).length;
      txt = t("cond_mix", { d: n("D"), p: n("P") }) + (q ? t("cond_q", { n: q }) : "") + t("cond_mix_end");
    }
    $("#condEx").innerHTML = SHOWN ? "" : all.map(chip).join("");
    $("#condTxt").textContent = txt || " ";
    el.hidden = !txt && !E.length;
  }
  const shortOrg = o => String(o || "").replace(/\s+(Private\s+)?(Limited|Ltd\.?|Inc\.?|LLC|Co\.,? Ltd\.?|Corporation|Communications? Corp(oration)?)$/i, "");

  function hero(final) {
    const rows = LIST.map(c => rowOf(c.id)).filter(Boolean);
    drawMap(rows, me());
    const v = $("#verdict");
    if (D.kind === "pop" || !v) return;
    fillCond(final);
    if (D.kind === "cdn") return heroCdn(rowOf(D.cdn), final);
    if (!final) { v.textContent = t("v_wait"); v.className = "verdict"; return; }
    const s = summary(LIST.map(c => rowOf(c.id) || { id: c.id, ms: null }));
    // a shared result without its place: no distances, by the sharer's choice
    if (SHOWN && !me() && s.key === "v_noloc") s.key = "v_hidden";
    v.textContent = t(s.key);
    v.className = "verdict " + ({ v_good: "t1", v_mixed: "warn", v_far: "bad", v_none: "bad" }[s.key] || "");
    $("#vsub").textContent = s.located ? t("v_sub", { n: s.located, near: s.near, far: s.far }) : " ";
    $("#stNear").textContent = s.located ? `${s.near} / ${s.located}` : "–";
    $("#stNear").className = s.located ? (s.near * 4 >= s.located * 3 ? "t1" : s.near * 3 <= s.located ? "t5" : "t3") : "";
    const n = LIST.filter(c => R[c.id] && R[c.id].ms != null).length;
    // direct and through a proxy apart, when the test had both: one median of the two would describe neither
    const ok = LIST.map(c => rowOf(c.id)).filter(x => x && x.ms != null), by = k => ok.filter(x => x.route.x && x.route.x[0] === k).map(x => x.ms);
    const mD = median(by("D")), mP = median(by("P"));
    if (mD != null && mP != null) {
      $("#stMed").innerHTML = `<span class="${msTier(mD)}">D ${esc(msTxt(mD))}</span> <span class="${msTier(mP)}">P ${esc(msTxt(mP))}</span>`;
      $("#stMed").className = "two";
      $("#stMedS").textContent = t("st_med_dp", { d: by("D").length, p: by("P").length });
    } else {
      $("#stMed").textContent = s.med != null ? msTxt(s.med) : "–";
      $("#stMed").className = s.med != null ? msTier(s.med) : "";
      $("#stMedS").textContent = t("st_med_s", { n });
    }
    const f = s.farthest;
    $("#stFar").textContent = f ? kmTxt(f.d) : "–";
    $("#stFar").className = f ? tierOf(f.d)[1] : "";
    $("#stFarS").textContent = f ? `${cdnName(f.id)} · ${f.place[0]}` : " ";
    const items = s.findings.length ? s.findings : [{ kind: "ok", key: "f_none" }];
    $("#finds").innerHTML = items.map(x => `<li class="${x.kind}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON[x.kind]}</svg><span>${esc(x.key === "f_none" ? t("f_none") : finding(x))}</span></li>`).join("");
  }

  // A CDN's page: its own verdict as soon as it has answered. Where it serves you from, how far, how long, and what
  // the round trip says when it doesn't tell its location: light in fiber goes about 100 km per ms of round trip, so
  // the edge that answered is at most that far.
  function heroCdn(x, final) {
    const v = $("#verdict"), id = D.cdn, cdn = cdnName(id), set = (k, b, s, cls) => { $("#" + k).textContent = b; $("#" + k).className = cls || ""; $("#" + k + "S").textContent = s || " "; };
    if (!x) { v.textContent = t("v_wait"); v.className = "verdict"; return; }
    const out = [];
    if (x.ms == null) {
      v.textContent = t("pv_fail", { cdn }); v.className = "verdict bad";
      $("#vsub").textContent = t("pv_fail_sub");
      set("stPop", "–"); set("stDist", "–"); set("stMs", "–");
    } else if (x.code) {
      const where = x.place ? placeTxt(x.place) : x.code, c = popCode(id, x.code);
      v.textContent = t("pv_pop", { cdn, place: where });
      v.className = "verdict " + (x.d == null || x.unsure ? "" : isFar(x) ? "warn" : "t1");
      $("#vsub").textContent = x.d != null ? t("pv_sub", { km: kmTxt(x.d), ms: msTxt(x.ms), floor: msTxt(floorMs(x.dp ?? x.d)) }) : t("pv_sub_noloc", { ms: msTxt(x.ms) });
      set("stPop", c || (x.place ? x.place[0] : x.code), x.place ? (c ? placeTxt(x.place) : country(x.place[1])) : "");
      if (x.d != null && x.unsure) set("stDist", kmTxt(x.d) + "?", t("ex_from_you"));
      else if (x.d != null) { const tier = tierOf(x.d); set("stDist", kmTxt(x.d), t("d_" + tier[2]), tier[1]); } else set("stDist", "–");
      set("stMs", msTxt(x.ms), x.d != null ? t("r_floor", { ms: fmtMs(floorMs(x.dp ?? x.d)) }) : "", msTier(x.ms));
      if (x.d != null && !x.unsure && missedNearest(x.d, x.near)) out.push(["warn", t("f_notnearest_tip", { cdn, code: popCode(id, x.near[0]), place: placeTxt(x.near[1]), km: kmTxt(x.near[2]) })]);
      if (x.d != null && !x.unsure && detoured(x.ms, x.dp ?? x.d)) out.push(["warn", t("f_slow_tip", { floor: msTxt(floorMs(x.dp ?? x.d)), km: kmTxt(x.dp ?? x.d) })]);
    } else {
      // timed only (or it didn't say): the round trip, and how far the edge can be at most
      v.textContent = t(BY[id].read ? "pv_nopop" : "pv_timed", { cdn, ms: msTxt(x.ms) }); v.className = "verdict " + (x.ms < FAST ? "t1" : x.ms < 80 ? "" : "warn");
      $("#vsub").textContent = t("pv_bound", { km: kmTxt(x.ms * 100) });
      set("stPop", t("r_hidden")); set("stDist", "≤ " + kmTxt(x.ms * 100)); set("stMs", msTxt(x.ms), "", msTier(x.ms));
    }
    // which way it went, when the visitor's traffic has more than one
    if (x.ms != null && x.multi) {
      const r = x.route, e = r.x && exitBy(r.x);
      out.unshift(!r.x ? ["warn", t("pv_route_q", { cdn })] : r.x[0] === "D" ? ["ok", t("pv_route_d", { cdn, x: r.x })]
        : ["warn", t("pv_route_p", { cdn, x: r.x, where: e ? exitWhere(e) : r.x })]);
    }
    // next to the others, once they are all in
    const all = CDNS.filter(c => R[c.id] && R[c.id].ms != null);
    if (final && x.ms != null && all.length > 1) out.push(["ok", t("pv_rank", { rank: all.filter(c => R[c.id].ms < x.ms).length + 1, n: all.length })]);
    if (final || out.length) $("#finds").innerHTML = (out.length ? out : [["ok", t("f_none")]]).map(([k, s]) => `<li class="${k}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg><span>${esc(s)}</span></li>`).join("");
  }

  // the visitor: city and country, and their network
  function fillYou() {
    const el = $("#you"), net = $("#youNet");
    if (!el) return;
    const m = me();
    if (SHOWN) { el.textContent = m ? [m.city, country(m.cc)].filter(Boolean).join(", ") : t("you_hidden"); if (net) net.textContent = SHOWN.isp || ""; return; }
    if (!m) { el.textContent = t("you_unknown"); return; }
    // every exit a proxy: the place is the proxy's, not the visitor's
    const viaProxy = !m.precise && EX.list.length && !EX.list.some(e => e.kind === "D");
    el.innerHTML = esc([m.city, country(m.cc)].filter(Boolean).join(", ")) + (m.precise ? ` ${tag(t("precise_on"), "t1")}` : viaProxy ? ` ${tag(t("you_proxy"), "warn", t("you_proxy_tip"))}` : "");
    // its network on ASN Lookup: a value made into a link, so a dotted underline and a title, not the external-link mark
    const as = m.asn ? (ASN ? `<a class="q0" href="${esc(ASN + "AS" + m.asn)}" title="${esc(t("asn_t"))}" target="_blank" rel="noopener">AS${m.asn}</a>` : "AS" + m.asn) : "";
    if (net) { net.innerHTML = [esc((m.org || "").replace(/\s+(Private\s+)?(Limited|Ltd\.?|Inc\.?|LLC|Co\.,? Ltd\.?|Corporation)$/i, "")), as].filter(Boolean).join(" "); net.title = m.org || ""; }
  }

  const total = LIST.length;
  let done = 0, t0 = 0;
  function progress() {
    const p = $("#prog i"), pt = $("#progTxt");
    if (p) p.style.transform = `scaleX(${done / total})`;
    if (pt) pt.textContent = t("progress", { n: done, of: total });
  }
  const redraw = () => { if (!SHOWN) regroup(); LIST.forEach(c => fillRow(c.id)); hero(done === total && (EX.ready || !!SHOWN)); fillYou(); if (D.kind === "pop") fillPop(); };

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, runs = 0;
  async function start() {
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang] === D.home ? location.pathname.replace(/\/r\/.*$/, "/") : location.pathname); }
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    R = {}; SHOWN = null; LAST = null; done = 0; t0 = performance.now();
    if ($("#shareBtn")) $("#shareBtn").disabled = true;
    if ($("#rerun")) $("#rerun").disabled = true;
    $("#prog") && $("#prog").classList.remove("end");
    // the exits anew each time: routing rules and proxies change
    if (runs++) geoP = loadSelf();
    const exP = findExits();
    redraw(); progress();
    await Promise.all([popsP, placesP]);
    geoP.then(() => { if (!ctl.signal.aborted) redraw(); });
    // a few at a time: twenty connections at once would queue behind each other on a slow link
    // a CDN's page tests its own CDN first, so its verdict comes first
    const queue = D.kind === "cdn" ? [BY[D.cdn], ...LIST.filter(c => c.id !== D.cdn)] : [...LIST];
    const worker = async () => {
      for (let c; (c = queue.shift());) {
        let x;
        try { x = await probe(c, ctl.signal); } catch (e) { return; }
        if (ctl.signal.aborted) return;
        R[c.id] = x; done++;
        // a trace names the address the request came from, and the Cloudflare location it reached
        if (x.ip) addExit(x.ip, c.id, c.id === "cfchina" ? { coloCn: x.code } : { colo: x.code });
        progress(); redraw();
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    if (ctl.signal.aborted) return;
    await Promise.all([geoP, exP]);
    if (ctl.signal.aborted) return;
    EX.ready = true;
    RUN = null;
    redraw();
    $("#prog") && $("#prog").classList.add("end");
    if ($("#progTxt")) $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(1) });
    if ($("#rerun")) $("#rerun").disabled = false;
    LAST = { ts: Date.now() };
    if ($("#shareBtn")) $("#shareBtn").disabled = false;
  }

  // a precise location: the browser's, when the visitor asks (the IP's city can be hundreds of km off)
  const pBtn = $("#precise");
  if (pBtn) {
    if (!navigator.geolocation) pBtn.hidden = true;
    pBtn.onclick = () => {
      pBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(p => {
        PRECISE = { lat: p.coords.latitude, lon: p.coords.longitude, precise: true };
        pBtn.hidden = true; redraw();
      }, () => { pBtn.disabled = false; pBtn.textContent = t("precise_no"); }, { timeout: 15000, maximumAge: 600000 });
    };
  }

  /* ---------- a location page: is this the location you get? ---------- */
  function fillPop() {
    const el = $("#popRes");
    if (!el) return;
    const x = rowOf(D.cdn), here = D.pop;
    if (!x) { el.className = "pop-res"; el.textContent = t("v_wait"); return; }
    if (x.ms == null) { el.className = "pop-res bad"; el.textContent = t("pr_fail", { cdn: cdnName(D.cdn) }); return; }
    const same = x.code === here.code;
    const where = x.place ? (popCode(D.cdn, x.code) ? popCode(D.cdn, x.code) + ", " : "") + placeTxt(x.place) : x.code || "—";
    el.className = "pop-res " + (same ? "t1" : "");
    el.innerHTML = esc(same ? t("pr_same", { ms: msTxt(x.ms) }) : t("pr_other", { pop: where, ms: msTxt(x.ms) })) +
      (x.place && !same ? ` <a href="${esc(D.popHref[BY[D.cdn].list] + x.code.toLowerCase() + "/")}">${esc(t("pr_open"))}</a>` : "");
    // how far this location is from the visitor
    const m = me(), d = $("#popDist");
    if (d && m && m.lat != null) d.textContent = t("pr_dist", { km: kmTxt(km(m.lat, m.lon, here.lat, here.lon)), floor: msTxt(floorMs(km(m.lat, m.lon, here.lat, here.lon))) });
  }

  /* ---------- a site: which CDN, and which of its locations answers you ---------- */
  const siteForm = $("#siteForm");
  let SCTL = null;
  async function checkSite(host) {
    if (SCTL) SCTL.abort();
    const ctl = SCTL = new AbortController(), sig = ctl.signal;
    const res = $("#siteRes"), out = { host, cdn: null, code: null, ms: null, cname: null };
    SITE = null;
    res.hidden = false; res.className = "site-res wait"; res.title = "";
    res.innerHTML = `<b class="host">${esc(host)}</b><span class="m">${esc(t("s_wait"))}</span>`;
    // the DNS: a CNAME that names the CDN, or one of Cloudflare's addresses
    const dp = dns(host, sig).then(d => {
      if (!d) return;
      for (const n of d.cnames) { const c = cdnOfName(n); if (c) { out.cdn = out.cdn || c; out.cname = n; break; } }
      if (!out.cdn && d.ips.some(isCloudflareIP)) out.cdn = "cloudflare";
    }).catch(() => {});
    // the location: Cloudflare's trace on the site itself, then the headers and Server-Timing of its favicon (only
    // what the site lets a page read)
    const base = "https://" + host;
    let timeUrl = base + "/favicon.ico";
    try {
      const tr = await once(base + "/cdn-cgi/trace", true, 6000, sig);
      const colo = PARSE.trace(tr.body);
      if (colo) { out.cdn = "cloudflare"; out.code = colo; timeUrl = base + "/cdn-cgi/trace"; }
    } catch (e) { if (sig.aborted) return; }
    if (!out.code) {
      let x = null;
      try { x = await once(timeUrl, true, 6000, sig); } catch (e) { if (sig.aborted) return; }
      if (x) for (const [h, id] of SITE_HEADERS) { const c = readPop("h:" + h, x); if (c) { out.cdn = id; out.code = c; break; } }
      if (!out.code) {
        // no CORS: a no-cors request still has Server-Timing when the site sends Timing-Allow-Origin
        try { x = await once(timeUrl, false, 6000, sig); } catch (e) { if (sig.aborted) return; }
        if (x) for (const [n, id] of SITE_TIMING) { const c = readPop("st:" + n, x); if (c) { out.cdn = id; out.code = c; break; } }
      }
    }
    await dp;
    if (sig.aborted) return;
    // the round trip: the same file, on a warm connection
    const r = await probe({ url: timeUrl, read: null }, sig).catch(() => null);
    if (sig.aborted) return;
    out.ms = r ? r.ms : null;
    SITE = out; fillSite();
    if ($("#shareBtn") && LAST) $("#shareBtn").disabled = false;
  }
  function fillSite() {
    const res = $("#siteRes"), x = SITE;
    if (!res || !x) return;
    const place = x.code && BY[x.cdn] ? placeOf(x.cdn, x.code, DATA.pops || {}, DATA.places) : null, m = me();
    const d = place && m && m.lat != null ? km(m.lat, m.lon, place[2], place[3]) : null;
    const cdn = x.cdn ? cdnName(x.cdn) : null;
    // the site, then what was found: its CDN, the location that answered, how far, how long
    const bits = [
      cdn ? `<i class="chip" style="--c:${BY[x.cdn] ? BY[x.cdn].c : "var(--muted)"}"><i class="dot"></i>${esc(cdn)}</i>` : `<span class="m">${esc(t("s_nocdn"))}</span>`,
      x.code ? `<span><b>${esc(popCode(x.cdn, x.code) || (place && place[0]) || x.code)}</b> ${esc(place ? (popCode(x.cdn, x.code) ? placeTxt(place) : country(place[1])) : "")}</span>` : cdn ? `<span class="m">${esc(t("s_nopop"))}</span>` : "",
      d != null ? `<b class="${tierOf(d)[1]}">${esc(kmTxt(d))}</b>` : "",
      x.ms != null ? `<b class="${msTier(x.ms)}">${esc(msTxt(x.ms))}</b>` : `<span class="bad">${esc(t("r_fail"))}</span>`,
    ].filter(Boolean);
    res.className = "site-res";
    res.innerHTML = `<b class="host">${esc(x.host)}</b>${bits.join('<i class="sep"></i>')}`;
    res.title = x.cname ? "CNAME " + x.cname : "";
  }
  if (siteForm) {
    siteForm.onsubmit = e => {
      e.preventDefault();
      const h = hostOf($("#siteIn").value), res = $("#siteRes");
      if (!h) { res.hidden = false; res.className = "site-res"; res.innerHTML = `<span class="bad">${esc(t("s_bad"))}</span>`; return; }
      $("#siteIn").value = h;
      checkSite(h);
    };
  }

  /* ---------- a shared result ---------- */
  // Opening /r/<code> shows that result as the test drew it, and doesn't test until the visitor asks
  async function showShared(S) {
    await Promise.all([popsP, placesP]);
    // the sharer's exits (their places only when they showed theirs); several when the rows went different ways
    const letters = new Set(S.rows.filter(x => x.route).map(x => x.route.x));
    SHOWN = { where: S.where, exits: S.exits.map(e => ({ ...e, kind: e.letter[0] })), multi: letters.size > 1 || S.rows.some(x => x.route && x.route.how !== "one") };
    R = Object.fromEntries(S.rows.map(x => [x.id, { ms: x.ms, code: x.code, route: x.route, err: x.ms == null ? "fail" : null }]));
    done = total;
    if (S.site) { SITE = S.site; if ($("#siteIn")) $("#siteIn").value = S.site.host; }
    redraw(); fillSite();
    $("#sharedTxt").textContent = t("shared_on", { where: S.where && S.where.cc ? t("shared_where", { where: [S.where.city, country(S.where.cc)].filter(Boolean).join(", ") }) : "",
      date: new Date(S.ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" }) });
    if (S.isp) $("#sharedTxt").textContent += " · " + S.isp;
    $("#shared").hidden = false;
    $("#prog").classList.add("end"); $("#progTxt").innerHTML = "&nbsp;";
    $("#rerun").disabled = false;
    LAST = { ts: S.ts, shared: S }; $("#shareBtn").disabled = false;
  }

  /* ---------- share: the 1ms.dog share dialog (1ms-shell assets/share/, copied verbatim to /assets/share/) ---------- */
  const shareBtn = $("#shareBtn");
  if (shareBtn) shareBtn.onclick = async () => {
    if (!LAST) return;
    const S = LAST.shared || null, m = S ? S.where : me();
    // each row with the exit it took (the letter only: no address), and the exits' places when the sharer shows theirs
    const rows = S ? S.rows : LIST.map(c => R[c.id] ? { id: c.id, code: R[c.id].code, ms: R[c.id].ms, route: EX.list.length ? EX.rt[c.id] : null } : null).filter(Boolean);
    const exs = S ? S.exits : exits().filter(e => e.kind === "P");
    const site = S ? S.site : SITE ? { cdn: SITE.cdn, code: SITE.code, ms: SITE.ms, host: SITE.host } : null;
    const isp = S ? S.isp : m && m.org || "";
    const where = m && m.cc ? { cc: m.cc, lat: m.lat, lon: m.lon, city: m.city || "" } : null;
    const { share } = await import("/assets/share/share.js");
    share({
      lang: D.lang, name: t("app_name"), file: "cdn-radar",
      show: ["city", "isp"], never: ["ip"], canShow: !!where,
      link: show => location.origin + D.home + "r/" + encodeShare({ ts: LAST.ts, where: show ? where : null, isp: show ? isp : "", rows, site, exits: show ? exs : null }),
      home: location.origin + D.home,
      text: () => { const b = rows.filter(x => x.ms != null).sort((a, b) => a.ms - b.ms)[0]; return b ? t("share_text", { cdn: cdnName(b.id), ms: msTxt(b.ms) }) : t("app_name"); },
      height: 330 + Math.ceil(rows.length / 2) * 56 + (site ? 110 : 0),
      draw: (x, kit) => drawCard(x, kit, rows, site),
      foot: show => [t("card_sub"), show && where && [where.city, country(where.cc)].filter(Boolean).join(", "), show && isp].filter(Boolean),
      ts: LAST.ts,
    }).open();
  };

  // The middle of the card: the verdict, and every CDN with the location that answered and its round trip; never an
  // address, and distances only when the visitor shows their city (they would place it otherwise)
  function drawCard(x, kit, rows, site) {
    const { W, P, F, M, v, clip } = kit;
    const C = { fg: v("fg"), muted: v("muted"), line: v("line"), warn: v("warn"), bad: v("bad"), t1: v("t1") };
    let y = kit.top + 64;
    x.textBaseline = "alphabetic"; x.textAlign = "left";
    x.fillStyle = C.fg; x.font = `750 40px ${F}`; x.fillText(clip(x, $("#verdict") ? $("#verdict").textContent : t("app_name"), W - 2 * P), P, y);
    y += 46;
    x.fillStyle = C.muted; x.font = `500 22px ${F}`; x.fillText(clip(x, $("#vsub") ? $("#vsub").textContent : "", W - 2 * P), P, y);
    y += 50;
    const colW = (W - 2 * P - 40) / 2;
    // the exit each row took, when they went different ways
    const multi = new Set(rows.map(r => r.route && r.route.x).filter(Boolean)).size > 1;
    rows.forEach((r, i) => {
      const cx = P + (i % 2) * (colW + 40), cy = y + Math.floor(i / 2) * 56;
      const place = r.code ? placeOf(r.id, r.code, DATA.pops || {}, DATA.places) : null;
      x.fillStyle = BY[r.id].c; x.beginPath(); x.arc(cx + 7, cy - 8, 7, 0, Math.PI * 2); x.fill();
      x.fillStyle = C.fg; x.font = `650 23px ${F}`;
      const name = BY[r.id].short || cdnName(r.id);
      x.fillText(clip(x, name, colW * .42), cx + 24, cy);
      x.fillStyle = C.muted; x.font = `500 21px ${F}`;
      const where = r.code ? [popCode(r.id, r.code), place && (popCode(r.id, r.code) ? place[0] : place[0])].filter(Boolean).filter((s, j, a) => a.indexOf(s) === j).join(" ") : "—";
      x.fillText(clip(x, where, colW * .38), cx + 24 + colW * .42, cy);
      x.textAlign = "right"; x.fillStyle = r.ms == null ? C.bad : C.fg; x.font = `650 22px ${M}`;
      x.fillText(r.ms == null ? "—" : (multi ? (r.route && r.route.x || "?") + " " : "") + msTxt(r.ms), cx + colW, cy); x.textAlign = "left";
    });
    if (site) {
      const sy = y + Math.ceil(rows.length / 2) * 56 + 16;
      x.strokeStyle = C.line; x.lineWidth = 2; x.beginPath(); x.moveTo(P, sy - 34); x.lineTo(W - P, sy - 34); x.stroke();
      x.fillStyle = C.fg; x.font = `650 23px ${F}`; x.fillText(clip(x, site.host, W * .4), P, sy);
      x.fillStyle = C.muted; x.font = `500 21px ${F}`;
      x.fillText(clip(x, [site.cdn ? cdnName(site.cdn) : t("s_nocdn"), site.code].filter(Boolean).join(" · "), W * .4), P + W * .42, sy);
      x.textAlign = "right"; x.fillStyle = C.fg; x.font = `650 22px ${M}`; x.fillText(site.ms == null ? "—" : msTxt(site.ms), W - P, sy); x.textAlign = "left";
    }
  }

  if ($("#rerun")) $("#rerun").onclick = start;
  $("#testMine").onclick = start;
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  geoP.then(fillYou);
  if (SHARED && D.kind !== "pop") showShared(SHARED);
  else {
    // ?site=: a link someone sent to test this site from here
    const q = new URLSearchParams(location.search).get("site"), h = q && hostOf(q);
    if (h && siteForm) { $("#siteIn").value = h; Promise.all([popsP, placesP]).then(() => checkSite(h)); }
    start();
  }
})();
