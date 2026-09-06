const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const root = path.join(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const clone = (value) => structuredClone(value);
const tags = (label) => [{ label, words: [label], excludes: [] }];
const legacy = () => ({
  keywords: tags("Python"), activeSet: "仕事",
  tagSets: [{ name: "仕事", keywords: tags("Python") }, { name: "趣味", keywords: tags("Soccer") }],
  wordCounts: { unrelated: 99 }, autoKeywords: ["unrelated"], ignoredWords: ["noise"],
  settings: { autoEnabled: true, autoThreshold: 3, hidePromoted: true, filterMode: false },
});

function environment(initial = legacy()) {
  const stored = clone(initial);
  const listeners = [];
  let handler;
  let pending = 0;
  const writes = [];
  const chrome = {
    runtime: {
      id: "x-tagger-test",
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage(message) {
        pending++;
        return new Promise((resolve) => {
          handler(clone(message), { id: "x-tagger-test" }, (result) => {
            pending--;
            resolve(clone(result));
          });
        });
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return Object.hasOwn(stored, keys) ? { [keys]: clone(stored[keys]) } : {};
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) =>
            [key, clone(Object.hasOwn(stored, key) ? stored[key] : fallback)]));
        },
        async set(patch) {
          const changes = {};
          writes.push(clone(patch));
          for (const [key, value] of Object.entries(patch)) {
            if (JSON.stringify(stored[key]) === JSON.stringify(value)) continue;
            changes[key] = { oldValue: clone(stored[key]), newValue: clone(value) };
            stored[key] = clone(value);
          }
          if (Object.keys(changes).length) queueMicrotask(() => {
            listeners.forEach((listener) => listener(clone(changes), "local"));
          });
        },
      },
      onChanged: {
        addListener(callback) { listeners.push(callback); },
        removeListener(callback) {
          const index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
    },
  };
  function context(extra = {}) {
    const ctx = vm.createContext({ chrome, structuredClone, crypto: { randomUUID }, console, ...extra });
    vm.runInContext(source("statistics.js"), ctx);
    return ctx;
  }
  function startWorker() {
    const ctx = context();
    ctx.importScripts = () => {};
    vm.runInContext(source("background.js"), ctx);
  }
  startWorker();
  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type: `statistics:${type}`, ...payload });
    assert.equal(result.ok, true, result.error);
    return result;
  }
  async function settle() {
    for (let i = 0; i < 100; i++) {
      await new Promise(setImmediate);
      if (pending === 0) return;
    }
    throw new Error("Extension messages did not settle");
  }
  async function switchSet(name) {
    const set = stored.tagSets.find((item) => item.name === name);
    await chrome.storage.local.set({ activeSet: name, keywords: set.keywords });
    await settle();
    return request("get");
  }
  return { stored, chrome, writes, context, request, settle, switchSet, startWorker };
}

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.events = {};
    this.className = "";
    this.value = "";
    this.disabled = false;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((part) => part !== name).join(" "); },
      toggle: (name) => {
        const selected = !this.classList.contains(name);
        this.classList[selected ? "add" : "remove"](name);
        return selected;
      },
    };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text ?? ""; }
  set innerHTML(value) { this.textContent = value; }
  get childElementCount() { return this.children.length; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child) { this.appendChild(child); }
  replaceChild(next, previous) { this.children[this.children.indexOf(previous)] = next; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { (this.events[type] ??= []).push(callback); }
  async fire(type = "click") {
    for (const callback of this.events[type] ?? []) await callback({ target: this });
  }
  querySelectorAll(selector) {
    const matches = (element) => selector === "button, input"
      ? ["button", "input"].includes(element.tagName)
      : selector.split(".").filter(Boolean).every((name) => element.classList.contains(name));
    return this.children.flatMap((child) => [ ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  matches(selector) {
    return selector === 'article[data-testid="tweet"]' && this.tagName === "article";
  }
  focus() {}
  select() {}
  remove() {}
}

class Document extends Element {
  constructor() { super(); this.body = new Element(); this.articles = []; }
  createElement(tag) { return new Element(tag); }
  querySelectorAll(selector) {
    return selector.includes('article[data-testid="tweet"]') ? this.articles : super.querySelectorAll(selector);
  }
}

function popup(env, prompt = async () => '{"noise":["django","flask","not-in-ranking"]}') {
  const document = new Document();
  const elements = {};
  const ai = { created: [], destroyed: [] };
  for (const match of source("popup.html").matchAll(/<([a-z0-9]+)[^>]*\bid="([^"]+)"/g)) {
    elements[match[2]] = document.appendChild(new Element(match[1]));
  }
  document.getElementById = (id) => elements[id];
  const context = env.context({ document, setTimeout, clearTimeout, confirm: () => true,
    LanguageModel: {
      availability: async () => "available",
      create: async (options) => {
        const session = { prompt, destroy() { ai.destroyed.push(session); } };
        ai.created.push({ options, session });
        return session;
      },
    },
  });
  vm.runInContext(source("popup.js"), context);
  return { context, elements, ai };
}

function content(env, overrides = {}) {
  const document = new Document();
  const lifecycle = { disconnected: 0, clearedTimers: 0, cancelledFrames: 0 };
  const context = env.context({
    document, Element, Document, location: { pathname: "/home" }, Intl,
    MutationObserver: class {
      constructor(callback) { lifecycle.mutation = callback; }
      observe() {}
      disconnect() { lifecycle.disconnected++; }
    },
    requestAnimationFrame(callback) { lifecycle.frame = callback; return 1; },
    cancelAnimationFrame() { lifecycle.cancelledFrames++; },
    setInterval(callback) { lifecycle.timer = callback; return 1; },
    clearInterval() { lifecycle.clearedTimers++; },
    ...overrides,
  });
  vm.runInContext(source("content.js"), context);
  function addTweet(id, text, promoted = false) {
    const article = new Element("article");
    const cell = new Element();
    const textEl = new Element();
    textEl.innerText = text;
    textEl.parentElement = new Element();
    article.closest = (selector) => selector.includes("cellInnerDiv") ? cell : null;
    article.querySelector = (selector) => {
      if (selector.includes("/status/")) return { closest: () => ({ href: `https://x.com/u/status/${id}` }) };
      if (selector.includes("tweetText")) return textEl;
      if (selector.includes("placementTracking")) return promoted ? new Element() : null;
      return null;
    };
    document.articles.push(article);
    vm.runInContext("scan(document)", context);
    return article;
  }
  const flush = async () => { await vm.runInContext("flushCounts()", context); await env.settle(); };
  return { context, document, addTweet, flush, lifecycle };
}

test("migration preserves tags and ignored words, isolates legacy counts and automatic tags", async () => {
  const env = environment();
  const current = await env.request("get");
  assert.deepEqual(current.config.keywords, tags("Python"));
  assert.deepEqual(current.stats.wordCounts, {});
  assert.deepEqual(current.stats.autoKeywords, []);
  assert.deepEqual(current.stats.ignoredWords, ["noise"]);
  assert.deepEqual(env.stored.wordCounts, { unrelated: 99 });
  const again = await env.request("get");
  assert.deepEqual(again.scope, current.scope);
});

test("sets keep independent counts, automatic tags and ignores; rename keeps statistics", async () => {
  const env = environment();
  const work = await env.request("get");
  await env.request("count", { scope: work.scope, counts: { django: 3, flask: 1 } });
  const hobby = await env.switchSet("趣味");
  assert.deepEqual(hobby.stats.wordCounts, {});
  assert.deepEqual(hobby.stats.autoKeywords, []);
  await env.request("count", { scope: hobby.scope, counts: { stadium: 3 } });
  // 切り替え前のバッチは元のセットへ保存される。
  await env.request("count", { scope: work.scope, counts: { flask: 1 } });
  await env.request("ignore", { scope: work.scope, words: ["flask"] });
  const restored = await env.switchSet("仕事");
  assert.deepEqual(restored.stats.wordCounts, { django: 3, flask: 2 });
  assert.deepEqual(restored.stats.autoKeywords, ["django"]);
  assert.ok(restored.stats.ignoredWords.includes("flask"));
  const sets = clone(env.stored.tagSets);
  sets[0].name = "開発";
  await env.chrome.storage.local.set({ tagSets: sets, activeSet: "開発" });
  assert.deepEqual((await env.request("get")).scope, work.scope);
  assert.deepEqual((await env.switchSet("趣味")).stats.ignoredWords, ["noise"]);
});

test("editing matching rules starts fresh and rejects stale batches", async () => {
  const env = environment();
  const old = await env.request("get");
  await env.request("count", { scope: old.scope, counts: { django: 3 } });
  const sets = clone(env.stored.tagSets);
  sets[0].keywords[0].excludes = ["Python snake"];
  await env.chrome.storage.local.set({ tagSets: sets, keywords: sets[0].keywords });
  const current = await env.request("get");
  assert.deepEqual(current.stats.wordCounts, {});
  assert.deepEqual(current.stats.autoKeywords, []);
  assert.equal((await env.request("count", { scope: old.scope, counts: { django: 100 } })).stale, true);
  assert.notEqual(old.scope.revision, current.scope.revision);
});

test("concurrent tab additions merge; resets reject late writes even after worker restart", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await Promise.all([
    env.request("count", { scope, counts: { django: 2 } }),
    env.request("count", { scope, counts: { django: 3 } }),
  ]);
  assert.equal((await env.request("get")).stats.wordCounts.django, 5);
  await env.request("ignore", { scope, words: ["django"] });
  const results = await Promise.all([
    env.request("reset", { scope }),
    env.request("count", { scope, counts: { django: 999 } }),
  ]);
  assert.equal(results[1].stale, true);
  env.startWorker();
  assert.equal((await env.request("count", { scope, counts: { django: 999 } })).stale, true);
  const reset = await env.request("get");
  assert.deepEqual(reset.stats.wordCounts, {});
  assert.deepEqual(reset.stats.autoKeywords, []);
  assert.ok(reset.stats.ignoredWords.includes("django"));
  await env.request("count", { scope: reset.scope, counts: { flask: 1 } });
  assert.deepEqual((await env.request("get")).stats.wordCounts, { flask: 1 });
});

test("content counts only matching non-ad posts, excludes emoji and deduplicates across set switches", async () => {
  const env = environment();
  const tab = content(env);
  await env.settle();
  tab.addTweet(1, "Soccer Stadium");
  tab.addTweet(2, "Python Django 😀 🚀 🇯🇵 1️⃣");
  tab.addTweet(3, "Python Advertisement", true);
  await tab.flush();
  const work = await env.request("get");
  assert.deepEqual(work.stats.wordCounts, { python: 1, django: 1 });
  tab.addTweet(2, "Python Django");
  await tab.flush();
  assert.equal((await env.request("get")).stats.wordCounts.django, 1);
  await env.switchSet("趣味");
  await tab.flush();
  assert.deepEqual((await env.request("get")).stats.wordCounts, { soccer: 1, stadium: 1 });
  await env.switchSet("仕事");
  await tab.flush();
  assert.deepEqual((await env.request("get")).stats.wordCounts, work.stats.wordCounts);
});

test("reset discards unflushed counts in multiple live tabs and collects new posts", async () => {
  const env = environment();
  const one = content(env);
  const two = content(env);
  await env.settle();
  one.addTweet(1, "Python Django");
  two.addTweet(2, "Python Flask");
  const { scope } = await env.request("get");
  await env.request("reset", { scope });
  await env.settle();
  await one.flush();
  await two.flush();
  assert.deepEqual((await env.request("get")).stats.wordCounts, {});
  one.addTweet(3, "Python Fastapi");
  await one.flush();
  assert.deepEqual((await env.request("get")).stats.wordCounts, { python: 1, fastapi: 1 });
});

test("AI cleanup immediately excludes all returned ranking words with one click", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { django: 1, flask: 1, celery: 1 } });
  const ui = popup(env);
  await env.settle();
  await ui.elements["ai-clean"].fire();
  await env.settle();
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise", "django", "flask"]);
  assert.deepEqual(ui.elements.freq.querySelectorAll(".freq-word").map((el) => el.textContent), ["celery"]);
  assert.match(ui.elements["ai-clean-status"].textContent, /2語を除外しました: django、flask/);
  assert.equal(ui.elements["ai-clean"].disabled, false);
  assert.deepEqual((await env.switchSet("趣味")).stats.ignoredWords, ["noise"]);
});

