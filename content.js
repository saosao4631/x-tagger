// X Tagger - content script
// x.com のタイムラインを監視して以下を行う:
//   1. Promoted(広告)ツイートの非表示
//   2. 登録キーワードにマッチしたツイートへのタグチップ表示 + ハイライト
//   3. 頻出単語の集計と、しきい値超えの単語の自動タグ化

const DEFAULTS = {
  // タグ: { label: 表示名, words: [同義語(labelを含む)], excludes: [除外語] }
  keywords: [],
  autoKeywords: [],    // 頻出により自動昇格した単語(プレーン文字列)
  ignoredWords: [],    // 自動昇格させたくない単語
  wordCounts: {},      // 単語 -> 出現回数
  settings: {
    hidePromoted: true,
    autoEnabled: true,
    autoThreshold: 20, // この回数以上出現したら自動タグ化
    filterMode: false, // ホームTLでタグに一致しないツイートを非表示にする
  },
};

const AUTO_KEYWORD_MAX = 20; // 自動タグの上限
const WORD_COUNT_MAX = 500;  // 保存する単語数の上限(多い順に残す)
const FLUSH_INTERVAL_MS = 15000;

const state = structuredClone(DEFAULTS);
let dirty = false;

// ---------------------------------------------------------------- 単語分割

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

const STOPWORDS = new Set([
  // 日本語の機能語・頻出だが意味の薄い語
  "する", "した", "して", "います", "いる", "ある", "あり", "ない", "なく",
  "なる", "なり", "なった", "できる", "でき", "です", "ます", "ました",
  "これ", "それ", "あれ", "どれ", "ここ", "そこ", "どこ", "こちら",
  "こと", "もの", "ため", "よう", "さん", "ちゃん", "くん", "たち",
  "から", "まで", "など", "って", "という", "けど", "だけ", "とか",
  "ので", "でも", "そして", "しかし", "やっぱり", "ほんと", "本当",
  "今日", "明日", "昨日", "自分", "感じ", "気持ち", "みたい", "思う",
  "思い", "見て", "見た", "行く", "行った", "来た", "言う", "言って",
  // 英語
  "the", "and", "for", "you", "this", "that", "with", "are", "was",
  "not", "have", "has", "just", "like", "will", "can", "all", "get",
  // URL断片など
  "https", "http", "www", "com", "co", "jp", "amp",
]);

function normalize(s) {
  return s.normalize("NFKC").toLowerCase().trim();
}

// 旧形式(文字列の配列)のタグをオブジェクト形式に変換する
function migrateTags(keywords) {
  return (keywords ?? []).map((k) =>
    typeof k === "string" ? { label: k, words: [k], excludes: [] } : k
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 単語 → 判定用正規表現。英数字のみの単語は先頭だけ \b を付けた前方一致にする。
// 「run」で running / runner にもヒットし、「cpython」のような
// 別単語の途中にはヒットしない。catch のような不要ヒットは
// ユーザーが除外語に追加して弾く運用。
// 日本語は分かち書きがなく \b が機能しないため部分一致のまま
function wordPattern(w) {
  const nw = normalize(w);
  if (!nw) return null;
  const esc = escapeRegex(nw);
  return /^\w+$/.test(nw) ? new RegExp(`\\b${esc}`) : new RegExp(esc);
}

// タグ・自動タグの正規表現はツイートごとに作らず、設定変更時に一括コンパイル
let compiledTags = [];
let compiledAuto = [];

function compileMatchers() {
  compiledTags = state.keywords.map((tag) => ({
    label: tag.label,
    includes: (tag.words ?? []).map(wordPattern).filter(Boolean),
    excludes: (tag.excludes ?? [])
      .map((w) => {
        const nw = normalize(w);
        return nw ? new RegExp(escapeRegex(nw), "g") : null;
      })
      .filter(Boolean),
  }));
  compiledAuto = state.autoKeywords
    .map((w) => ({ word: w, re: wordPattern(w) }))
    .filter((a) => a.re);
}

// タグがテキストにマッチするか。除外語を先にテキストから取り除いてから
// 同義語を判定するので、「猫」タグ + 除外語「猫背」なら
// 「猫背」しか含まないツイートにはヒットしない
function tagMatches(compiled, normalizedText) {
  let t = normalizedText;
  for (const ex of compiled.excludes) t = t.replace(ex, " ");
  return compiled.includes.some((re) => re.test(t));
}

// タグに属する全単語(表示名 + 同義語)の正規化済みセット
function allTagWords() {
  const set = new Set();
  for (const tag of state.keywords) {
    set.add(normalize(tag.label));
    for (const w of tag.words ?? []) set.add(normalize(w));
  }
  return set;
}

function countWords(rawText) {
  const text = rawText
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\w_]+/g, " ");
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue;
    const w = normalize(segment);
    if (w.length < 2) continue;
    if (/^[\d\s\p{P}]+$/u.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    // 名詞だけを数えたい。形態素解析なしで品詞は分からないが、
    // 日本語の動詞・形容詞・助詞はほぼ必ずひらがなを含むため、
    // ひらがなを含む語を除外すると残りはほぼ名詞になる
    // (漢字・カタカナ・英数字のみの語だけを集計する)
    if (/[぀-ゟ]/.test(w)) continue;
    state.wordCounts[w] = (state.wordCounts[w] || 0) + 1;
    dirty = true;
  }
}

