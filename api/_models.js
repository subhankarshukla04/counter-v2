/* Counter: the models both server functions ask, in order, and how a request
   moves along them. A file in /api whose name starts with an underscore is not
   a function of its own; read-menu.js and ideas.js import it.

   Each model has its own daily limit on the free tier, so when one is used up
   (429) the next is asked at once. A model that is busy (503), fails inside
   (500) or is stopped for being slow is asked once more after a short wait,
   and then the next model is asked. A model that Google says is not found,
   not available, not supported or not allowed for this key (400 or 404) is
   left out and the next is asked at once. Any other failure stops there. All
   the tries share the caller's one timer. */
export const MODELS = [
  // Gemini 3 models take a thinking level; "LOW" is the lowest gemini-3.8-flash allows
  {id: "gemini-3.8-flash", thinking: {thinkingLevel: "LOW"}},
  {id: "gemini-3.6-flash", thinking: {thinkingLevel: "LOW"}},
  // Gemini 2.5 models do not take a level; a thinking budget of 0 turns thinking off
  {id: "gemini-2.5-flash", thinking: {thinkingBudget: 0}}
];
export const endpointOf = model => `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`;

const RETRY_ON = [500, 503];
export const isLimit = f => !!f && f.stage === "google_http" && f.status === 429;
/* Google's own words for a model that cannot be asked at all. A 404 on the model's address is that by itself.
   A 400 counts only when its words are about the model, so a 400 about the request still stops. */
const GONE_WORDS = /not found|not available|unavailable|not supported|unsupported|not allowed|not permitted|no longer available|does not have access|not enabled/i;
export const isGone = f => {
  if(!f || f.stage !== "google_http" || (f.status !== 400 && f.status !== 404)) return false;
  const words = `${f.google_status || ""} ${f.google_message || ""}`;
  return f.status === 404 ? /NOT_FOUND/.test(words) || GONE_WORDS.test(words) : /model/i.test(words) && GONE_WORDS.test(words);
};
export const isBusy = f => !!f && (f.stage === "slow" || (f.stage === "google_http" && RETRY_ON.indexOf(f.status) !== -1));

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
