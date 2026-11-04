// CDN Radar page. Every CDN's row is in the HTML from the start; the CDNs are timed at once (src/probe.mjs) and fill
// their rows as they answer: which location answered, how far it is from the visitor, and the round trip next to the
// fastest one the distance allows. The map and the verdict follow. A location page (/<cdn>/<code>/) tests its one CDN.
// Strings: window.L1MS.
import { CDNS, BY, HOSTS, nameOf, placeOf, popMaps, SITE_HEADERS, SITE_TIMING, PARSE, cdnOfName, isCloudflareIP } from "./cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, FAST, isFar, encode as encodeShare, decode as decodeShare, sharePath, hostOf } from "./lib.mjs";
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
  // Taiwan is "中国台湾 / Taiwan, China" (1ms-shell docs/tool-contract.md §5); every other region by its system name
  const TW = { "zh-CN": "中国台湾", "zh-TW": "中國台灣", en: "Taiwan, China", ja: "中国台湾", ko: "중국 대만", es: "Taiwán, China", fr: "Taïwan, Chine", de: "Taiwan, China", pt: "Taiwan, China", ru: "Тайвань, Китай" };
  const country = cc => { if (cc === "TW") return TW[D.lang]; try { return regionNames ? regionNames.of(cc) : cc; } catch (e) { return cc; } };
  const cdnName = id => BY[id] ? nameOf(BY[id], D.lang) : id;
  // a location for people: "HKG · Hong Kong, 香港" → code and where; Akamai names cities, not codes
  const popCode = (id, code) => id === "akamai" || id === "cdn77" ? "" : code;
  const placeTxt = p => p ? (p[0] && p[1] ? `${p[0]}, ${country(p[1])}` : p[0] || country(p[1])) : "";

  /* ---------- data: the locations of the CDNs that publish them, where codes are, and where the visitor is ---------- */
  const DATA = { pops: null };
  const getJ = (u, opt) => fetch(u, opt).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const popsP = getJ("/assets/" + D.files.pops).then(j => { DATA.pops = popMaps(j); }).catch(() => { DATA.pops = {}; });
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
    getJ("/places?q=" + encodeURIComponent(ks.join(","))).then(j => { for (const k of ks) PLACES[k] = j[k] || null; redraw(); fillSite(); })
      .catch(() => { for (const k of ks) PLACES[k] = null; });
  }
  // where the visitor is: this site's Worker reads Cloudflare's guess from the request (/geo); null when self-hosted
  // as plain files. A precise location, when the visitor asks for one, replaces the coordinates.
  let U = null;
  const geoP = getJ("/geo", { cache: "no-store" }).then(j => { if (j && j.lat != null) U = j; }).catch(() => {});

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
  let SUB = "";          // the verdict's second line, for the share card (the page shows it in the numbers)
  const me = () => SHOWN ? SHOWN.where : U;
  const listFmt = (() => { try { return new Intl.ListFormat(D.lang, { type: "conjunction" }); } catch (e) { return { format: a => a.join(", ") }; } })();
  const names = ids => listFmt.format(ids.map(cdnName));

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
  const ICON = { ok: '<path d="M3.5 8.5l3 3 6-7"/>', warn: '<path d="M8 3.5v5.5M8 12v.5"/>', bad: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>' };
  function finding(f) {
    const r = f.row;
    if (f.key === "f_fail") return t("f_fail", { list: names(f.ids) });
    if (f.key === "f_fast") return t("f_fast", { list: names(f.ids), ms: msTxt(FAST) });
    if (f.key === "f_more") return t("f_more", { n: f.n });
    if (f.key === "f_slowpath") return t("f_slowpath", { cdn: cdnName(r.id), place: placeTxt(r.place), km: kmTxt(r.d), ms: msTxt(r.ms), floor: msTxt(floorMs(r.d)) });
    const head = t("f_far", { cdn: cdnName(r.id), place: placeTxt(r.place), km: kmTxt(r.d), ms: msTxt(r.ms) });
    // sentences in Chinese and Japanese follow each other without a space
    return head + (missedNearest(r.d, r.near) ? (/[。！？]$/.test(head) ? "" : " ") + t("f_far_near", { near: [popCode(r.id, r.near[0]), placeTxt(r.near[1])].filter(Boolean).join(" · "), km: kmTxt(r.near[2]) }) : "");
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
    // "nothing stands out" only once everything is in
    if (!final && !s.findings.length) { $("#finds").innerHTML = FINDS0; return; }
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
      if (x.d != null && missedNearest(x.d, x.near)) out.push(["warn", t("f_notnearest_tip", { cdn, code: popCode(id, x.near[0]), place: placeTxt(x.near[1]), km: kmTxt(x.near[2]) })]);
      if (x.d != null && detoured(x.ms, x.d)) out.push(["warn", t("f_slow_tip", { floor: msTxt(floorMs(x.d)), km: kmTxt(x.d) })]);
    } else {
      // timed only (or it didn't say): the round trip, and how far the edge can be at most
      v.textContent = t(BY[id].read ? "pv_nopop" : "pv_timed", { cdn, ms: msTxt(x.ms) }); v.className = "verdict " + (x.ms < FAST ? "t1" : x.ms < 80 ? "" : "warn");
      SUB = t("pv_bound", { km: kmTxt(x.ms * 100) }); out.push(["ok", SUB]);
      set("stPop", t("r_hidden")); set("stDist", "≤ " + kmTxt(x.ms * 100)); set("stMs", msTxt(x.ms), "", msTier(x.ms));
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
    await popsP;
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
  const SHARE_JS = "/assets/share/share.js?v=8";

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
