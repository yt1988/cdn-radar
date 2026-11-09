// What the 1ms.dog "Report a problem" dialog asks the page for (1ms-shell docs/tool-contract.md, section 4; the audit
// yt1988/1ms-shell#97): the line saying what was tested and what it said, the readings behind it as JSON, and a few of
// those readings as one-tap answers for a visitor who only sends the button's starting words.
//
// Same privacy as a share link without its place (src/lib.mjs, format 1): the data centers and the round trips, no
// address (this page never has one), no city, coordinates, distance or network name — those are what the share
// dialog's switches hide by default. The date the location lists were made goes with the readings, so the same names
// can be read back from the repository.
//
// The limits are the dialog's (1ms-shell src/report.js): 300 characters for the line, 6 KB for the JSON as the dialog
// prints it (over it only the line is sent), 8 readings of 60 characters each.

export const MAX_SUMMARY = 300, MAX_DATA = 6000, MAX_PICKS = 8, MAX_PICK = 60;

const round1 = v => Math.round(v * 10) / 10;
// bytes, as the dialog counts them (a Blob of the pretty-printed JSON)
const size = o => new TextEncoder().encode(JSON.stringify(o, null, 1)).length;

// input: { at, lang, kind: "home" | "cdn" | "pop", cdn, pop, shared, context, head, sub, med, verdict, far,
//          counts: { tested, answered, located, near, far },
//          rows: [{ id, name, code, ms, err, read }], site: { host, name, cdn, code, ms } | null,
//          tokyo, ecs, list: { up, file }, t (the page's translator), msTxt (a round trip in the visitor's words) }
export function reportOf(o) {
  if (!o || !Array.isArray(o.rows) || !o.rows.length) return null;
  const t = o.t, msTxt = o.msTxt, sep = /^(zh|ja)/.test(o.lang || "") ? "：" : ": ";
  // the line: the page's verdict as the visitor sees it, then the typical round trip (the pop page's own line already
  // carries its latency). The label comes from the page: its stats' labels are build-time strings, not in the browser's
  // window.L1MS.
  const med = o.kind !== "pop" && o.med != null && o.medLabel ? `${o.medLabel} ${msTxt(o.med)}` : "";
  const summary = [o.context, o.head, o.sub, med].filter(Boolean).join(" · ").slice(0, MAX_SUMMARY);

  // the readings, one line per CDN: "id.code.ms", "-" where the CDN gave no location or no answer; the ones that
  // failed go in their own field with the reason. One string rather than a list of objects: the dialog pretty-prints
  // the JSON, and an object per row costs a line per field.
  const failed = o.rows.filter(r => r.ms == null);
  const data = {
    v: 1,
    at: new Date(o.at || Date.now()).toISOString(),
    lang: o.lang || "",
    page: o.kind,
    cdn: o.cdn || null,
    pop: o.pop || null,
    shared: o.shared ? 1 : 0,
    verdict: o.verdict || null,
    n: {
      tested: o.counts.tested, answered: o.counts.answered,
      located: o.counts.located, near: o.counts.near, far: o.counts.far,
    },
    far: (o.far || []).join(",") || null,
    list: { up: (o.list && o.list.up) || "", file: (o.list && o.list.file) || "" },
    fmt: "rows: id.code.ms, ; between; - for no location or no answer; ms to 0.1. fail: id:timeout|fail",
    rows: o.rows.map(r => [r.id, r.code || "-", r.ms == null ? "-" : round1(r.ms)].join(".")).join(";"),
  };
  if (failed.length) data.fail = failed.map(r => `${r.id}:${r.err || "fail"}`).join(",");
  if (o.site && o.site.host) data.site = { host: o.site.host, cdn: o.site.cdn || null, code: o.site.code || null, ms: o.site.ms == null ? null : round1(o.site.ms) };
  if (o.tokyo) data.tokyo = o.tokyo;
  if (o.ecs) data.ecs = o.ecs;
  // the line and the rows always fit; the two side sections are what would go first
  if (size(data) > MAX_DATA) { delete data.tokyo; delete data.ecs; }

  // one tap each: the verdict, a site check's result, then what each CDN's row said (its location and round trip)
  const line = r => r.ms == null
    ? `${r.name}${sep}${t(r.err === "timeout" ? "r_timeout" : "r_fail")}`
    : `${r.name}${sep}${[r.code || (r.read ? t("r_nopop") : ""), msTxt(r.ms)].filter(Boolean).join(" · ")}`;
  const siteLine = o.site && o.site.host
    ? `${o.site.host}${sep}${[o.site.name, o.site.code].filter(Boolean).join(" ") || (o.site.ms == null ? t("r_fail") : t("s_nocdn"))}` : "";
  const picks = [o.head, siteLine, ...o.rows.map(line)].filter(Boolean).slice(0, MAX_PICKS).map(s => String(s).slice(0, MAX_PICK));

  return { summary, data, picks };
}