test("AI results generated before a set switch or reset cannot be applied afterward", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { django: 1 } });
  let finish;
  const ui = popup(env, () => new Promise((resolve) => { finish = resolve; }));
  await env.settle();
  const generation = ui.elements["ai-clean"].fire();
  await env.settle();
  await env.switchSet("趣味");
  finish('{"noise":["django"]}');
  await generation;
  assert.equal(ui.elements["ai-clean-status"].textContent, "");
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
  await env.switchSet("仕事");
  const second = ui.elements["ai-clean"].fire();
  await env.settle();
  await ui.elements["reset-counts"].fire();
  await env.settle();
  finish('{"noise":["django"]}');
  await second;
  assert.equal(ui.elements["ai-clean-status"].textContent, "");
  assert.deepEqual((await env.request("get")).stats.wordCounts, {});
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
});

test("popup creates, edits and deletes sets without exposing another set's statistics", async () => {
  const env = environment({});
  const ui = popup(env);
  await env.settle();
  ui.elements["new-keyword"].value = "Python";
  await ui.elements["add-btn"].fire();
  await env.settle();
  const original = await env.request("get");
  await env.request("count", { scope: original.scope, counts: { python: 1, django: 1 } });
  await env.settle();
  const top = vm.runInContext("topFreqWords()", ui.context);
  assert.equal(top.length, 1);
  assert.equal(top[0][0], "django");
  ui.elements["new-set"].value = "趣味";
  await ui.elements["add-set-btn"].fire();
  await env.settle();
  const hobby = await env.request("get");
  assert.equal(hobby.config.activeSet, "趣味");
  assert.deepEqual(hobby.config.keywords, []);
  assert.deepEqual(hobby.stats.wordCounts, {});
  assert.notEqual(original.scope.setId, hobby.scope.setId);
  vm.runInContext('deleteSet("趣味")', ui.context);
  await env.settle();
  assert.equal((await env.request("get")).stats.wordCounts.django, 1);
  vm.runInContext('deleteSet("セット1")', ui.context);
  await env.settle();
  const replacement = await env.request("get");
  assert.equal(replacement.config.activeSet, "セット1");
  assert.notEqual(replacement.scope.setId, original.scope.setId);
  assert.deepEqual(replacement.stats.wordCounts, {});
  assert.equal((await env.request("count", { scope: original.scope, counts: { django: 99 } })).stale, true);
});

