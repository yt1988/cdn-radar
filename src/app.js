// CDN Radar page. Every CDN's row is in the HTML from the start; the CDNs are timed at once (src/probe.mjs) and fill
// their rows as they answer: which location answered, how far it is from the visitor, and the round trip next to the
// fastest one the distance allows. The map and the verdict follow. A location page (/<cdn>/<code>/) tests its one CDN.
// Strings: window.L1MS.
import { CDNS, BY, nameOf, placeOf, popMaps, SITE_HEADERS, SITE_TIMING, PARSE, cdnOfName, isCloudflareIP } from "./cdns.mjs";
import { km, floorMs, tierOf, detoured, nearest, missedNearest, summary, encode as encodeShare, decode as decodeShare, sharePath, hostOf } from "./lib.mjs";
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
  const ROW = Object.fromEntries($$(".cr[data-c]").map(r => [r.dataset.c, r]));
  const LIST = D.kind === "pop" ? [BY[D.cdn]] : CDNS;
  let R = {};            // results so far, by CDN id: { ms, code, err, loc? }
  let SHOWN = null;      // a shared result being shown: its visitor location (or null)
  let SITE = null;       // the site check's result
  const me = () => SHOWN ? SHOWN.where : U;

  // a row's result with its place, distance and flags
  function rowOf(id) {
    const x = R[id];
    if (!x) return null;
    const place = x.code && DATA.pops ? placeOf(id, x.code, DATA.pops, DATA.places) : null, m = me();
    const d = place && m && m.lat != null ? km(m.lat, m.lon, place[2], place[3]) : null;
    const list = BY[id] && BY[id].list && DATA.pops && DATA.pops[BY[id].list];
    const near = d != null && list && m ? nearest(id === "cfchina" ? Object.fromEntries(Object.entries(list).filter(([, p]) => p[1] === "CN")) : list, m.lat, m.lon) : null;
    return { id, code: x.code, ms: x.ms, err: x.err, place, d, near, loc: x.loc };
  }

  function fillRow(id) {
    const row = ROW[id];
    if (!row) return;
    const x = rowOf(id), cdn = BY[id];
    const [pb, ps] = row.querySelectorAll(".cp b, .cp span"), [db, ds] = row.querySelectorAll(".cd b, .cd span"), [mb, ms] = row.querySelectorAll(".cm b, .cm span");
    const sub = row.querySelector(".cn > span");
    row.classList.toggle("wait", !x);
    row.classList.toggle("bad", !!x && x.ms == null);
    ds.className = ""; ms.className = ""; ds.removeAttribute("data-why"); ms.removeAttribute("data-why"); ds.tabIndex = -1; ms.tabIndex = -1;
    if (!x) { pb.textContent = "…"; ps.innerHTML = "&nbsp;"; db.textContent = "…"; ds.innerHTML = "&nbsp;"; mb.textContent = "…"; ms.innerHTML = "&nbsp;"; return; }
    // where it answered from
    if (x.code) {
      const c = popCode(id, x.code), href = cdn.list && D.popHref ? D.popHref[id === "cfchina" ? "cloudflare" : cdn.list] : null;
      pb.innerHTML = c ? (href && x.place ? `<a href="${esc(href + x.code.toLowerCase() + "/")}">${esc(c)}</a>` : esc(c)) : esc(x.place ? x.place[0] : x.code);
      ps.textContent = x.place ? (c ? placeTxt(x.place) : country(x.place[1])) : t("r_unknown");
    } else {
      pb.textContent = "—";
      ps.textContent = x.ms == null ? t(x.err === "timeout" ? "r_timeout" : "r_fail") : cdn.read ? t("r_nopop") : t("r_hidden");
    }
    // how far
    if (x.d != null) {
      const tier = tierOf(x.d);
      db.textContent = kmTxt(x.d); db.className = tier[1];
      if (missedNearest(x.d, x.near)) {
        ds.textContent = t("f_notnearest"); ds.className = "warn";
        ds.dataset.why = t("f_notnearest_tip", { cdn: cdnName(id), code: popCode(id, x.near[0]), place: placeTxt(x.near[1]), km: kmTxt(x.near[2]) }); ds.tabIndex = 0;
      } else ds.textContent = t("d_" + tier[2]);
    } else { db.textContent = "—"; db.className = ""; ds.textContent = x.code && !me() && !SHOWN ? t("r_noloc") : " "; }
    // how long, and the least the distance allows
    if (x.ms != null) {
      mb.textContent = msTxt(x.ms);
      if (x.d != null && detoured(x.ms, x.d)) {
        ms.textContent = t("f_slow"); ms.className = "warn";
        ms.dataset.why = t("f_slow_tip", { floor: msTxt(floorMs(x.d)), km: kmTxt(x.d) }); ms.tabIndex = 0;
      } else ms.textContent = x.d != null ? t("r_floor", { ms: fmtMs(floorMs(x.d)) }) : " ";
    } else { mb.textContent = "—"; ms.innerHTML = "&nbsp;"; }
    // through another exit than the page's (a proxy that carries this CDN): Cloudflare's trace says from where
    if (sub && x.loc && me() && me().cc && x.loc !== me().cc && !SHOWN) {
      sub.textContent = t("r_via", { where: country(x.loc) }); sub.className = "via";
      sub.dataset.why = t("r_via_tip", { where: country(x.loc) }); sub.tabIndex = 0;
    }
  }

  // the hero: the verdict, the fastest and the farthest, the map
  function hero(final) {
    const rows = LIST.map(c => rowOf(c.id)).filter(Boolean);
    drawMap(rows, me());
    if (!final || D.kind === "pop") return;
    const s = summary(rows), v = $("#verdict");
    // a shared result without its place: no distances, by the sharer's choice
    if (SHOWN && !me() && s.key === "v_noloc") s.key = "v_hidden";
    v.textContent = t(s.key, { n: s.far.length });
    v.className = "verdict " + (s.key === "v_allnear" ? "t1" : s.key === "v_none" ? "bad" : s.key === "v_noloc" || s.key === "v_hidden" ? "" : "warn");
    const bits = [];
    if (s.best) bits.push(t("p_best", { cdn: cdnName(s.best.id), pop: s.best.place ? placeTxt(s.best.place) : popCode(s.best.id, s.best.code) || "—", ms: msTxt(s.best.ms) }));
    const far = [...s.far].sort((a, b) => b.d - a.d)[0];
    if (far) bits.push(t("p_far", { cdn: cdnName(far.id), pop: placeTxt(far.place), km: kmTxt(far.d) }));
    $("#probs").textContent = bits.join(" ") || " ";
  }

  // the visitor's line: city, country, network
  function fillYou() {
    const el = $("#you");
    if (!el) return;
    const m = me();
    if (SHOWN) { el.textContent = m ? [m.city, country(m.cc)].filter(Boolean).join(", ") : t("you_hidden"); return; }
    if (!m) { el.textContent = t("you_unknown"); return; }
    const where = [m.city, country(m.cc)].filter(Boolean).join(", ");
    // its network on ASN Lookup: a value made into a link, so a dotted underline and a title, not the external-link mark
    const net = m.asn ? (ASN ? `<a class="q0" href="${esc(ASN + "AS" + m.asn)}" title="${esc(t("asn_t"))}" target="_blank" rel="noopener">AS${m.asn}</a>` : "AS" + m.asn) : "";
    el.innerHTML = esc(where) + (m.org || net ? ` <span class="m">· ${esc(m.org || "")}${m.org && net ? " " : ""}${net}</span>` : "") + (m.precise ? ` <span class="tag">${esc(t("precise_on"))}</span>` : "");
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
  let RUN = null, LAST = null;
  async function start() {
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang] === D.home ? location.pathname.replace(/\/r\/.*$/, "/") : location.pathname); }
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    R = {}; SHOWN = null; LAST = null; done = 0; t0 = performance.now();
    if ($("#shareBtn")) $("#shareBtn").disabled = true;
    if ($("#rerun")) $("#rerun").disabled = true;
    $("#prog") && $("#prog").classList.remove("end");
    if ($("#verdict")) { $("#verdict").textContent = t("v_wait"); $("#verdict").className = "verdict"; $("#probs").innerHTML = "&nbsp;"; }
    redraw(); progress();
    await Promise.all([popsP, placesP]);
    geoP.then(() => { if (!ctl.signal.aborted) redraw(); });
    // a few at a time: twenty connections at once would queue behind each other on a slow link
    const queue = [...LIST];
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
    res.className = "site-res wait";
    res.innerHTML = `<b>${esc(host)}</b><span>${esc(t("s_wait"))}</span>`;
    $("#askBtn").disabled = false;
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
    const bits = [
      cdn ? t("s_cdn", { cdn }) : t("s_nocdn"),
      x.code ? t("s_pop", { pop: [popCode(x.cdn, x.code), placeTxt(place)].filter(Boolean).join(" · ") || x.code }) : cdn ? t("s_nopop") : "",
      d != null ? kmTxt(d) : "", x.ms != null ? msTxt(x.ms) : t("r_fail"),
    ].filter(Boolean);
    res.className = "site-res" + (x.ms == null ? " bad" : "");
    res.innerHTML = `<b>${esc(x.host)}</b><span>${esc(bits.join(" · "))}</span>`;
    res.title = x.cname ? "CNAME " + x.cname : "";
  }
  if (siteForm) {
    siteForm.onsubmit = e => {
      e.preventDefault();
      const h = hostOf($("#siteIn").value);
      if (!h) { $("#siteRes").className = "site-res bad"; $("#siteRes").innerHTML = `<b>&nbsp;</b><span>${esc(t("s_bad"))}</span>`; return; }
      $("#siteIn").value = h;
      checkSite(h);
    };
    // a link for someone else to open: it tests their network against this site, and they send back the result
    $("#askBtn").onclick = () => {
      const h = hostOf($("#siteIn").value);
      if (!h) { $("#siteIn").focus(); return; }
      const url = location.origin + D.home + "?site=" + encodeURIComponent(h);
      const b = $("#askBtn"), old = b.querySelector("span").textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => { b.querySelector("span").textContent = t("copied"); }, () => { prompt(t("ask_copy"), url); })
        .finally(() => setTimeout(() => { b.querySelector("span").textContent = old; }, 1600));
    };
  }

  /* ---------- a shared result ---------- */
  // Opening /r/<code> shows that result as the test drew it, and doesn't test until the visitor asks
  async function showShared(S) {
    await Promise.all([popsP, placesP]);
    SHOWN = { where: S.where };
    R = Object.fromEntries(S.rows.map(x => [x.id, { ms: x.ms, code: x.code, err: x.ms == null ? "fail" : null }]));
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
    const S = LAST.shared || null, m = S ? S.where : U;
    const rows = S ? S.rows : LIST.map(c => R[c.id] ? { id: c.id, code: R[c.id].code, ms: R[c.id].ms } : null).filter(Boolean);
    const site = S ? S.site : SITE ? { cdn: SITE.cdn, code: SITE.code, ms: SITE.ms, host: SITE.host } : null;
    const isp = S ? S.isp : U && U.org || "";
    const where = m && m.cc ? { cc: m.cc, lat: m.lat, lon: m.lon, city: m.city || "" } : null;
    const { share } = await import("/assets/share/share.js");
    share({
      lang: D.lang, name: t("app_name"), file: "cdn-radar",
      show: ["city", "isp"], never: ["ip"], canShow: !!where,
      link: show => location.origin + D.home + "r/" + encodeShare({ ts: LAST.ts, where: show ? where : null, isp: show ? isp : "", rows, site }),
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
    x.fillStyle = C.muted; x.font = `500 22px ${F}`; x.fillText(clip(x, $("#probs") ? $("#probs").textContent : "", W - 2 * P), P, y);
    y += 50;
    const colW = (W - 2 * P - 40) / 2;
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
      x.fillText(r.ms == null ? "—" : msTxt(r.ms), cx + colW, cy); x.textAlign = "left";
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
