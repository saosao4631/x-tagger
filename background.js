importScripts("statistics.js");

const Stats = XTaggerStatistics;
const WORD_COUNT_MAX = 500;
const AUTO_KEYWORD_MAX = 20;

function emptyStatistics(set, ignoredWords = []) {
  return {
    signature: Stats.signature(set.keywords), revision: crypto.randomUUID(),
    wordCounts: {}, autoKeywords: [], ignoredWords,
  };
}

async function readConfig() {
  const config = await chrome.storage.local.get(Stats.defaults);
  config.settings = { ...Stats.defaults.settings, ...config.settings };
  if (config.statisticsVersion !== 1) {
    // 旧集計は投稿・セットの出所が不明なので新形式へ引き継がない。
    // ユーザーが指定したタグと除外済み語は保つ。旧データ自体も残す。
    const legacy = await chrome.storage.local.get({ ignoredWords: [] });
    if (!config.tagSets.length) {
      config.tagSets = [{ name: "セット1", keywords: config.keywords }];
      config.activeSet = "セット1";
    }
    config.tagSets = config.tagSets.map((set) => ({
      ...set, id: crypto.randomUUID(), keywords: Stats.migrateTags(set.keywords),
    }));
    const active = config.tagSets.find((set) => set.name === config.activeSet) ?? config.tagSets[0];
    config.activeSet = active.name;
    config.keywords = active.keywords;
    config.statisticsVersion = 1;
    const patch = { ...config };
    for (const set of config.tagSets) {
      patch[Stats.key(set.id)] = emptyStatistics(set, [...legacy.ignoredWords]);
    }
    await chrome.storage.local.set(patch);
  }
  return config;
}

async function getStatistics(set) {
  const key = Stats.key(set.id);
  let stats = (await chrome.storage.local.get(key))[key];
  if (!stats || stats.signature !== Stats.signature(set.keywords)) {
    stats = emptyStatistics(set, stats?.ignoredWords ?? []);
    await chrome.storage.local.set({ [key]: stats });
  }
  return stats;
}

function promote(stats, set, settings) {
  if (!settings.autoEnabled) return;
  const known = new Set([
    ...set.keywords.flatMap((tag) => [tag.label, ...(tag.words ?? [])]),
    ...stats.autoKeywords, ...stats.ignoredWords,
  ].map(Stats.normalize));
  const candidates = Object.entries(stats.wordCounts)
    .filter(([word, count]) => count >= settings.autoThreshold && !known.has(word))
    .sort((a, b) => b[1] - a[1]);
  for (const [word] of candidates) {
    if (stats.autoKeywords.length >= AUTO_KEYWORD_MAX) break;
    stats.autoKeywords.push(word);
  }
}

async function handle(message) {
  const config = await readConfig();
  if (message.type === "statistics:get") {
    const set = config.tagSets.find((item) => item.name === config.activeSet);
    const stats = await getStatistics(set);
    return { config, stats, scope: { setId: set.id, signature: stats.signature, revision: stats.revision } };
  }

  const scope = message.scope;
  const set = config.tagSets.find((item) => item.id === scope?.setId);
  if (!set || Stats.signature(set.keywords) !== scope.signature) return { stale: true };
  const key = Stats.key(set.id);
  const stats = (await chrome.storage.local.get(key))[key];
  // リセット前・タグ編集前のタブから届いた保存は受け付けない。
  if (!stats || stats.revision !== scope.revision || stats.signature !== scope.signature) {
    return { stale: true };
  }
  if (message.type === "statistics:count") {
    for (const [word, count] of Object.entries(message.counts ?? {})) {
      if (!Number.isSafeInteger(count) || count <= 0 || word.length < 2 ||
          /[\p{Extended_Pictographic}\p{S}\uFE0F\u200D]/u.test(word)) continue;
      const previous = Object.hasOwn(stats.wordCounts, word) ? stats.wordCounts[word] : 0;
      Object.defineProperty(stats.wordCounts, word, {
        value: previous + count, enumerable: true, configurable: true, writable: true,
      });
    }
    stats.wordCounts = Object.fromEntries(Object.entries(stats.wordCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, WORD_COUNT_MAX));
    promote(stats, set, config.settings);
  } else if (message.type === "statistics:reset") {
    await chrome.storage.local.set({ [key]: emptyStatistics(set, stats.ignoredWords) });
    return {};
  } else if (message.type === "statistics:ignore") {
    const words = (message.words ?? []).filter((word) =>
      Object.hasOwn(stats.wordCounts, word) || stats.autoKeywords.includes(word));
    stats.ignoredWords = [...new Set([...stats.ignoredWords, ...words])];
    stats.autoKeywords = stats.autoKeywords.filter((word) => !stats.ignoredWords.includes(word));
  } else {
    throw new Error("未対応の集計操作です");
  }
  await chrome.storage.local.set({ [key]: stats });
  return {};
}

// 複数タブの加算・リセット・除外を同じ順番で処理し、上書きを防ぐ。
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message?.type?.startsWith("statistics:")) return;
  queue = queue.then(() => handle(message)).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message }),
  );
  return true;
});