test("malformed AI output leaves stored exclusions unchanged", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { django: 1 } });
  const ui = popup(env, async () => '{"noise":"django"}');
  await env.settle();
  await ui.elements["ai-clean"].fire();
  assert.match(ui.elements["ai-clean-status"].textContent, /AIエラー/);
  assert.equal(ui.elements["ai-clean"].disabled, false);
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
});

test("an invalidated API getter stops timers, observers and queued callbacks without throwing", async () => {
  const env = environment();
  let invalidated = false;
  let calls = 0;
  const runtime = { ...env.chrome.runtime, sendMessage(message) {
    calls++;
    return env.chrome.runtime.sendMessage(message);
  } };
  const chrome = { ...env.chrome, get runtime() {
    if (invalidated) throw new Error("Extension context invalidated.");
    return runtime;
  } };
  const tab = content(env, { chrome });
  await env.settle();
  const tweet = tab.addTweet(1, "Python Django");
  tab.lifecycle.mutation([{ target: tweet, addedNodes: [] }]);
  const queuedFrame = tab.lifecycle.frame;
  invalidated = true;
  assert.doesNotThrow(tab.lifecycle.timer);
  const previousCalls = calls;
  await vm.runInContext("refreshState()", tab.context);
  tab.lifecycle.timer();
  tab.lifecycle.mutation();
  queuedFrame();
  vm.runInContext('onStorageChanged({ keywords: {} }, "local")', tab.context);
  await env.settle();
  assert.equal(calls, previousCalls);
  assert.equal(tab.lifecycle.disconnected, 1);
  assert.equal(tab.lifecycle.clearedTimers, 1);
  assert.equal(tab.lifecycle.cancelledFrames, 1);
  assert.equal(tab.addTweet(1, "Python Django").dataset.xtDone, undefined);
});

