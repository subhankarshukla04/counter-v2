/* Counter: ideas for a shop. One POST with the owner's menu and what cafes
   near them offer; Google's model picks items, a discount and the words for
   3 ideas; every idea is checked here before it goes back. The model never
   does the sums: the page works out every price from the owner's own prices.
   Nothing is stored. One line is logged for each try, and it never holds the
   key, the access code, a header, the request or anything of the menu. */
import { createHash, timingSafeEqual } from "node:crypto";
import { MODELS, endpointOf, askChain, isBusy, isLimit } from "./_models.js";

const WRONG_CODE_WAIT_MS = 1000;
const MAX_BODY = 300000;        // characters
const MENU_MIN = 2, MENU_MAX = 400;
const MAX_OFFERS = 100, MAX_NEW = 100, MAX_MARKET = 20, MAX_AVOID = 30;
const TITLE_MAX = 40, WHY_MAX = 220;
const DISCOUNT_MIN = 5, DISCOUNT_MAX = 30;
const HOUR_MIN = 7, HOUR_MAX = 22;
const TYPES = ["bundle", "price_cut"];
const DAYS = ["weekdays", "weekends", "every day"];
const ITEMS_IN = {bundle: [2, 3], price_cut: [1, 4]};
// The platform stops this function at 60 seconds (vercel.json). All the tries
// together are given a little less, so the reply below is sent before that.
// One try is stopped at 40 seconds. A busy or slow model is asked again after
// 5 seconds, and a new try starts only with 8 seconds or more left. Which model
// is asked next is in _models.js.
const TIME = {overallMs: 55000, tryMs: 40000, waitMs: 5000, needsMs: 8000};

const INSTRUCTION = [
  "You help a small cafe or bakery owner in Singapore decide on new bundles and price cuts. Write 3 ideas.",
  "Each idea is a \"bundle\" (2 or 3 items from the owner's menu sold together) or a \"price_cut\" (1 to 4 items from the owner's menu at a lower price on set days and hours).",
  "Use only item ids from the owner's menu.",
  "Choose a discount_percent from 5 to 30.",
  "For a price_cut, choose days (\"weekdays\", \"weekends\" or \"every day\") and either set all_day to true, or set all_day to false with a start_hour and an end_hour from 7 to 22, the end after the start. For a bundle, set days, all_day, start_hour and end_hour to null.",
  "Write a short title in plain words, at most 40 characters, and a \"why\" of one or two plain sentences, at most 220 characters, about what cafes near them do and how this idea fits the owner's menu.",
  "In \"why\", you may name a cafe only if it appears in the offers or new items given, and list every cafe you name in cafes_named. Never write any price or any dollar amount in \"why\" or the title.",
  "Do not repeat any idea in \"avoid\". Make the 3 ideas different from each other.",
  "In the data: \"menu\" is the owner's own menu; \"offers\" are offers other cafes run now, and competitor is true for the cafes the owner competes with; \"new_items\" are items those competitors added; \"market\" is the usual price other cafes charge for common items; \"avoid\" lists ideas the owner has already seen."
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {type: "string", enum: TYPES},
          title: {type: "string"},
          item_ids: {type: "array", items: {type: "string"}},
          discount_percent: {type: "integer"},
          days: {type: ["string", "null"]},
          all_day: {type: ["boolean", "null"]},
          start_hour: {type: ["integer", "null"]},
          end_hour: {type: ["integer", "null"]},
          why: {type: "string"},
          cafes_named: {type: "array", items: {type: "string"}}
        },
        required: ["type", "title", "item_ids", "discount_percent", "days", "all_day", "start_hour", "end_hour", "why", "cafes_named"]
      }
    }
  },
  required: ["ideas"]
};

const MESSAGES = {
  method: "Send a POST request.",
  not_set_up: "Menu reading is not switched on yet.",
  bad_code: "That access code is not right.",
  bad_request: "We could not use this request.",
  limit: "The daily limit for ideas is used up. Try again tomorrow.",
  read_failed: "Something went wrong while reading. Nothing was saved. Try again.",
  busy: "The AI is busy right now. Wait a minute and try again.",
  no_ideas: "We could not make ideas this time. Try again."
};

