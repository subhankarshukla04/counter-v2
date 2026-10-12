// Usage: node outreach/make_links.mjs  -> writes outreach/links.csv
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://counter-cafe.vercel.app/";
const NEAR_START = 4; // same as index.html
const here = new URL(".", import.meta.url);
const shops = JSON.parse(readFileSync(new URL("../site_data.json", here), "utf8")).shop_items;

// same as index.html: flat-earth distance, stable sort, shops without coordinates last
function distKm(a, b) {
  const x = (b[1] - a[1]) * Math.cos((a[0] + b[0]) * Math.PI / 360), y = b[0] - a[0];
  return Math.hypot(x, y) * 111.2;
}
const farFrom = (s, o) => s.lat == null || s.lng == null || o.lat == null || o.lng == null
  ? Infinity : distKm([s.lat, s.lng], [o.lat, o.lng]);
const nearestFirst = (s, list) => list.map(o => ({ o, far: farFrom(s, o) })).sort((a, b) => a.far - b.far).map(x => x.o);

const csv = v => /[",\n]/.test(v = String(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
const rows = shops.map(s => {
  const rivals = nearestFirst(s, shops.filter(o => o.shop_id !== s.shop_id)).slice(0, NEAR_START);
  const q = `shop=${encodeURIComponent(s.shop_id)}&rivals=${rivals.map(r => encodeURIComponent(r.shop_id)).join(",")}&src=owner`;
  return [s.shop_name, s.district, s.address, s.items.length, `${BASE}?${q}`, rivals.map(r => r.shop_name).join("; ")];
}).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

const head = ["shop_name", "district", "address", "items_priced", "link", "competitors"];
writeFileSync(new URL("links.csv", here), [head, ...rows].map(r => r.map(csv).join(",")).join("\n") + "\n");
console.log(rows.length + " rows");