test("invalidation during a count flush stops refresh even when runtime.id is still readable", async () => {
  const env = environment();
  let invalidated = false;
  const calls = [];
  const chrome = { ...env.chrome, runtime: { ...env.chrome.runtime, sendMessage(message) {
    calls.push(message.type);
    if (invalidated) throw new Error("Extension context invalidated.");
    return env.chrome.runtime.sendMessage(message);
  } } };
  const warnings = [];
  const tab = content(env, { chrome, console: { warn: (...args) => warnings.push(args) } });
  await env.settle();
  tab.addTweet(1, "Python Django");
  calls.length = 0;
  invalidated = true;
  await vm.runInContext("refreshState()", tab.context);
  assert.deepEqual(calls, ["statistics:count"]);
  assert.equal(tab.lifecycle.clearedTimers, 1);
  assert.deepEqual(warnings, []);
  assert.equal(tab.addTweet(2, "Python Flask").dataset.xtDone, undefined);
});

test("a response arriving after shutdown cannot resume content processing", async () => {
  const env = environment();
  let hold = false;
  let release;
  const runtime = { ...env.chrome.runtime, sendMessage(message) {
    if (hold) return new Promise((resolve) => { release = resolve; });
    return env.chrome.runtime.sendMessage(message);
  } };
  const tab = content(env, { chrome: { ...env.chrome, runtime } });
  await env.settle();
  const snapshot = await env.request("get");
  hold = true;
  const refresh = vm.runInContext("refreshState()", tab.context);
  await env.settle();
  runtime.id = undefined;
  tab.lifecycle.timer();
  release(snapshot);
  await refresh;
  assert.equal(tab.lifecycle.disconnected, 1);
  assert.equal(tab.addTweet(1, "Python Django").dataset.xtDone, undefined);
});

