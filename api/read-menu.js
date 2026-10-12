/* Counter: read a menu. One POST with photos or one PDF; the model lists
   the priced items; the rows go back to the browser. Nothing is stored. One
   line is logged for each read, and it never holds the key,
   a header, the files or anything of the menu: see logLine(). */
import { askChain, askModel, isBusy, isLimit } from "./_models.js";

const MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const PDF = "application/pdf";
const MAX_FILES = 6;
const MAX_BASE64 = 4000000;   // characters, all files together
const MAX_ROWS = 400;
const MAX_NAME = 200;
const PRICE_MIN = 0.1, PRICE_MAX = 999;
// The platform stops this function at 180 seconds (vercel.json). All the tries
// together are given a little less, so the reply below is sent before that.
// One try is stopped at 90 seconds. A busy or slow model is asked again after
// 5 seconds, and a new try starts only with a minute or more left. Which model
// is asked next is in _models.js.
const TIME = {overallMs: 170000, tryMs: 90000, waitMs: 5000, needsMs: 60000};

// The kinds of item, the same keys Counter's New items tabs use. The first four
// are sorted the way our own data sorts them (classify_format in wave3_lib.py).
const KINDS = ["drink", "pastry", "cake", "savoury", "other"];
const OTHER_KIND = "other";

const INSTRUCTION = [
  "These files are a cafe or bakery menu from Singapore.",
  "List every item that has a price, exactly as printed. Do not translate, correct or tidy names.",
  "Give one row for each price. If an item has several sizes or versions, each with its own price, give one row for each.",
  "For each row:",
  "name: the item name as printed.",
  "section: the printed heading it sits under, or an empty string.",
  "variant: the size, hot or iced, milk or other note printed for that price, or an empty string.",
  "price: the number in Singapore dollars, or null.",
  "unsure: true when the name or the price is not clearly readable.",
  "kind: one of drink, pastry, cake, savoury, other. Choose the one that fits best; when unsure use other.",
  "drink: coffee, tea, juice, smoothies, sodas, milkshakes, beer, wine and anything else served to drink.",
  "savoury: sandwiches, burgers, pizza, pasta, salads, eggs, toast, rice and noodle dishes, soups and other savoury food.",
  "cake: cakes, brownies, tiramisu, mousse, puddings, swiss rolls, banana bread, cupcakes and loaf slices.",
  "pastry: croissants, danishes, buns, tarts, cookies, scones, bread and other bakes that are not a cake and not savoury.",
  "other: anything that is none of these.",
  "If a price cannot be read with confidence, set price to null and unsure to true. Never guess a price.",
  "If the files are not a menu, return no rows and set not_a_menu to true."
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    not_a_menu: {type: "boolean"},
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {type: "string"},
          section: {type: "string"},
          variant: {type: "string"},
          price: {type: ["number", "null"]},
          unsure: {type: "boolean"},
          kind: {type: "string", enum: KINDS}
        },
        required: ["name", "section", "variant", "price", "unsure", "kind"]
      }
    }
  },
  required: ["not_a_menu", "items"]
};

const MESSAGES = {
  method: "Send a POST request.",
  not_set_up: "Menu reading is not switched on yet.",
  bad_files: "We could not use these files. Use up to 6 photos, or one PDF.",
  too_large: "These files are too large together. Use fewer photos.",
  limit: "Too many menus are being read right now. Try again in a minute.",
  read_failed: "Something went wrong while reading. Nothing was saved. Try again.",
  busy: "The AI is busy right now. Wait a minute and try again."
};

function reply(status, body){
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
  });
}
const fail = (status, error) => reply(status, {error: error, message: MESSAGES[error]});

