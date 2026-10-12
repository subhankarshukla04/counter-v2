/* Counter: the models both server functions ask, in order, and how a request
   moves along them. A file in /api whose name starts with an underscore is not
   a function of its own; read-menu.js and ideas.js import it.

   Every model is asked through OpenRouter with one key (OPENROUTER_API_KEY).
   A model that is rate limited (429) is left and the next is asked at once. A
   model that is busy (502, 503), fails inside (500) or is stopped for being
   slow is asked once more after a short wait, and then the next model is
   asked. A model that OpenRouter says is not found or not available (400 or
   404) is left out and the next is asked at once. Any other failure stops
   there, including 402: the account is out of credit, and no model will
   answer. All the tries share the caller's one timer. */
export const MODELS = [
  {id: "google/gemini-3.8-flash", reasoning: {effort: "low", exclude: true}},
  {id: "google/gemini-3.6-flash", reasoning: {effort: "low", exclude: true}},
  {id: "google/gemini-2.5-flash", reasoning: {effort: "low", exclude: true}}
];
export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const RETRY_ON = [500, 502, 503];
export const isLimit = f => !!f && f.stage === "ai_http" && f.status === 429;
/* OpenRouter's words for a model that cannot be asked at all. A 404 is that by itself.
   A 400 counts only when its words are about the model, so a 400 about the request still stops. */
const GONE_WORDS = /no endpoints|not a valid model|not found|not available|unavailable|not supported|unsupported|not allowed|not permitted|no longer available|does not have access|not enabled/i;
export const isGone = f => {
  if(!f || f.stage !== "ai_http" || (f.status !== 400 && f.status !== 404)) return false;
  const words = `${f.ai_status || ""} ${f.ai_message || ""}`;
  return f.status === 404 || (/model|endpoint/i.test(words) && GONE_WORDS.test(words));
};
export const isBusy = f => !!f && (f.stage === "slow" || (f.stage === "ai_http" && RETRY_ON.indexOf(f.status) !== -1));

/* Ask the models in turn.
   rule: {overallMs, tryMs, waitMs, needsMs}: the time for everything, the most one try may take, the wait before
         the same model is asked again, and the least time that must be left for a new try to start.
   askOnce(model, allowedMs, fullTry): one call; gives {fail: {stage, ...}} or anything else for a reply that could be read.
   onFail(fail, model, tryNumber, ms): called for each try that failed, for the log.
   Gives {got, model, tries, ms}: the last answer, the model that gave it, how many tries were made, and the time taken. */
export async function askChain(rule, askOnce, onFail){
  const began = Date.now(), left = () => rule.overallMs - (Date.now() - began);
  let got = null, model = MODELS[0], tries = 0;
  const done = () => ({got: got, model: model, tries: tries, ms: Date.now() - began});
  for(let i = 0; i < MODELS.length; i += 1){
    model = MODELS[i];
    for(let round = 0; round < 2; round += 1){
      const from = Date.now(), time = left();
      got = await askOnce(model, Math.min(time, rule.tryMs), time > rule.tryMs);
      tries += 1;
      if(!got.fail) return done();
      onFail(got.fail, model, tries, Date.now() - from);
      if(isLimit(got.fail) || isGone(got.fail)) break;   // used up for today, or not there to ask: the next model, at once
      if(!isBusy(got.fail)) return done();         // anything else stops here
      if(round === 1) break;                       // busy twice: the next model
      if(left() - rule.waitMs < rule.needsMs) return done();
      await new Promise(ok => setTimeout(ok, rule.waitMs));
    }
    if(i + 1 < MODELS.length && left() < rule.needsMs) return done();
  }
  return done();
}

/* One call to OpenRouter, given this many milliseconds.
   content: the message parts (text, image_url, file); schema: the JSON Schema the reply must follow.
   Gives {out, seen, usage} when the reply is JSON, else {fail: {stage, ...}} with what may be logged:
   never the key, the request or the words of the reply. A call stopped by its timer is "slow" when it
   used a full try, and "timeout" when the time for the whole request ran out. */
const KEY_LIKE = /[A-Za-z0-9_-]{20,}/g;      // anything long enough to be a key is taken out
const safeWords = (v, max) => typeof v === "string" ? v.replace(KEY_LIKE, "[removed]").slice(0, max) : undefined;
const usageOf = data => {
  const u = data && data.usage;
  const n = v => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return u && typeof u === "object" ? {input_tokens: n(u.prompt_tokens), output_tokens: n(u.completion_tokens), cost: n(u.cost)} : {};
};
export async function askModel(model, key, content, schema, allowed, fullTry, extra){
  const outOfTime = fullTry ? "slow" : "timeout";
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop.abort(); }, allowed);
  try {
    let res = null;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {"Authorization": "Bearer " + key, "Content-Type": "application/json",
                  "HTTP-Referer": "https://counter-cafe.vercel.app", "X-Title": "Counter"},
        body: JSON.stringify(Object.assign({
          model: model.id,
          messages: [{role: "user", content: content}],
          response_format: {type: "json_schema", json_schema: {name: "reply", strict: true, schema: schema}},
          reasoning: model.reasoning,
          // only providers that honour the JSON Schema
          provider: {require_parameters: true}
        }, extra || {})),
        signal: stop.signal
      });
    } catch(e){
      return {fail: {stage: timedOut ? outOfTime : "network"}};
    }
    if(!res.ok){
      // OpenRouter's own error object says why: its code and its message
      const fail = {stage: "ai_http", status: res.status};
      try {
        const err = (await res.json()).error;
        if(err && typeof err === "object"){
          fail.ai_status = safeWords(String(err.code === undefined ? "" : err.code), 60);
          fail.ai_message = safeWords(err.message, 300);
        }
      } catch(e){ /* no error object to read */ }
      return {fail: fail};
    }
    let data = null;
    try { data = await res.json(); }
    catch(e){ return {fail: {stage: timedOut ? outOfTime : "not_json", status: res.status}}; }
    // OpenRouter can answer 200 with an error inside, when the model failed after the request was taken
    if(data && data.error && typeof data.error === "object"){
      const status = typeof data.error.code === "number" ? data.error.code : 502;
      return {fail: {stage: "ai_http", status: status, ai_message: safeWords(data.error.message, 300)}};
    }
    const first = data && Array.isArray(data.choices) ? data.choices[0] : null;
    if(!first || typeof first !== "object") return {fail: Object.assign({stage: "no_candidates", status: res.status}, usageOf(data))};
    const text = first.message && typeof first.message.content === "string" ? first.message.content : "";
    const seen = Object.assign({status: res.status, finish_reason: safeWords(first.finish_reason, 60), text_length: text.length}, usageOf(data));
    // a reply that did not stop in the normal way is named as that, whatever else is wrong with it
    const stopped = !first.finish_reason || first.finish_reason === "stop";
    let out = null;
    try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch(e){ return {fail: Object.assign({stage: stopped ? "not_json" : "blocked"}, seen)}; }
    return {out: out, seen: seen, stopped: stopped, usage: usageOf(data)};
  } finally {
    clearTimeout(timer);
  }
}