test("invalidation during listener registration or removal is handled quietly", async () => {
  const env = environment();
  const warnings = [];
  const invalid = () => { throw new Error("Extension context invalidated."); };
  const chrome = { ...env.chrome, storage: { ...env.chrome.storage, onChanged: {
    addListener: invalid, removeListener: invalid,
  } } };
  const tab = content(env, { chrome, console: { warn: (...args) => warnings.push(args) } });
  await env.settle();
  assert.equal(tab.lifecycle.clearedTimers, 1);
  assert.equal(tab.lifecycle.disconnected, 1);
  assert.deepEqual(warnings, []);
});

test("ordinary messaging failures retain pending counts for retry", async () => {
  const env = environment();
  let fail = false;
  const chrome = { ...env.chrome, runtime: { ...env.chrome.runtime, sendMessage(message) {
    if (fail) return Promise.reject(new Error("Worker temporarily unavailable"));
    return env.chrome.runtime.sendMessage(message);
  } } };
  const tab = content(env, { chrome });
  await env.settle();
  tab.addTweet(1, "Python Django");
  fail = true;
  await tab.flush();
  assert.equal(tab.lifecycle.clearedTimers, 0);
  fail = false;
  await tab.flush();
  assert.deepEqual((await env.request("get")).stats.wordCounts, { python: 1, django: 1 });
});

test("AI availability and session creation declare matching input and output languages", async () => {
  const env = environment();
  const ui = popup(env);
  await env.settle();
  let checked;
  let created;
  ui.context.LanguageModel = {
    availability: async (options) => { checked = clone(options); return "available"; },
    create: async ({ monitor, ...options }) => { created = clone(options); return {}; },
  };
  await vm.runInContext("aiAvailability()", ui.context);
  await vm.runInContext('getAiSession($("ai-status"))', ui.context);
  assert.deepEqual(checked, created);
  assert.deepEqual(created.expectedOutputs, [{ type: "text", languages: ["ja", "en"] }]);
  assert.deepEqual(created.expectedInputs, [{ type: "text", languages: ["ja", "en"] }]);
});

test("AI initialization errors are displayed without retrying with missing language options", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { django: 1 } });
  const ui = popup(env);
  await env.settle();
  const calls = [];
  ui.context.LanguageModel.create = async ({ monitor, ...options }) => {
    calls.push(clone(options));
    throw new Error("Model download failed");
  };
  await ui.elements["ai-clean"].fire();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].expectedOutputs, [{ type: "text", languages: ["ja", "en"] }]);
  assert.match(ui.elements["ai-clean-status"].textContent, /Model download failed/);
  assert.equal(ui.elements["ai-clean"].disabled, false);
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
});

