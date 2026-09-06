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
      onChanged: { addListener(callback) { listeners.push(callback); } },
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
  for (const match of source("popup.html").matchAll(/<([a-z0-9]+)[^>]*\bid="([^"]+)"/g)) {
    elements[match[2]] = document.appendChild(new Element(match[1]));
  }
  document.getElementById = (id) => elements[id];
  const context = env.context({ document, setTimeout, clearTimeout, confirm: () => true,
    LanguageModel: { availability: async () => "available", create: async () => ({ prompt }) },
  });
  vm.runInContext(source("popup.js"), context);
  return { context, elements };
}

function content(env) {
  const document = new Document();
  const context = env.context({
    document, Element, Document, location: { pathname: "/home" }, Intl,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame() {}, setInterval() { return 1; }, clearInterval() {},
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
  return { context, document, addTweet, flush };
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

test("AI cleanup previews unselected candidates, cancel writes nothing, applies only selected words", async () => {
  const env = environment();
  const { scope } = await env.request("get");
  await env.request("count", { scope, counts: { django: 1, flask: 1 } });
  const ui = popup(env);
  await env.settle();
  await ui.elements["ai-clean"].fire();
  const candidates = ui.elements["ai-noise-words"].children;
  assert.deepEqual(candidates.map((chip) => chip.dataset.word), ["django", "flask"]);
  assert.ok(candidates.every((chip) => !chip.classList.contains("selected")));
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
  await ui.elements["ai-noise-apply"].fire();
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
  await ui.elements["ai-noise-cancel"].fire();
  assert.equal(ui.elements["ai-noise-candidates"].style.display, "none");
  await ui.elements["ai-clean"].fire();
  await ui.elements["ai-noise-words"].children[0].fire();
  await ui.elements["ai-noise-apply"].fire();
  await env.settle();
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise", "django"]);
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
  assert.equal(ui.elements["ai-noise-candidates"].style.display, "none");
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
  await env.switchSet("仕事");
  const second = ui.elements["ai-clean"].fire();
  await env.settle();
  await ui.elements["reset-counts"].fire();
  await env.settle();
  finish('{"noise":["django"]}');
  await second;
  assert.equal(ui.elements["ai-noise-candidates"].style.display, "none");
  assert.deepEqual((await env.request("get")).stats.wordCounts, {});
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
  assert.equal(ui.elements["ai-noise-candidates"].style.display, "none");
  assert.deepEqual((await env.request("get")).stats.ignoredWords, ["noise"]);
});