// ------------------------------------------------------- 集計の保存と自動昇格

// 拡張機能の更新・再読み込み後、ページに残った古いスクリプトが
// chrome.* APIを呼ぶと "Extension context invalidated" になる。
// 検知したら監視とタイマーを止めて静かに引退する
function extensionAlive() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

function shutdown() {
  observer.disconnect();
  clearInterval(flushTimer);
}

function flushCounts() {
  if (!extensionAlive()) {
    shutdown();
    return;
  }
  if (!dirty) return;
  dirty = false;

  // 上限を超えたら出現回数の多い順に切り詰める
  const entries = Object.entries(state.wordCounts);
  if (entries.length > WORD_COUNT_MAX) {
    entries.sort((a, b) => b[1] - a[1]);
    state.wordCounts = Object.fromEntries(entries.slice(0, WORD_COUNT_MAX));
  }

  if (state.settings.autoEnabled) {
    promoteFrequentWords();
    compileMatchers();
  }

  try {
    chrome.storage.local.set({
      wordCounts: state.wordCounts,
      autoKeywords: state.autoKeywords,
    });
  } catch {
    shutdown();
  }
}

function promoteFrequentWords() {
  const existing = allTagWords();
  for (const w of [...state.autoKeywords, ...state.ignoredWords]) {
    existing.add(normalize(w));
  }
  const candidates = Object.entries(state.wordCounts)
    .filter(([w, c]) => c >= state.settings.autoThreshold && !existing.has(w))
    .sort((a, b) => b[1] - a[1]);

  for (const [word] of candidates) {
    if (state.autoKeywords.length >= AUTO_KEYWORD_MAX) break;
    state.autoKeywords.push(word);
  }
}

const flushTimer = setInterval(flushCounts, FLUSH_INTERVAL_MS);

// ------------------------------------------------------------ ツイート処理

// 単語カウント済みツイートのID。仮想スクロールで同じツイートが再描画されても
// 二重カウントしないためのセット(セッション内のみ有効)
const countedTweetIds = new Set();
const COUNTED_IDS_MAX = 5000;

function isHomeTimeline() {
  return location.pathname === "/home" || location.pathname === "/";
}

// Xの広告ラベルは表記ゆれがある(日本語UI/英語UI・時期によって変わる)
const AD_LABELS = new Set(["プロモーション", "promoted", "ad", "広告"]);

function isPromoted(article) {
  // 広告ツイートは placementTracking でラップされることが多い
  if (article.closest('[data-testid="placementTracking"]')) return true;
  if (article.querySelector('[data-testid="placementTracking"]')) return true;
  // フォールバック: 表示テキストで判定(入れ子でない末端のspanのみ見る)
  for (const span of article.querySelectorAll("span")) {
    if (span.childElementCount > 0) continue;
    if (AD_LABELS.has(span.textContent.trim().toLowerCase())) return true;
  }
  return false;
}

function makeChip(label, kind) {
  const chip = document.createElement("span");
  chip.className = `xt-chip xt-chip-${kind}`;
  chip.textContent = label;
  return chip;
}