for (const filterMode of [true, false]) {
  test(`automatic promotion expands collection beyond the original tags (filterMode=${filterMode})`, async () => {
    const initial = legacy();
    initial.settings.filterMode = filterMode;
    const env = environment(initial);
    const tab = content(env);
    await env.settle();
    const djangoPost = tab.addTweet(10, "Django Celery");
    const celeryPost = tab.addTweet(11, "Celery Redis");
    const unrelated = tab.addTweet(12, "Soccer Stadium");
    const ad = tab.addTweet(13, "Django Advertisement", true);
    const hidden = (article) => article.closest('[data-testid="cellInnerDiv"]').classList.contains("xt-hidden");
    assert.equal(hidden(djangoPost), filterMode);
    tab.addTweet(1, "Python Django");
    tab.addTweet(2, "Python Django");
    tab.addTweet(3, "Python Django");
    await tab.flush();
    assert.ok((await env.request("get")).stats.autoKeywords.includes("django"));
    assert.equal(hidden(djangoPost), false);
    await tab.flush();
    const first = (await env.request("get")).stats;
    assert.equal(first.wordCounts.python, 3);
    assert.equal(first.wordCounts.celery, 1);
    assert.equal(first.wordCounts.redis, undefined);

    // 新たに拾った投稿から次の自動タグが生まれ、さらに対象が広がる。
    tab.addTweet(4, "Django Celery");
    tab.addTweet(5, "Django Celery");
    await tab.flush();
    assert.ok((await env.request("get")).stats.autoKeywords.includes("celery"));
    assert.equal(hidden(celeryPost), false);
    await tab.flush();
    const expanded = (await env.request("get")).stats;
    assert.equal(expanded.wordCounts.redis, 1);
    assert.equal(expanded.wordCounts.python, 3); // 再判定で元の投稿を二重に数えない
    assert.equal(expanded.wordCounts.stadium, undefined);
    assert.equal(expanded.wordCounts.advertisement, undefined);
    assert.equal(hidden(unrelated), filterMode);
    assert.equal(hidden(ad), true);
  });
}

test("registering a frequent word also includes previously filtered posts without the original tag", async () => {
  const initial = legacy();
  initial.settings.filterMode = true;
  const env = environment(initial);
  const tab = content(env);
  const ui = popup(env);
  await env.settle();
  const hiddenPost = tab.addTweet(2, "Django Celery");
  tab.addTweet(1, "Python Django");
  await tab.flush();
  const cell = hiddenPost.closest('[data-testid="cellInnerDiv"]');
  assert.equal(cell.classList.contains("xt-hidden"), true);
  assert.equal((await env.request("get")).stats.wordCounts.celery, undefined);
  const row = ui.elements.freq.children.find((row) =>
    row.querySelectorAll(".freq-word")[0]?.textContent === "django");
  await row.querySelectorAll(".freq-add")[0].fire();
  await env.settle();
  await tab.flush();
  assert.equal(cell.classList.contains("xt-hidden"), false);
  const current = await env.request("get");
  assert.ok(current.config.keywords.some((tag) => tag.label === "django"));
  assert.equal(current.stats.wordCounts.celery, 1);
});

test("DOM updates process only changed posts instead of rescanning the timeline", async () => {
  const env = environment();
  const tab = content(env);
  await env.settle();
  const articles = Array.from({ length: 80 }, (_, index) => tab.addTweet(index + 1, "Python Django"));
  const reads = new Map();
  for (const article of articles) {
    const original = article.querySelector;
    article.querySelector = (selector) => {
      if (selector.includes("/status/")) reads.set(article, (reads.get(article) ?? 0) + 1);
      return original(selector);
    };
  }
  const target = articles[31];
  tab.lifecycle.mutation([{ target, addedNodes: [] }]);
  tab.lifecycle.frame();
  assert.equal(reads.get(target), 1);
  assert.equal([...reads.values()].reduce((sum, count) => sum + count, 0), 1);
});