function reply(status, body){
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
  });
}
const fail = (status, error) => reply(status, {error: error, message: MESSAGES[error]});

/* the same time is taken whether the two differ at the first character or the last */
function sameText(a, b){
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

const text = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const idKey = (type, ids) => type + "|" + ids.slice().sort().join(",");

/* What the browser sent -> the parts that go to the model, each in a known
   shape, or null when it cannot be used. */
function cleanRequest(body){
  if(!body || typeof body !== "object" || !Array.isArray(body.menu)) return null;
  if(body.menu.length < MENU_MIN || body.menu.length > MENU_MAX) return null;
  const menu = [], seen = new Set();
  for(const r of body.menu){
    if(!r || typeof r !== "object" || typeof r.id !== "string" || r.id === "" || r.id.length > 40 || seen.has(r.id)) return null;
    if(typeof r.name !== "string" || r.name.trim() === "" || typeof r.price !== "number" || !Number.isFinite(r.price) || r.price <= 0) return null;
    seen.add(r.id);
    menu.push({id: r.id, name: text(r.name, 200), variant: text(r.variant, 200), price: r.price, kind: text(r.kind, 20)});
  }
  const list = (v, max) => Array.isArray(v) ? v.filter(x => x && typeof x === "object").slice(0, max) : [];
  return {
    shop_name: text(body.shop_name, 80),
    menu: menu,
    offers: list(body.offers, MAX_OFFERS).filter(o => text(o.cafe, 120) && text(o.text, 600)).map(o => (
      {id: text(o.id, 40), cafe: text(o.cafe, 120), text: text(o.text, 600), type: TYPES.indexOf(o.type) !== -1 ? o.type : "", competitor: o.competitor === true})),
    new_items: list(body.new_items, MAX_NEW).filter(n => text(n.cafe, 120) && text(n.name, 200)).map(n => (
      {cafe: text(n.cafe, 120), name: text(n.name, 200), price: typeof n.price === "number" && Number.isFinite(n.price) ? n.price : null})),
    market: list(body.market, MAX_MARKET).filter(m => text(m.item, 80) && typeof m.usual_price === "number" && Number.isFinite(m.usual_price)).map(m => (
      {item: text(m.item, 80), usual_price: m.usual_price})),
    avoid: list(body.avoid, MAX_AVOID).filter(a => TYPES.indexOf(a.type) !== -1 && Array.isArray(a.item_ids) && a.item_ids.every(i => typeof i === "string")).map(a => (
      {type: a.type, item_ids: a.item_ids.slice(0, 4)}))
  };
}

/* the one text the model is given: the instruction, then the data */
const promptText = clean => INSTRUCTION + "\n\nDATA\n" + JSON.stringify({
  shop_name: clean.shop_name, menu: clean.menu, offers: clean.offers, new_items: clean.new_items, market: clean.market, avoid: clean.avoid});

/* the whole request to Google for one model: the same shape as reading a menu */
const googleRequest = (clean, model) => ({
  contents: [{parts: [{text: promptText(clean)}]}],
  generationConfig: {
    responseMimeType: "application/json",
    responseJsonSchema: SCHEMA,
    thinkingConfig: (model || MODELS[0]).thinking
  }
});

const PRICE_WORDS = /\$|\d\s*dollars?/i;       // a price, or a number of dollars
/* One idea as the model gave it -> {idea} in a known shape, or {reason} for dropping it. */
function checkIdea(raw, clean, taken){
  if(!raw || typeof raw !== "object") return {reason: "not an idea"};
  if(TYPES.indexOf(raw.type) === -1) return {reason: "unknown type"};
  const ids = raw.item_ids;
  if(!Array.isArray(ids) || !ids.every(i => typeof i === "string")) return {reason: "item ids missing"};
  const known = new Set(clean.menu.map(r => r.id));
  if(!ids.every(i => known.has(i))) return {reason: "an item is not on the menu"};
  if(new Set(ids).size !== ids.length) return {reason: "an item repeats"};
  const span = ITEMS_IN[raw.type];
  if(ids.length < span[0] || ids.length > span[1]) return {reason: `a ${raw.type} needs ${span[0]} to ${span[1]} items`};
  const d = raw.discount_percent;
  if(!Number.isInteger(d) || d < DISCOUNT_MIN || d > DISCOUNT_MAX) return {reason: "discount outside 5 to 30"};
  let days = null, allDay = null, start = null, end = null;
  if(raw.type === "price_cut"){
    if(DAYS.indexOf(raw.days) === -1) return {reason: "bad days"};
    days = raw.days;
    allDay = raw.all_day === true;
    if(!allDay){
      start = raw.start_hour; end = raw.end_hour;
      if(!Number.isInteger(start) || !Number.isInteger(end) || start < HOUR_MIN || end > HOUR_MAX || end <= start) return {reason: "bad hours"};
    }
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "", why = typeof raw.why === "string" ? raw.why.trim() : "";
  if(title === "" || title.length > TITLE_MAX) return {reason: "title empty or too long"};
  if(why === "" || why.length > WHY_MAX) return {reason: "why empty or too long"};
  if(PRICE_WORDS.test(title) || PRICE_WORDS.test(why)) return {reason: "a price in the words"};
  const cafes = new Set(clean.offers.map(o => o.cafe.toLowerCase()).concat(clean.new_items.map(n => n.cafe.toLowerCase())));
  const named = Array.isArray(raw.cafes_named) ? raw.cafes_named : null;
  if(!named || !named.every(c => typeof c === "string" && c.trim() !== "")) return {reason: "cafes_named missing"};
  for(const c of named){
    if(!cafes.has(c.trim().toLowerCase())) return {reason: "names a cafe that was not given"};
    if(why.toLowerCase().indexOf(c.trim().toLowerCase()) === -1) return {reason: "lists a cafe the why does not name"};
  }
  const key = idKey(raw.type, ids);
  if(clean.avoid.some(a => idKey(a.type, a.item_ids) === key)) return {reason: "repeats an idea to avoid"};
  if(taken.has(key)) return {reason: "repeats another idea in the reply"};
  taken.add(key);
  return {idea: {type: raw.type, title: title, item_ids: ids.slice(), discount_percent: d, days: days, all_day: allDay,
                 start_hour: start, end_hour: end, why: why, cafes_named: named.map(c => c.trim())}};
}
/* every idea of a reply: the ones that may be shown, and why each of the others was dropped */
function validateIdeas(ideas, clean){
  const taken = new Set(), kept = [], dropped = [];
  (Array.isArray(ideas) ? ideas : []).forEach((raw, i) => {
    const got = checkIdea(raw, clean, taken);
    if(got.idea) kept.push(got.idea); else dropped.push({index: i, reason: got.reason});
  });
  return {kept: kept, dropped: dropped};
}

/* ---------- what is logged ----------
   Which stage a try stopped at, Google's status and its own error words, the
   shape of the reply, how long it took and how many tokens it used. Never the
   key, the code, a header, the request or any text of the menu or the ideas. */
const KEY_LIKE = /[A-Za-z0-9_-]{20,}/g;      // anything long enough to be a key is taken out
const safeWords = (v, max) => typeof v === "string" ? v.replace(KEY_LIKE, "[removed]").slice(0, max) : undefined;
const partShapes = parts => ({
  count: parts.length,
  each: parts.slice(0, 20).map(p => {
    const shape = {fields: p && typeof p === "object" ? Object.keys(p) : []};
    if(p && typeof p.text === "string") shape.text_length = p.text.length;
    return shape;
  })
});
const tokens = data => {
  const u = data && data.usageMetadata;
  const n = v => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return u && typeof u === "object" ? {input_tokens: n(u.promptTokenCount), output_tokens: n(u.candidatesTokenCount)} : {};
};
const refOf = f => f.stage === "google_http" ? `google_http_${f.status}` : f.stage;

/* One call to Google, given this many milliseconds. Gives {ideas, usage} when
   the reply could be read, else {fail: {stage, ...}} with what may be logged. */
async function askGoogle(model, clean, key, allowed, fullTry){
  const outOfTime = fullTry ? "slow" : "timeout";
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop.abort(); }, allowed);
  try {
    let res = null;
    try {
      res = await fetch(endpointOf(model), {
        method: "POST",
        headers: {"x-goog-api-key": key, "Content-Type": "application/json"},
        body: JSON.stringify(googleRequest(clean, model)),
        signal: stop.signal
      });
    } catch(e){
      return {fail: {stage: timedOut ? outOfTime : "network"}};
    }
    if(!res.ok){
      const failed = {stage: "google_http", status: res.status};
      try {
        const err = (await res.json()).error;
        if(err && typeof err === "object"){
          failed.google_status = safeWords(err.status, 60);
          failed.google_message = safeWords(err.message, 300);
        }
      } catch(e){ /* no error object to read */ }
      return {fail: failed};
    }
    let data = null;
    try { data = await res.json(); }
    catch(e){ return {fail: {stage: timedOut ? outOfTime : "not_json", status: res.status}}; }
    const first = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    if(!first || typeof first !== "object"){
      const block = data && data.promptFeedback && data.promptFeedback.blockReason;
      return {fail: Object.assign(block ? {stage: "blocked", status: res.status, finish_reason: safeWords(String(block), 60)}
                                        : {stage: "no_candidates", status: res.status}, tokens(data))};
    }
    const parts = first.content && Array.isArray(first.content.parts) ? first.content.parts : [];
    const seen = Object.assign({status: res.status, finish_reason: safeWords(first.finishReason, 60), parts: partShapes(parts)}, tokens(data));
    const stopped = first.finishReason === undefined || first.finishReason === "STOP";
    let out = null;
    try { out = JSON.parse(parts.filter(p => p && typeof p.text === "string" && !p.thought).map(p => p.text).join("")); }
    catch(e){ return {fail: Object.assign({stage: stopped ? "not_json" : "blocked"}, seen)}; }
    if(!out || typeof out !== "object" || !Array.isArray(out.ideas)) return {fail: Object.assign({stage: stopped ? "bad_shape" : "blocked"}, seen)};
    return {ideas: out.ideas, usage: tokens(data)};
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request){
    if(request.method !== "POST") return fail(405, "method");
    const key = process.env.GEMINI_API_KEY, code = process.env.COUNTER_ACCESS_CODE;
    if(!key || !code) return fail(503, "not_set_up");

    let raw = "", body = null;
    try { raw = await request.text(); body = JSON.parse(raw); } catch(e){ body = null; }
    if(!body || typeof body !== "object" || typeof body.code !== "string" || body.code === "" || !sameText(body.code, code)){
      // a wrong code is answered slowly, so codes cannot be tried quickly
      await new Promise(done => setTimeout(done, WRONG_CODE_WAIT_MS));
      return fail(401, "bad_code");
    }
    const clean = raw.length > MAX_BODY ? null : cleanRequest(body);
    if(!clean) return fail(400, "bad_request");

    // the models are asked in turn; one line is logged for each try that failed
    const asked = await askChain(TIME, (model, allowed, fullTry) => askGoogle(model, clean, key, allowed, fullTry),
      (failed, model, tryNumber, tryMs) => console.error(JSON.stringify(Object.assign({what: "ideas"}, failed, {model: model.id, try: tryNumber, ms: tryMs, menu_rows: clean.menu.length}))));
    const got = asked.got, tries = asked.tries, ms = asked.ms;
    if(got.fail){
      // the browser is told which stage, never Google's words
      const error = isBusy(got.fail) ? "busy" : isLimit(got.fail) ? "limit" : "read_failed";
      return reply(error === "busy" ? 503 : error === "limit" ? 429 : 502, {error: error, message: MESSAGES[error], ref: refOf(got.fail)});
    }

    const checked = validateIdeas(got.ideas, clean);
    console.log(JSON.stringify(Object.assign({what: "ideas", model: asked.model.id, ms: ms}, got.usage, {menu_rows: clean.menu.length, ideas: checked.kept.length, dropped: checked.dropped.length},
                                             tries > 1 ? {tries: tries} : {})));
    if(!checked.kept.length) return reply(502, {error: "no_ideas", message: MESSAGES.no_ideas, ref: "no_ideas"});
    return reply(200, {ideas: checked.kept, dropped: checked.dropped.length});
  },
  // for the test script outside the repo: the same instruction, request and checks, with nothing copied
  ENDPOINT: endpointOf(MODELS[0]), INSTRUCTION, SCHEMA, cleanRequest, promptText, googleRequest, validateIdeas
};