function filesOk(files){
  if(!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return false;
  for(const f of files){
    if(!f || typeof f !== "object" || MIMES.indexOf(f.mime) === -1) return false;
    if(typeof f.data !== "string" || f.data === "") return false;
  }
  const pdfs = files.filter(f => f.mime === PDF).length;
  return pdfs === 0 || (pdfs === 1 && files.length === 1);
}

const text = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";

/* One row as the model gave it -> a row the page can trust, or null to drop it. */
function cleanRow(r){
  if(!r || typeof r !== "object") return null;
  if(typeof r.name !== "string") return null;
  const name = r.name.trim();
  if(name === "" || name.length > MAX_NAME) return null;
  let price = r.price === undefined ? null : r.price;
  if(price !== null && !(typeof price === "number" && Number.isFinite(price) && price >= PRICE_MIN && price <= PRICE_MAX)) return null;
  return {
    name: name,
    section: text(r.section, MAX_NAME),
    variant: text(r.variant, MAX_NAME),
    price: price,
    // a row with no price always needs a look
    unsure: r.unsure === true || price === null,
    // a kind that is missing or not one of ours is "other", never a reason to drop the row
    kind: KINDS.indexOf(r.kind) !== -1 ? r.kind : OTHER_KIND
  };
}

/* ---------- what is logged ----------
   Which stage a try stopped at, OpenRouter's status and its own error words,
   the length of the reply, how long it took and what it used (see askModel in
   _models.js). Never the key, a header, the request or any text of the menu. */
const refOf = f => f.stage === "ai_http" ? `ai_http_${f.status}` : f.stage;

/* One read by one model: photos as images and a PDF as a file, and the reply checked for the menu's shape. */
async function askOne(model, files, key, allowed, fullTry){
  const content = [{type: "text", text: INSTRUCTION}].concat(files.map(f => f.mime === PDF
    ? {type: "file", file: {filename: "menu.pdf", file_data: `data:${PDF};base64,${f.data}`}}
    : {type: "image_url", image_url: {url: `data:${f.mime};base64,${f.data}`}}));
  // a PDF goes to the model as it is, not through OpenRouter's paid text extraction
  const extra = files.some(f => f.mime === PDF) ? {plugins: [{id: "file-parser", pdf: {engine: "native"}}]} : null;
  const got = await askModel(model, key, content, SCHEMA, allowed, fullTry, extra);
  if(got.fail) return got;
  const out = got.out;
  if(!out || typeof out !== "object" || typeof out.not_a_menu !== "boolean" || !Array.isArray(out.items)){
    return {fail: Object.assign({stage: got.stopped ? "bad_shape" : "blocked"}, got.seen)};
  }
  return {menu: out};
}

export default {
  async fetch(request){
    if(request.method !== "POST") return fail(405, "method");
    const key = process.env.OPENROUTER_API_KEY;
    if(!key) return fail(503, "not_set_up");

    let body = null;
    try { body = await request.json(); } catch(e){ body = null; }
    if(!body || typeof body !== "object" || !filesOk(body.files)) return fail(400, "bad_files");
    if(body.files.reduce((n, f) => n + f.data.length, 0) > MAX_BASE64) return fail(413, "too_large");

    const size = body.files.reduce((n, f) => n + f.data.length, 0);
    // the models are asked in turn; one line is logged for each try that failed
    const files = {count: body.files.length, base64: size};
    const asked = await askChain(TIME, (model, allowed, fullTry) => askOne(model, body.files, key, allowed, fullTry),
      (failed, model, tryNumber, tryMs) => console.error(JSON.stringify(Object.assign({}, failed, {model: model.id, try: tryNumber, ms: tryMs, files: files}))));
    const got = asked.got, tries = asked.tries, ms = asked.ms;
    if(got.fail){
      // the browser is told which stage, never OpenRouter's words
      const error = isBusy(got.fail) ? "busy" : isLimit(got.fail) ? "limit" : "read_failed";
      return reply(error === "busy" ? 503 : error === "limit" ? 429 : 502, {error: error, message: MESSAGES[error], ref: refOf(got.fail)});
    }

    const rows = got.menu.items.map(cleanRow);
    const good = rows.filter(Boolean);
    const items = good.slice(0, MAX_ROWS);
    console.log(JSON.stringify(Object.assign({model: asked.model.id, ms: ms, files: body.files.length, base64: size, rows: items.length, dropped: rows.length - items.length},
                                             tries > 1 ? {tries: tries} : {})));
    return reply(200, {
      not_a_menu: got.menu.not_a_menu,
      items: items,
      dropped: rows.length - items.length
    });
  }
};
