// data/ecs-nets.json: one /24 for each big consumer ISP, which server/ecs.mjs puts in its DNS queries as the client
// subnet (ECS) to see where a DNS-steered CDN sends that ISP's users. Picked from what the ISP's AS announces (RIPEstat):
// the largest IPv4 prefix, and the /24 in its middle (a block's first addresses are often its own infrastructure).
// Run by hand when the list changes: npm run ecs-nets
import { writeFile } from "node:fs/promises";

// [ASN, country, name ({ en, "zh-CN", "zh-TW" } when the ISP has a name in Chinese)]
const ISPS = [
  [4134, "CN", { en: "China Telecom", "zh-CN": "中国电信", "zh-TW": "中國電信" }],
  [4837, "CN", { en: "China Unicom", "zh-CN": "中国联通", "zh-TW": "中國聯通" }],
  [9808, "CN", { en: "China Mobile", "zh-CN": "中国移动", "zh-TW": "中國移動" }],
  [4538, "CN", { en: "CERNET", "zh-CN": "中国教育网", "zh-TW": "中國教育網" }],
  [4760, "HK", { en: "HKT", "zh-CN": "香港电讯", "zh-TW": "香港電訊" }],
  [9269, "HK", { en: "HKBN", "zh-CN": "香港宽频", "zh-TW": "香港寬頻" }],
  [3462, "TW", { en: "Chunghwa Telecom (HiNet)", "zh-CN": "中华电信 (HiNet)", "zh-TW": "中華電信 (HiNet)" }],
  [4713, "JP", { en: "NTT OCN" }],
  [2516, "JP", { en: "KDDI" }],
  [17676, "JP", { en: "SoftBank" }],
  [4766, "KR", { en: "KT" }],
  [9318, "KR", { en: "SK Broadband" }],
  [3786, "KR", { en: "LG U+" }],
  [3758, "SG", { en: "Singtel" }],
  [4788, "MY", { en: "TM" }],
  [7713, "ID", { en: "Telkom Indonesia" }],
  [7470, "TH", { en: "True" }],
  [7552, "VN", { en: "Viettel" }],
  [9498, "IN", { en: "Airtel" }],
  [55836, "IN", { en: "Jio" }],
  [1221, "AU", { en: "Telstra" }],
  [7922, "US", { en: "Comcast" }],
  [7018, "US", { en: "AT&T" }],
  [701, "US", { en: "Verizon" }],
  [3320, "DE", { en: "Deutsche Telekom" }],
  [3215, "FR", { en: "Orange" }],
  [2856, "GB", { en: "BT" }],
  [12389, "RU", { en: "Rostelecom" }],
  [28573, "BR", { en: "Claro" }],
];

const ip2n = ip => ip.split(".").reduce((a, b) => a * 256 + +b, 0);
const n2ip = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join(".");
const out = [];
for (const [asn, cc, name] of ISPS) {
  const j = await (await fetch(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`)).json();
  const v4 = j.data.prefixes.map(p => p.prefix).filter(p => !p.includes(":")).map(p => p.split("/")).sort((a, b) => a[1] - b[1]);
  if (!v4.length) { console.log("no prefixes", asn); continue; }
  const [base, bits] = v4[0], size = 2 ** (32 - bits);
  const net = n2ip(ip2n(base) + Math.floor(size / 2 / 256) * 256) + "/24";
  out.push({ asn, cc, name, net });
  console.log(asn, cc, name.en, v4[0].join("/"), "→", net);
}
await writeFile(new URL("../data/ecs-nets.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
