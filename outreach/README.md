# Owner outreach links

`links.csv` has one row per café: its name, district, address, how many items we price, a personal link that opens Counter on THEIR prices against their 4 nearest cafés, and those cafés' names.
Regenerate after `site_data.json` changes: `node outreach/make_links.mjs` (no dependencies).
This folder is not deployed (`.vercelignore` is an allowlist).

DM template:
> Hi, I'm a student at NUS building Counter, a free project that compares café prices around Singapore. I put together how {shop_name}'s prices look next to the cafés nearest you: {link}. No sign-up, and I'd love to hear if anything looks off.
