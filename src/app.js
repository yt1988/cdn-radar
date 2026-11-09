// CDN Radar page. Every CDN's row is in the HTML from the start; the CDNs are timed at once (src/probe.mjs) and fill
// their rows as they answer: which location answered, how far it is from the visitor, and the round trip next to the
// fastest one the distance allows. The map and the verdict follow. A location page (/<cdn>/<code>/) tests its one CDN.
// Strings: window.L1MS.
import { CDNS, BY, HOSTS, nameOf, placeOf, popMaps, SITE_HEADERS, SITE_TIMING, PARSE, cdnOfName, isCloudflareIP } from "./cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, FAST, isFar, blame, encode as encodeShare, decode as decodeShare, sharePath, hostOf } from "./lib.mjs";
import { probe, dns, once, readPop } from "./probe.mjs";
import { reportOf } from "./report.mjs";

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
  // Taiwan is "中国台湾 / Taiwan, China" (1ms-shell docs/tool-contract.md §5); every other region by its system name
  const TW = { "zh-CN": "中国台湾", "zh-TW": "中國台灣", en: "Taiwan, China", ja: "中国台湾", ko: "중국 대만", es: "Taiwán, China", fr: "Taïwan, Chine", de: "Taiwan, China", pt: "Taiwan, China", ru: "Тайвань, Китай" };
  const country = cc => { if (cc === "TW") return TW[D.lang]; try { return regionNames ? regionNames.of(cc) : cc; } catch (e) { return cc; } };
  const cdnName = id => BY[id] ? nameOf(BY[id], D.lang) : id;
  // a location for people: "HKG · Hong Kong, 香港" → code and where; Akamai names cities, not codes
  const popCode = (id, code) => id === "akamai" || id === "cdn77" ? "" : code;
  const placeTxt = p => p ? (p[0] && p[1] ? `${p[0]}, ${country(p[1])}` : p[0] || country(p[1])) : "";

  /* ---------- data: the locations of the CDNs that publish them, where codes are, and where the visitor is ---------- */
  const DATA = { pops: null };
  let POPU = "";   // data/pops.json's "updated": the day the location lists were made (a problem report carries it)
  const getJ = (u, opt) => fetch(u, opt).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const popsP = getJ("/assets/" + D.files.pops).then(j => { DATA.pops = popMaps(j); POPU = j.updated || ""; }).catch(() => { DATA.pops = {}; });
  // Where the codes are that the CDNs' own lists don't hold (IATA codes, Akamai's cities): asked from this site's
  // Worker as they come up, a few at a time (/places; data/places.json is 260 KB, a page needs a handful of it)
  const PLACES = {}, asking = new Set();
  let askT = 0;
  function placeAt(id, code) {
    if (!code) return null;
    const own = placeOf(id, code, DATA.pops || {}, null);
    if (own) return own;
    const k = id + ":" + code;
    if (k in PLACES) return PLACES[k];
    if (!asking.has(k)) { asking.add(k); clearTimeout(askT); askT = setTimeout(askPlaces, 30); }
    return null;
  }
  function askPlaces() {
    const ks = [...asking].filter(k => !(k in PLACES));
    asking.clear();
    if (!ks.length) return;
    getJ("/places?q=" + encodeURIComponent(ks.join(","))).then(j => { for (const k of ks) PLACES[k] = j[k] || null; redraw(); fillSite(); fillTokyo(); fillEcs(); })
      .catch(() => { for (const k of ks) PLACES[k] = null; });
  }
  // where the visitor is: this site's Worker reads Cloudflare's guess from the request (/geo); null when self-hosted
  // as plain files. A precise location, when the visitor asks for one, replaces the coordinates.
  let U = null;
  const geoP = getJ("/geo", { cache: "no-store" }).then(j => { if (j && j.lat != null) U = j; }).catch(() => {});

  /* ---------- a CDN's page: the same test from 1ms.dog's server in Tokyo, and where the CDN's DNS sends each ISP ---------- */
  // both come from jobs on that server (server/), through this site's Worker (/tokyo, /ecs); a section stays hidden
  // until its data is there
  let TK = null, EC = null;
  const when = ts => new Date(ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" });
  const pct = x => { try { return new Intl.NumberFormat(D.lang, { style: "percent" }).format(x); } catch (e) { return Math.round(x * 100) + "%"; } };
  const popTxt = (id, code) => { if (!code) return "—"; const p = placeAt(id, code); return [popCode(id, code), p && p[0]].filter(Boolean).filter((s, j, l) => l.indexOf(s) === j).join(" ") || code; };
  function fillTokyo() {
    const box = $("#tokyo");
    if (!box || !TK || !TK.latest) return;
    const id = D.cdn, items = [];
    for (const f of [4, 6]) {
      const k = id + "/" + f, x = TK.latest.r[k], K = TK.keys && TK.keys[k];
      if (!x) continue;
      const now = x[1] == null ? `<span class="bad">${esc(t("tk_fail"))}</span>` : esc(x[0] ? t("tk_now", { pop: popTxt(id, x[0]), ms: msTxt(x[1]) }) : t("tk_timed", { ms: msTxt(x[1]) }));
      let past = "";
      if (K && K.n) {
        const share = Object.entries(K.codes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${popTxt(id, c)} ${pct(n / K.n)}`).join(" · ");
        past = t(share ? "tk_30" : "tk_30_timed", { share, ms: K.med != null ? msTxt(K.med) : "—", ok: pct(K.ok / K.n) });
      }
      items.push(`<li><b>IPv${f}</b><span>${now}</span><span class="m">${esc(past)}</span></li>`);
    }
    if (!items.length) return;
    $("#tkList").innerHTML = items.join("");
    $("#tkAt").textContent = t("tk_at", { time: when(TK.latest.t) });
    const ch = (TK.changes || []).filter(c => c[1].startsWith(id + "/")).slice(-6).reverse();
    $("#tkCh").innerHTML = ch.length ? ch.map(([ts, k, a, b]) => `<li>${esc(t("tk_ch", { time: when(ts), fam: "IPv" + k.split("/")[1], from: popTxt(id, a), to: popTxt(id, b) }))}</li>`).join("")
      : `<li class="m">${esc(t("tk_ch_none"))}</li>`;
    box.hidden = false;
  }
  function fillEcs() {
    const box = $("#ecs");
    if (!box || !EC || !EC.cdns || !EC.cdns[D.cdn]) return;
    const id = D.cdn, res = EC.cdns[id], mine = U && U.asn;
    // an ISP by its brand, or by its name in the page language where it has one (the Chinese ISPs, in Chinese)
    const nameOfNet = n => D.lang in n.name ? n.name[D.lang] : n.name.en;
    $("#ecsT").innerHTML = `<thead><tr><th>${esc(t("ecs_isp"))}</th><th>${esc(t("ecs_cc"))}</th><th>${esc(t("ecs_pop"))}</th></tr></thead><tbody>` +
      EC.nets.map(n => {
        const x = res[n.asn] || {}, you = mine && +mine === n.asn;
        const pop = x.code ? esc(popTxt(id, x.code)) : `<span class="m">${esc(t("ecs_none"))}</span>`;
        return `<tr${you ? ' class="you"' : ""}><td>${esc(nameOfNet(n))}${you ? " " + tag(t("ecs_you"), "t1") : ""} <span class="m">AS${n.asn}</span></td><td>${esc(country(n.cc))}</td><td>${pop}</td></tr>`;
      }).join("") + `</tbody>`;
    $("#ecsAt").textContent = t("ecs_at", { time: when(EC.t) });
    box.hidden = false;
  }
  if ($("#tokyo")) getJ("/tokyo?cdn=" + D.cdn).then(j => { TK = j; fillTokyo(); }).catch(() => {});
  if ($("#ecs")) Promise.all([getJ("/ecs?cdn=" + D.cdn), geoP]).then(([j]) => { EC = j; fillEcs(); }).catch(() => {});

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
  // a CDN or location page tests that one CDN; the home page tests them all (1ms-shell tool-contract: subpages)
  const LIST = D.kind === "pop" || D.kind === "cdn" ? [BY[D.cdn]] : CDNS;
  let R = {};            // results so far, by CDN id: { ms, code, err, loc? }
  let SHOWN = null;      // a shared result being shown: its visitor location (or null)
  let SITE = null;       // the site check's result
  let SUB = "";          // the verdict's second line, for the share card (the page shows it in the numbers)
  const me = () => SHOWN ? SHOWN.where : U;
  const listFmt = (() => { try { return new Intl.ListFormat(D.lang, { type: "conjunction" }); } catch (e) { return { format: a => a.join(", ") }; } })();
  // Chinese and Japanese: names that are mostly Latin read better apart with 「、」 than run into 和/と
  const names = ids => /^(zh|ja)/.test(D.lang) ? ids.map(cdnName).join("、") : listFmt.format(ids.map(cdnName));

  // a row's result with its place, distance and flags
  function rowOf(id) {
    const x = R[id];
    if (!x) return null;
    const place = x.code && DATA.pops ? placeAt(id, x.code) : null, m = me();
    const d = place && m && m.lat != null ? km(m.lat, m.lon, place[2], place[3]) : null;
    const list = BY[id] && BY[id].list && DATA.pops && DATA.pops[BY[id].list];
    const near = d != null && list && m ? nearest(id === "cfchina" ? Object.fromEntries(Object.entries(list).filter(([, p]) => p[1] === "CN")) : list, m.lat, m.lon) : null;
    return { id, code: x.code, ms: x.ms, err: x.err, place, d, near, loc: x.loc };
  }

  // a round trip's color: near (t1) to far (t5)
  const msTier = ms => ms < FAST ? "t1" : ms < 80 ? "t2" : ms < 150 ? "t3" : ms < 250 ? "t4" : "t5";
  const tag = (txt, cls, why) => `<i class="tag ${cls}"${why ? ` data-why="${esc(why)}" tabindex="0"` : ""}>${esc(txt)}</i>`;
  // the bars share one scale: the slowest so far, at least 200 ms
  const scale = () => Math.max(200, ...Object.values(R).filter(x => x.ms != null).map(x => x.ms));
  const barHTML = ms => `<i class="rb"><i class="${msTier(ms)}" style="transform:scaleX(${Math.max(.02, Math.min(1, ms / scale())).toFixed(3)})"></i></i>`;

  function fillRow(id) {
    const row = ROW[id];
    if (!row) return;
    const x = rowOf(id), cdn = BY[id];
    row.classList.toggle("wait", !x);
    row.classList.toggle("bad", !!x && x.ms == null);
    const failTxt = x && t(x.err === "timeout" ? "r_timeout" : "r_fail");
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
      const missed = x.d != null && missedNearest(x.d, x.near)
        ? " " + tag(t("f_notnearest"), "warn", t("f_notnearest_tip", { cdn: cdnName(id), code: popCode(id, x.near[0]), place: placeTxt(x.near[1]), km: kmTxt(x.near[2]) })) : "";
      cp.innerHTML = `<b>${code}</b> <span>${esc(x.place ? (c ? placeTxt(x.place) : country(x.place[1])) : t("r_unknown"))}</span>${missed}`;
    } else cp.innerHTML = x.ms == null ? `<span class="bad">${esc(failTxt)}</span>` : `<b>—</b> <span>${esc(t("r_nopop"))}</span>`;
    // how far
    if (x.d != null) { const tier = tierOf(x.d); cd.innerHTML = `<b class="${tier[1]}">${esc(kmTxt(x.d))}</b> ${tag(t("d_" + tier[2]), tier[1])}`; }
    else cd.innerHTML = `<b>—</b>`;
    // how long: the least the distance allows on hover, "long way round" when it is far beyond that
    if (x.ms != null) {
      const floor = x.d != null ? t("r_floor", { ms: fmtMs(floorMs(x.d)) }) : "";
      const slow = x.d != null && detoured(x.ms, x.d) ? tag(t("f_slow"), "warn", t("f_slow_tip", { floor: msTxt(floorMs(x.d)), km: kmTxt(x.d) })) + " " : "";
      cm.innerHTML = `<b><span>${slow}</span><span${floor ? ` data-why="${esc(floor)}"` : ""}>${esc(msTxt(x.ms))}</span></b>${barHTML(x.ms)}`;
    } else cm.innerHTML = `<b>—</b><i class="rb"><i></i></i>`;
  }

  // the hero: the verdict, four numbers, and what stands out
  const ICON = { ok: '<path d="M3.5 8.5l3 3 6-7"/>', warn: '<path d="M8 3.5v5.5M8 12v.5"/>', bad: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    why: '<path d="M8 7.2v4.6M8 4.4v.4"/>' };
  // A finding: one short line naming the CDNs it is about (the numbers are in the stats and the table); a reason ends
  // with a link to the help answer that says it in full
  function finding(f) {
    const s = esc(t(f.key, { list: names(f.ids), n: f.n, ms: msTxt(FAST), country: f.cc ? country(f.cc) : "" }));
    return f.kind === "why" ? `${s} <button class="lnk" type="button" data-help="1">${esc(t("why_more"))}</button>` : s;
  }
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-help]");
    if (!b) return;
    $("#helpBtn").click();
    const q = $(`[data-hq="${b.dataset.help}"]`);
    if (q) q.click();
  });

  // The visitor's DNS resolver, as 1ms.dog's own name server saw it (dns-test's l.1ms.dog): the page looks up a name
  // made for this run, which reaches that server through the resolver, and the answer says who asked and whether it
  // passed on the visitor's subnet. It tells a far location chosen by DNS from one chosen by the route (lib.blame).
  // Kept for this run only: never in a share link, a share card or a problem report. Only on 1ms.dog.
  let RES = null;
  async function askResolver(ctl) {
    RES = null;
    if (!/(^|\.)1ms\.dog$/.test(location.hostname) || SHOWN) return;
    const tok = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join("");
    try {
      const j = await getJ(`https://${tok}-c.l.1ms.dog:2053/`, { cache: "no-store", signal: ctl.signal });
      // the lookups that answered the browser come first; more can come a few hundred ms later, often from other
      // addresses of the same ISP (other paths, a prefetch), sometimes passing a subnet the first ones didn't (China
      // Unicom, 2026-11-04). The server waits for those too (600 ms after the first); the first ones say who answered.
      const all = (j.hits || []).filter(h => h.zone === "l"), early = all.filter(h => h.ms <= 150), hits = early.length ? early : all;
      if (!hits.length || ctl.signal.aborted) return;
      // a resolver pool can ask from several addresses: the country most of them are in
      const by = {};
      for (const h of hits) if (h.cc) by[h.cc] = (by[h.cc] || 0) + 1;
      const cc = Object.keys(by).sort((a, b) => by[b] - by[a])[0] || null, h = hits.find(x => x.cc === cc) || hits[0];
      // a subnet the first lookups passed on; or only later ones (then which one the CDN's answer used can't be told)
      const ecs = (hits.find(x => x.ecs) || {}).ecs || null;
      RES = { cc, org: h.org || (h.asn ? "AS" + h.asn : ""), ecs, ecsLater: !ecs && all.some(x => x.ecs), geo: j.geo || "" };
      redraw();
    } catch (e) {}
  }
  // Why the far ones are far: one line per reason (DNS or the route), naming the CDNs it applies to
  function whys(ids) {
    const m = me(), by = {};
    for (const id of ids) {
      const x = rowOf(id), k = blame(id, RES, m && m.cc, x && x.place ? x.place[1] : null);
      if (k) (by[k] = by[k] || []).push(id);
    }
    return Object.entries(by).map(([key, l]) => ({ kind: "why", key, ids: l, cc: RES && RES.cc }));
  }
  // the resolver itself: one quiet line under the findings, with DB-IP's credit (its license asks for it next to what
  // it placed)
  function fillRes(final) {
    const el = $("#resLine");
    if (!el) return;
    el.hidden = !(final && RES && !SHOWN);
    if (el.hidden) return;
    el.innerHTML = esc(t("at_res", { org: RES.org || "—", country: RES.cc ? country(RES.cc) : "—", ecs: t(RES.ecs ? "at_ecs_yes" : RES.ecsLater ? "at_ecs_some" : "at_ecs_no") })) +
      ` · <a href="https://db-ip.com" target="_blank" rel="noopener" title="${esc(RES.geo)}">DB-IP</a>`;
  }
  const FINDS0 = $("#finds") ? $("#finds").innerHTML : "";   // the findings' placeholders, as the page came
  function hero(final) {
    const rows = LIST.map(c => rowOf(c.id)).filter(Boolean);
    drawMap(rows, me());
    const v = $("#verdict");
    if (D.kind === "pop" || !v) return;
    if (D.kind === "cdn") return heroCdn(rowOf(D.cdn), final);
    // While testing, the numbers and findings of the CDNs that have answered fill in as they come; the verdict waits for
    // all of them. Nothing in yet (a new run): the placeholders again.
    if (!final && !rows.length) {
      v.textContent = t("v_wait"); v.className = "verdict";
      for (const k of ["stNear", "stMed", "stFar"]) { $("#" + k).textContent = "–"; $("#" + k).className = ""; }
      $("#stMedS").textContent = " "; $("#stFarS").textContent = " "; $("#finds").innerHTML = FINDS0;
      return;
    }
    const s = summary(final ? LIST.map(c => rowOf(c.id) || { id: c.id, ms: null }) : rows);
    // a shared result without its place: no distances, by the sharer's choice
    if (SHOWN && !me() && s.key === "v_noloc") s.key = "v_hidden";
    v.textContent = final ? t(s.key) : t("v_wait");
    v.className = "verdict " + (final ? { v_good: "t1", v_mixed: "warn", v_far: "bad", v_none: "bad" }[s.key] || "" : "");
    SUB = s.located ? t("v_sub", { n: s.located, near: s.near, far: s.far }) : "";
    $("#stNear").textContent = s.located ? `${s.near} / ${s.located}` : "–";
    $("#stNear").className = s.located ? (s.near * 4 >= s.located * 3 ? "t1" : s.near * 3 <= s.located ? "t5" : "t3") : "";
    const n = LIST.filter(c => R[c.id] && R[c.id].ms != null).length;
    $("#stMed").textContent = s.med != null ? msTxt(s.med) : "–";
    $("#stMed").className = s.med != null ? msTier(s.med) : "";
    $("#stMedS").textContent = t("st_med_s", { n });
    const f = s.farthest;
    $("#stFar").textContent = f ? kmTxt(f.d) : "–";
    $("#stFar").className = f ? tierOf(f.d)[1] : "";
    $("#stFarS").textContent = f ? `${cdnName(f.id)} · ${f.place[0]}` : " ";
    // what the numbers don't say, most important first, four lines at most: what didn't answer, what missed a nearer
    // location or went a long way round, why the far ones are far, and what answered fast; "nothing stands out" only
    // once everything is in
    const fast = s.findings.filter(x => x.key === "f_fast"), why = whys(s.farIds);
    // far ones with no reason to give (no resolver seen, a shared result): what it costs, so the list never says
    // nothing stands out under a verdict that says they are far
    const far = why.length || !s.farIds.length || s.findings.some(x => x.key === "f_near") ? []
      : [s.farIds.length <= 3 ? { kind: "warn", key: "f_far", ids: s.farIds } : { kind: "warn", key: "f_far_n", ids: [], n: s.farIds.length }];
    const items = [...s.findings.filter(x => x.key !== "f_fast"), ...far, ...why, ...fast].slice(0, 4);
    fillRes(final);
    if (!final && !items.length) { $("#finds").innerHTML = FINDS0; return; }
    setFinds((items.length ? items : [{ kind: "ok", key: "f_none" }]).map(x => [x.kind, finding(x)]));
  }

  // The findings, updated in place: a line that stays keeps its element and only its words change, so the list doesn't
  // paint itself anew each time a CDN answers. items: [kind, html], falsy ones skipped
  function setFinds(items) {
    const ul = $("#finds");
    if (!ul) return;
    const lis = [...ul.children];
    items = items.filter(Boolean);
    items.forEach(([kind, html], i) => {
      let li = lis[i];
      if (!li || li.classList.contains("wait")) {
        const n = document.createElement("li");
        n.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"></svg><span></span>`;
        if (li) li.replaceWith(n); else ul.append(n);
        li = n;
      }
      if (li.className !== kind) { li.className = kind; li.firstChild.innerHTML = ICON[kind]; }
      if (li.lastChild.dataset.h !== html) { li.lastChild.innerHTML = html; li.lastChild.dataset.h = html; }
    });
    for (const li of lis.slice(items.length)) li.remove();
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
      SUB = t("pv_fail_sub"); out.push(["bad", SUB]);
      set("stPop", "–"); set("stDist", "–"); set("stMs", "–");
    } else if (x.code) {
      const where = x.place ? placeTxt(x.place) : x.code, c = popCode(id, x.code);
      v.textContent = t("pv_pop", { cdn, place: where });
      v.className = "verdict " + (x.d == null ? "" : isFar(x) ? "warn" : "t1");
      SUB = x.d != null ? t("pv_sub", { km: kmTxt(x.d), ms: msTxt(x.ms), floor: msTxt(floorMs(x.d)) }) : t("pv_sub_noloc", { ms: msTxt(x.ms) });
      set("stPop", c || (x.place ? x.place[0] : x.code), x.place ? (c ? placeTxt(x.place) : country(x.place[1])) : "");
      if (x.d != null) { const tier = tierOf(x.d); set("stDist", kmTxt(x.d), t("d_" + tier[2]), tier[1]); } else set("stDist", "–");
      set("stMs", msTxt(x.ms), x.d != null ? t("r_floor", { ms: fmtMs(floorMs(x.d)) }) : "", msTier(x.ms));
      // the same short lines as the home page: a nearer location missed, a long way round, and why it is far
      if (x.d != null && x.d >= 1500 && missedNearest(x.d, x.near)) out.push(["warn", finding({ key: "f_near", ids: [id] })]);
      if (x.d != null && x.d < 1500 && detoured(x.ms, x.d)) out.push(["warn", finding({ key: "f_detour", ids: [id] })]);
      if (x.d != null && x.d >= 1500) for (const w of whys([id])) out.push(["why", finding(w)]);
      // far with nothing else to say: what it costs
      if (x.d != null && x.d >= 1500 && !out.length) out.push(["warn", finding({ key: "f_far", ids: [id] })]);
    } else {
      // timed only (or it didn't say): the round trip, and how far the edge can be at most
      v.textContent = t(BY[id].read ? "pv_nopop" : "pv_timed", { cdn, ms: msTxt(x.ms) }); v.className = "verdict " + (x.ms < FAST ? "t1" : x.ms < 80 ? "" : "warn");
      SUB = t("pv_bound", { km: kmTxt(x.ms * 100) }); out.push(["ok", esc(SUB)]);
      set("stPop", t("r_hidden")); set("stDist", "≤ " + kmTxt(x.ms * 100)); set("stMs", msTxt(x.ms), "", msTier(x.ms));
    }
    if (x.ms == null) out[0][1] = esc(out[0][1]);
    // next to the others, once they are all in
    const all = CDNS.filter(c => R[c.id] && R[c.id].ms != null);
    if (final && x.ms != null && all.length > 1) out.push(["ok", esc(t("pv_rank", { rank: all.filter(c => R[c.id].ms < x.ms).length + 1, n: all.length }))]);
    fillRes(final);
    if (final || out.length) setFinds(out.length ? out : [["ok", esc(t("f_none"))]]);
  }

  // the visitor: city and country, and their network
  function fillYou() {
    const el = $("#you"), net = $("#youNet");
    if (!el) return;
    const m = me();
    if (SHOWN) { el.textContent = m ? [m.city, country(m.cc)].filter(Boolean).join(", ") : t("you_hidden"); if (net) net.textContent = SHOWN.isp || ""; return; }
    if (!m) { el.textContent = t("you_unknown"); return; }
    el.innerHTML = esc([m.city, country(m.cc)].filter(Boolean).join(", ")) + (m.precise ? ` ${tag(t("precise_on"), "t1")}` : "");
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
  const redraw = () => { LIST.forEach(c => fillRow(c.id)); hero(done === total); fillYou(); if (D.kind === "pop") fillPop(); };

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, BANNER = null;
  async function start() {
    // from a shared result to the visitor's own test: the page's own address again (the banner stays, its button goes)
    if (BANNER && /\/r\//.test(location.pathname)) history.replaceState(null, "", location.pathname.replace(/\/r\/.*$/, "/"));
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    R = {}; SHOWN = null; LAST = null; done = 0; t0 = performance.now();
    if ($("#shareBtn")) $("#shareBtn").disabled = true;
    if ($("#rerun")) $("#rerun").disabled = true;
    $("#prog") && $("#prog").classList.remove("end");
    redraw(); progress();
    askResolver(ctl);
    // the probes don't wait for the locations list (preloaded in the head): a row that answers before it is in gets
    // its place on the redraw when it comes
    popsP.then(() => { if (!ctl.signal.aborted) redraw(); });
    geoP.then(() => { if (!ctl.signal.aborted) redraw(); });
    // a few at a time: twenty connections at once would queue behind each other on a slow link
    // a CDN's page tests its own CDN first, so its verdict comes first
    const queue = D.kind === "cdn" ? [BY[D.cdn], ...LIST.filter(c => c.id !== D.cdn)] : [...LIST];
    const worker = async () => {
      for (let c; (c = queue.shift());) {
        let x;
        try { x = await probe(c, ctl.signal); } catch (e) { return; }
        if (ctl.signal.aborted) return;
        R[c.id] = x; done++; progress(); redraw();
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    if (ctl.signal.aborted) return;
    await geoP;
    RUN = null;
    redraw();
    $("#prog") && $("#prog").classList.add("end");
    if ($("#progTxt")) $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(1) });
    if ($("#rerun")) $("#rerun").disabled = false;
    LAST = { ts: Date.now() };
    if ($("#shareBtn")) $("#shareBtn").disabled = false;
    if (canReport) rpBtn.hidden = false;
  }

  // a precise location: the browser's, when the visitor asks (the IP's city can be hundreds of km off)
  const pBtn = $("#precise");
  if (pBtn) {
    if (!navigator.geolocation) pBtn.hidden = true;
    pBtn.onclick = () => {
      pBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(p => {
        U = { ...(U || {}), lat: p.coords.latitude, lon: p.coords.longitude, precise: true };
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
    const place = x.code && BY[x.cdn] ? placeAt(x.cdn, x.code) : null, m = me();
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

  // The share component, with its version: /assets/ is cached for a week, and a page must not get last version's
  // copy (no received() before version 2, a stale cache fixed in 3)
  const SHARE_JS = "/assets/share/share.js?v=9";

  /* ---------- a shared result ---------- */
  // Opening /r/<code> shows that result as the test drew it, and doesn't test until the visitor asks
  async function showShared(S) {
    await popsP;
    SHOWN = { where: S.where };
    R = Object.fromEntries(S.rows.map(x => [x.id, { ms: x.ms, code: x.code, err: x.ms == null ? "fail" : null }]));
    done = total;
    if (S.site) { SITE = S.site; if ($("#siteIn")) $("#siteIn").value = S.site.host; }
    redraw(); fillSite();
    // the 1ms.dog banner for someone else's result, above it, with a button for the visitor's own test
    const { received } = await import(SHARE_JS);
    if (typeof received === "function") BANNER = received({ lang: D.lang, ts: S.ts, at: $(".hero"), test: start });
    $("#prog").classList.add("end"); $("#progTxt").innerHTML = "&nbsp;";
    $("#rerun").disabled = false;
    LAST = { ts: S.ts, shared: S }; $("#shareBtn").disabled = false;
    if (canReport) rpBtn.hidden = false;
  }

  /* ---------- share: the 1ms.dog share dialog (1ms-shell assets/share/, copied verbatim to /assets/share/) ---------- */
  const shareBtn = $("#shareBtn");
  if (shareBtn) shareBtn.onclick = async () => {
    if (!LAST) return;
    const S = LAST.shared || null, m = S ? S.where : U;
    const rows = S ? S.rows : LIST.map(c => R[c.id] ? { id: c.id, code: R[c.id].code, ms: R[c.id].ms } : null).filter(Boolean);
    const site = S ? S.site : SITE ? { cdn: SITE.cdn, code: SITE.code, ms: SITE.ms, host: SITE.host } : null;
    const isp = S ? S.isp : U && U.org || "";
    const where = m && m.cc ? { cc: m.cc, lat: m.lat, lon: m.lon, city: m.city || "" } : null;
    const { share } = await import(SHARE_JS);
    share({
      lang: D.lang, name: t("app_name"), file: "cdn-radar",
      show: ["city", "isp"], never: ["ip"], canShow: !!where,
      link: show => location.origin + D.home + "r/" + encodeShare({ ts: LAST.ts, where: show ? where : null, isp: show ? isp : "", rows, site }),
      home: location.origin + D.home,
      text: () => { const b = rows.filter(x => x.ms != null).sort((a, b) => a.ms - b.ms)[0]; return b ? t("share_text", { cdn: cdnName(b.id), ms: msTxt(b.ms) }) : t("app_name"); },
      height: 370 + 170 + Math.ceil(Math.max(0, rows.length - 3) / 2) * 52 + (site ? 110 : 0),
      draw: (x, kit) => drawCard(x, kit, rows, site),
      foot: show => [t("card_sub"), show && where && [where.city, country(where.cc)].filter(Boolean).join(", "), show && isp].filter(Boolean),
      ts: LAST.ts,
    }).open();
  };

  // The middle of the card: the verdict; the three fastest CDNs large, with the location that answered and the round
  // trip (they must read when the card is shrunk to a chat app's preview); the others under them, fastest first. Never
  // an address, and distances only when the visitor shows their city (they would place it otherwise)
  function drawCard(x, kit, rows, site) {
    const { W, P, F, M, v, clip, fit } = kit;
    const C = { fg: v("fg"), muted: v("muted"), line: v("line"), warn: v("warn"), bad: v("bad"), t1: v("t1") };
    let y = kit.top + 64;
    x.textBaseline = "alphabetic"; x.textAlign = "left";
    const verdict = $("#verdict") ? $("#verdict").textContent : t("app_name");
    x.fillStyle = C.fg; fit(x, verdict, W - 2 * P, 40, 28, 750); x.fillText(clip(x, verdict, W - 2 * P), P, y);
    y += 46;
    x.fillStyle = C.muted; fit(x, SUB, W - 2 * P, 22, 18, 500); x.fillText(clip(x, SUB, W - 2 * P), P, y);
    y += 50;
    const where = r => { const place = r.code ? placeAt(r.id, r.code) : null, c = popCode(r.id, r.code);
      return r.code ? [c, place && place[0]].filter(Boolean).filter((s, j, l) => l.indexOf(s) === j).join(" ") : "—"; };
    const name = r => BY[r.id].short || cdnName(r.id);
    // a location that won't fit even at the smallest size keeps just its code (FRA rather than "FRA Frankf…")
    const place = (r, w, size, min) => { const s = where(r); fit(x, s, w, size, min, 500); return x.measureText(s).width <= w ? s : (popCode(r.id, r.code) || s); };
    const order = [...rows.filter(r => r.ms != null).sort((p, q) => p.ms - q.ms), ...rows.filter(r => r.ms == null)];
    const top = order.slice(0, 3), rest = order.slice(3);
    // the fastest three: a column each, the round trip big
    const tw = (W - 2 * P - 2 * 28) / 3;
    top.forEach((r, i) => {
      const cx = P + i * (tw + 28);
      x.fillStyle = BY[r.id].c; x.beginPath(); x.arc(cx + 9, y + 2, 9, 0, Math.PI * 2); x.fill();
      x.fillStyle = C.fg; fit(x, name(r), tw - 30, 28, 22, 700); x.fillText(clip(x, name(r), tw - 30), cx + 28, y + 12);
      x.fillStyle = C.muted; x.fillText(clip(x, place(r, tw, 24, 18), tw), cx, y + 52);
      x.fillStyle = r.ms == null ? C.bad : C.fg; x.font = `750 52px ${M}`; x.fillText(r.ms == null ? "—" : msTxt(r.ms), cx, y + 118);
    });
    y += 170;
    const colW = (W - 2 * P - 40) / 2;
    rest.forEach((r, i) => {
      const cx = P + (i % 2) * (colW + 40), cy = y + Math.floor(i / 2) * 52;
      x.fillStyle = BY[r.id].c; x.beginPath(); x.arc(cx + 7, cy - 8, 7, 0, Math.PI * 2); x.fill();
      x.fillStyle = C.fg; fit(x, name(r), colW * .4, 23, 18, 650); x.fillText(clip(x, name(r), colW * .4), cx + 24, cy);
      // the location gets what the name and the round trip leave of the column
      const pw = colW - 24 - colW * .42 - 90;
      x.fillStyle = C.muted; x.fillText(clip(x, place(r, pw, 21, 16), pw), cx + 24 + colW * .42, cy);
      x.textAlign = "right"; x.fillStyle = r.ms == null ? C.bad : C.fg; x.font = `650 22px ${M}`;
      x.fillText(r.ms == null ? "—" : msTxt(r.ms), cx + colW, cy); x.textAlign = "left";
    });
    if (site) {
      const sy = y + Math.ceil(rest.length / 2) * 52 + 16;
      x.strokeStyle = C.line; x.lineWidth = 2; x.beginPath(); x.moveTo(P, sy - 34); x.lineTo(W - P, sy - 34); x.stroke();
      x.fillStyle = C.fg; fit(x, site.host, W * .4, 23, 16, 650); x.fillText(clip(x, site.host, W * .4), P, sy);
      x.fillStyle = C.muted; x.font = `500 21px ${F}`;
      x.fillText(clip(x, [site.cdn ? cdnName(site.cdn) : t("s_nocdn"), site.code].filter(Boolean).join(" · "), W * .4), P + W * .42, sy);
      x.textAlign = "right"; x.fillStyle = C.fg; x.font = `650 22px ${M}`; x.fillText(site.ms == null ? "—" : msTxt(site.ms), W - P, sy); x.textAlign = "left";
    }
  }

  /* ---------- reporting a problem (the shell's dialog) ---------- */
  // The dialog asks this page what the visitor saw (window.msReport: 1ms-shell docs/tool-contract.md section 4, and the
  // audit yt1988/1ms-shell#97): the page's own verdict as the line, a share link's readings without the visitor's place
  // (a city, its coordinates and the network are what the share dialog's switches hide by default), and those readings
  // as one-tap answers. src/report.mjs builds it, so the dialog's limits and that privacy scope are testable without a
  // browser. A CDN's page brings the Tokyo job's latest readings and the ISP table's date along, and a site check its
  // result.
  function tokyoReport() {
    if (!TK || !TK.latest || !TK.latest.r) return null;
    const one = f => { const x = TK.latest.r[D.cdn + "/" + f]; return x ? (x[1] == null ? "fail" : (x[0] || "-") + "/" + Math.round(x[1])) : null; };
    const out = { at: new Date(TK.latest.t).toISOString(), v4: one(4), v6: one(6) };
    return out.v4 || out.v6 ? out : null;
  }
  // a stat's label as the page draws it ("Typical latency", "Latency"): built into the HTML, not in window.L1MS
  const statLabel = id => { const b = $("#" + id), st = b && b.closest(".stat"), k = st && st.querySelector(".k"); return k ? k.textContent : ""; };
  window.msReport = () => {
    // nothing to describe before a run, or while one is running
    if (!LAST || RUN) return null;
    const rows = LIST.filter(c => R[c.id]).map(c => {
      const x = rowOf(c.id);
      return { id: c.id, name: cdnName(c.id), code: x.code, ms: x.ms, err: x.err, read: !!BY[c.id].read };
    });
    if (!rows.length) return null;
    const s = summary(LIST.map(c => rowOf(c.id) || { id: c.id, ms: null })), x = D.kind === "home" ? null : rowOf(D.cdn);
    // a CDN's page says where it serves you from, a location page whether it is this one, the home page the verdict
    const vEl = $(D.kind === "pop" ? "#popRes" : "#verdict");
    const head = vEl ? vEl.textContent : "";
    const verdict = D.kind === "home" ? s.key
      : D.kind === "pop" ? (x.ms == null ? "pr_fail" : x.code === D.pop.code ? "pr_same" : "pr_other")
      : (x.ms == null ? "pv_fail" : x.code ? "pv_pop" : BY[D.cdn].read ? "pv_nopop" : "pv_timed");
    return reportOf({
      at: LAST.ts, lang: D.lang, kind: D.kind, cdn: D.cdn, pop: D.pop ? D.pop.code : null, shared: !!SHOWN,
      context: D.kind === "pop" ? cdnName(D.cdn) + " " + D.pop.code : "", head, sub: D.kind === "home" ? SUB : "",
      med: s.med, medLabel: D.kind === "home" ? statLabel("stMed") : statLabel("stMs"), verdict, far: s.farIds,
      counts: { tested: LIST.length, answered: rows.filter(r => r.ms != null).length, located: s.located, near: s.near, far: s.far },
      rows,
      site: SITE && SITE.host ? { host: SITE.host, name: SITE.cdn ? cdnName(SITE.cdn) : "", cdn: SITE.cdn, code: SITE.code, ms: SITE.ms } : null,
      tokyo: D.kind === "cdn" ? tokyoReport() : null,
      ecs: D.kind === "cdn" && EC && EC.t ? { at: new Date(EC.t).toISOString() } : null,
      list: { up: POPU, file: D.files.pops },
      t, msTxt,
    });
  };
  // beside the results: the shell's dialog, started with "the result looks wrong:", which makes it ask which part and
  // offer the picks. Only when the shell is there to open it (on 1ms.dog; a fork serving the page itself has none), and
  // once there is a result.
  const rpBtn = $("#rpBtn"), canReport = !!rpBtn && typeof window.msOpenReport === "function";

  if ($("#rerun")) $("#rerun").onclick = start;
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  geoP.then(fillYou);
  if (SHARED && D.kind !== "pop") showShared(SHARED);
  else {
    // ?site=: a link someone sent to test this site from here
    const q = new URLSearchParams(location.search).get("site"), h = q && hostOf(q);
    if (h && siteForm) { $("#siteIn").value = h; popsP.then(() => checkSite(h)); }
    start();
  }
})();
