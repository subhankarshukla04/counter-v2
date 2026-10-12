# What changed in Counter v2

Compared with Arshin's version (`weekly-bake/counter`, live at counter-psi-khaki.vercel.app).
v2 is live at https://counter-cafe-v2.vercel.app. The layout and features of every page after set-up are his. These are the changes.

## Open to everyone
- **No access code.** Anyone can use every part of Counter.
- **AI only where it's needed, on our OpenRouter key.** Spending is capped on the key itself.
  - AI reads a menu only from a **photo or a scanned PDF**.
  - A PDF with real text is read in the browser for free. The AI is used only when that read isn't reliable.
  - Uploading the same menu again doesn't call the AI again: the last 5 reads are remembered in the browser.
- **Offer ideas run on rules, not AI.** They're built from the shop's menu, the usual prices and the offers running nearby. They're instant, free and unlimited.

## First screen
- **Opening line:** "Never guess a price again.", to match the landing page.
- **Search by café name** with a "Look up" button. Before, the only way in was area tiles.
- **Three small steps** show what happens next: find your café, pick who you compete with, see your prices next to theirs.
- **Lighter area tiles**, plus a "See a sample café" link for people who are just looking.
- **No charts on this screen.** The data starts after set-up.

## New for owners
- **What a price is worth.** In "Try a different price", owners enter how many they sell a day and see the result in money, e.g. "About $1,200 more a month than your real price, if you still sell 80 a day."
- **One-line summary** at the top of My prices, e.g. "Of your 9 items, 2 cost more than most cafés…"
- **The Weekly Bake signup in the product:**
  - On the Alerts page, plus one dismissible line on My prices.
  - Each signup records the shop and its chosen competitors, so the Monday email can be made for that shop.
- **Phone layout.** Tables become cards on phones, so nothing is cut off.

## Fixes
Each of these came from a test against the 15 real café PDF menus:
- prices written as `S$`, `SGD`, `++` or with a comma decimal now read correctly;
- big PDFs are no longer refused;
- broken file data is never sent to the AI;
- an idea with no real saving is never shown;
- long titles are no longer cut mid-word.

## For the team
- **Usage analytics** go to the same Supabase tables as the landing page. They cover opened, shop picked, competitors done, pages viewed, prices tried, menu reads, ideas shown and signups. No emails or menu contents are logged.
- **`outreach/links.csv`:** 82 personal links, one per café, each opening on that café's own prices against its 4 nearest competitors. A DM template is in `outreach/README.md`.

## Tested
- Every café and every page on desktop and phone: 587 visits each, no errors.
- The real-PDF tests above.
- A security review.