test("word-count saves do not rerender every visible post, but an automatic tag does", async () => {
  const initial = legacy();
  initial.settings.autoThreshold = 99;
  const env = environment(initial);
  const tab = content(env);
  await env.settle();
  const articles = Array.from({ length: 30 }, (_, index) => tab.addTweet(index + 1, "Python Django"));
  const { scope } = await env.request("get");
  let reads = 0;
  for (const article of articles) {
    const original = article.querySelector;
    article.querySelector = (selector) => {
      if (selector.includes("/status/")) reads++;
      return original(selector);
    };
  }
  await env.request("count", { scope, counts: { django: 1 } });
  await env.settle();
  assert.equal(reads, 0);

  const storedSettings = { ...env.stored.settings, autoThreshold: 1 };
  await env.chrome.storage.local.set({ settings: storedSettings });
  await env.request("count", { scope, counts: { django: 1 } });
  await env.settle();
  assert.ok(reads >= articles.length);
});

test("English function words are excluded without discarding meaningful short technology terms", async () => {
  const env = environment();
  const tab = content(env);
  await env.settle();
  tab.addTweet(1, "Python of at to in on by an is AI UI UX IT OS DB JS TS Go figma issue md plus");
  await tab.flush();
  const current = await env.request("get");
  for (const word of ["of", "at", "to", "in", "on", "by", "an", "is"]) {
    assert.equal(current.stats.wordCounts[word], undefined, word);
  }
  for (const word of ["ai", "ui", "ux", "it", "os", "db", "js", "ts", "go", "figma", "issue", "md", "plus"]) {
    assert.equal(current.stats.wordCounts[word], 1, word);
  }
  // 古いタブが機能語を送り続けても、保存・再昇格しない。
  await env.request("count", { scope: current.scope, counts: { OF: 99, at: 99, to: 99 } });
  const after = await env.request("get");
  assert.deepEqual(after.stats.wordCounts, current.stats.wordCounts);
  assert.deepEqual(after.stats.autoKeywords, []);
});

test("existing stopword counts and automatic tags are cleaned without resetting useful data", async () => {
  const initial = legacy();
  initial.tagSets[0].keywords.push(...tags("of"));
  const env = environment(initial);
  const current = await env.request("get");
  await env.chrome.storage.local.set({ [`statistics:${current.scope.setId}`]: {
    ...current.stats,
    wordCounts: { of: 12, at: 3, to: 2, ai: 4, ui: 3, it: 2, figma: 2 },
    autoKeywords: ["of", "ai"],
  } });
  const cleaned = await env.request("get");
  assert.deepEqual(cleaned.stats.wordCounts, { ai: 4, ui: 3, it: 2, figma: 2 });
  assert.deepEqual(cleaned.stats.autoKeywords, ["ai"]);
  assert.deepEqual(cleaned.scope, current.scope);
  assert.deepEqual(cleaned.stats.ignoredWords, current.stats.ignoredWords);
  assert.ok(cleaned.config.keywords.some((tag) => tag.label === "of"));
});

test("noise classification receives tag context and constrained candidates in fresh sessions", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { figma: 1, issue: 1, md: 1, plus: 1 } });
  const prompts = [];
  const ui = popup(env, async (input, options) => {
    prompts.push({ input: JSON.parse(input), schema: clone(options.responseConstraint) });
    return '{"noise":[]}';
  });
  await env.settle();
  await vm.runInContext('getAiSession($("ai-status"))', ui.context); // 同義語生成用の履歴とは分離
  await ui.elements["ai-clean"].fire();
  await ui.elements["ai-clean"].fire();
  assert.equal(ui.ai.created.length, 3);
  assert.deepEqual(ui.ai.destroyed, ui.ai.created.slice(1).map(({ session }) => session));
  assert.equal(ui.ai.created[1].options.initialPrompts[0].role, "system");
  assert.deepEqual(prompts[0].input.tags, [{ label: "Python", words: ["Python"] }]);
  assert.deepEqual(prompts[0].input.candidates, [
    { word: "figma", count: 1 }, { word: "issue", count: 1 },
    { word: "md", count: 1 }, { word: "plus", count: 1 },
  ]);
  assert.deepEqual(prompts[0].schema.properties.noise.items.enum, ["figma", "issue", "md", "plus"]);
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
});
