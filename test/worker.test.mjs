// The Worker's answers that don't need Cloudflare's runtime: links it has no page for are 404s, never a redirect home
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env = { ASSETS: { fetch: () => { throw new Error("a link that can't be read shouldn't fetch the page"); } } };
const get = (path, method = "GET") => worker.fetch(new Request("https://cdn.1ms.dog" + path, { method }), env);

test("a shared link whose code can't be read is a 404, in every language and under a CDN's page", async () => {
  for (const p of ["/r/zz", "/zh-cn/r/zz", "/ja/r/2~abc~-~-~x~-", "/r/1~abc~-~-", "/xx/r/1~abc~-~-~x~-", "/alibaba/r/zz", "/zh-cn/cloudflare/r/zz"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get("location"), null, p);
  }
  const h = await get("/r/zz", "HEAD");
  assert.equal(h.status, 404);
  assert.equal(await h.text(), "");
});