function processTweet(article) {
  // 仮想スクロールでDOMノードが使い回されるため、ツイートの固有URLで
  // 「同じノードだが中身が変わった」ケースを検出して再処理する
  const link =
    article.querySelector('a[href*="/status/"] time')?.closest("a")?.href ?? "";
  if (article.dataset.xtDone === "1" && article.dataset.xtId === link) return;
  article.dataset.xtDone = "1";
  article.dataset.xtId = link;

  // 前回処理の痕跡を掃除
  article.querySelectorAll(".xt-chips").forEach((el) => el.remove());
  article.classList.remove("xt-hit");
  const cell = article.closest('[data-testid="cellInnerDiv"]');
  if (cell) cell.classList.remove("xt-hidden");

  if (state.settings.hidePromoted && isPromoted(article)) {
    (cell ?? article).classList.add("xt-hidden");
    return;
  }

  // 本文テキストがないツイート(画像・動画のみ等)も rawText="" として
  // 処理を続ける。フィルタモードで取りこぼさないため
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const rawText = textEl ? textEl.innerText : "";
  const text = normalize(rawText);

  // 単語集計はツイートIDごとに1回だけ(再描画・スクロール往復で重複させない)
  if (rawText && link && !countedTweetIds.has(link)) {
    countedTweetIds.add(link);
    if (countedTweetIds.size > COUNTED_IDS_MAX) countedTweetIds.clear();
    countWords(rawText);
  }

  // 同義語のどれにヒットしてもチップはタグの表示名1つだけ
  const hitTags = compiledTags.filter((tag) => tagMatches(tag, text));
  const tagWords = allTagWords();
  const autoHits = compiledAuto
    .filter((a) => !tagWords.has(normalize(a.word)) && a.re.test(text))
    .map((a) => a.word);

  // フィルタモード: ホームTLでどのタグにもヒットしないツイートを隠す
  // (プロフィールや詳細ページまで隠すと使いものにならないのでTL限定)
  if (
    state.settings.filterMode &&
    isHomeTimeline() &&
    hitTags.length === 0 &&
    autoHits.length === 0
  ) {
    (cell ?? article).classList.add("xt-hidden");
    return;
  }

  if (hitTags.length > 0 || autoHits.length > 0) {
    const bar = document.createElement("div");
    bar.className = "xt-chips";
    hitTags.forEach((tag) => bar.appendChild(makeChip(tag.label, "user")));
    autoHits.forEach((k) => bar.appendChild(makeChip(k, "auto")));
    textEl.parentElement.insertBefore(bar, textEl);
    if (hitTags.length > 0) article.classList.add("xt-hit");
  }
}

function scan(root) {
  const articles =
    root instanceof Element || root instanceof Document
      ? root.querySelectorAll('article[data-testid="tweet"]')
      : [];
  articles.forEach(processTweet);
}

function reprocessAll() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
    delete a.dataset.xtDone;
  });
  scan(document);
}

// ------------------------------------------------------------------- 監視

let scheduled = false;
const observer = new MutationObserver(() => {
  // 変更が連発するのでフレーム単位でまとめて処理
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    scan(document);
  });
});

// --------------------------------------------------------------------- 起動

chrome.storage.local.get(DEFAULTS, (stored) => {
  Object.assign(state, stored);
  state.keywords = migrateTags(stored.keywords);
  state.settings = { ...DEFAULTS.settings, ...stored.settings };
  compileMatchers();
  scan(document);
  observer.observe(document.body, { childList: true, subtree: true });
});

// ポップアップで設定が変わったら即反映
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let needsReprocess = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key === "wordCounts") continue; // 自分で書いた集計のエコーは無視
    state[key] = newValue ?? structuredClone(DEFAULTS[key]);
    if (key === "keywords") state.keywords = migrateTags(state.keywords);
    if (key === "settings") state.settings = { ...DEFAULTS.settings, ...state.settings };
    if (["keywords", "autoKeywords", "settings", "ignoredWords"].includes(key)) {
      needsReprocess = true;
    }
  }
  if (needsReprocess) {
    compileMatchers();
    reprocessAll();
  }
});
