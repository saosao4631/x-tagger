// ポップアップ・コンテンツ・バックグラウンドで共有する集計の形式。
const XTaggerStatistics = (() => {
  const defaults = {
    keywords: [], tagSets: [], activeSet: "", statisticsVersion: 0,
    settings: { hidePromoted: true, autoEnabled: true, autoThreshold: 20, filterMode: false },
  };
  const normalize = (word) => word.normalize("NFKC").toLowerCase().trim();
  const migrateTags = (tags) => (tags ?? []).map((tag) =>
    typeof tag === "string" ? { label: tag, words: [tag], excludes: [] } : tag
  );
  function signature(tags) {
    const words = (items) => [...new Set((items ?? []).map(normalize))].sort();
    return JSON.stringify(migrateTags(tags).map((tag) =>
      JSON.stringify([words(tag.words), words(tag.excludes)])
    ).sort());
  }
  const key = (setId) => `statistics:${setId}`;
  const sameScope = (a, b) => !!a && !!b &&
    a.setId === b.setId && a.revision === b.revision && a.signature === b.signature;
  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type: `statistics:${type}`, ...payload });
    if (!result?.ok) throw new Error(result?.error ?? "集計データを読み書きできませんでした");
    return result;
  }
  return { defaults, normalize, migrateTags, signature, key, sameScope, request };
})();
