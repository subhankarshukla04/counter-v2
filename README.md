# Counter

The app cafe owners use: pick your shop and your competitors, then see your prices against theirs, what they launched, what they are offering, and ideas for your own offers.

Live at https://counter-cafe.vercel.app. Built by Arshin Sikka (history from `arshinsikka/weekly-bake`, folder `counter/`), now run from this repo.

## Where AI is used

Only one place: reading a menu from a **photo or a scanned PDF** (`api/read-menu.js`, through OpenRouter).

Everything else runs without AI:

- **A PDF menu with text** is read in the browser with pdf.js. It's exact and free. The AI is asked only if fewer than 5 priced items are found.
- **The same files uploaded twice** are not read twice: the last 5 reads are kept in the browser.
- **Ideas for your shop** come from rules on the owner's menu, the usual prices near them and the offers near them (`makeIdeas` in `index.html`).

## Setup

1. Put the OpenRouter key in `.env` as `OPENROUTER_API_KEY=...`. The file is never committed or uploaded.
2. Copy it to Vercel with `vercel env add OPENROUTER_API_KEY production`, then deploy with `vercel deploy --prod`.
3. On openrouter.ai, set a credit limit on the key. The app has no access code, so the limit is what caps spending.
