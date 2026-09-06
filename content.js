// X Tagger - content script
// x.com のタイムラインを監視して以下を行う:
//   1. Promoted(広告)ツイートの非表示
//   2. 登録キーワードにマッチしたツイートへのタグチップ表示 + ハイライト
//   3. 頻出単語の集計と、しきい値超えの単語の自動タグ化

const DEFAULTS = {
  ...XTaggerStatistics.defaults,
  autoKeywords: [],
};

const FLUSH_INTERVAL_MS = 15000;

const state = structuredClone(DEFAULTS);
let statisticsScope = null;
let pendingCounts = Object.create(null);
let ready = false;
let refreshSerial = 0;
let stopped = false;

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
    // 絵文字・記号を含む語は除外(絵文字はUTF-16で2文字扱いになり
    // 長さフィルタをすり抜けるため、明示的に弾く)
    if (/[\p{Extended_Pictographic}\p{S}\uFE0F\u200D]/u.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    // 名詞だけを数えたい。形態素解析なしで品詞は分からないが、
    // 日本語の動詞・形容詞・助詞はほぼ必ずひらがなを含むため、
    // ひらがなを含む語を除外すると残りはほぼ名詞になる
    // (漢字・カタカナ・英数字のみの語だけを集計する)
    if (/[぀-ゟ]/.test(w)) continue;
    pendingCounts[w] = (pendingCounts[w] || 0) + 1;
  }
}

// ------------------------------------------------------- 集計の保存と自動昇格

// 拡張機能の更新・再読み込み後、ページに残った古いスクリプトが
// chrome.* APIを呼ぶと "Extension context invalidated" になる。
// 検知したら監視とタイマーを止めて静かに引退する
function extensionAlive() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    // 更新直後はAPI自体へのアクセスが例外になることもある。
    return false;
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  ready = false;
  refreshSerial++; // 通信待ちの処理が戻っても再開させない
  pendingCounts = Object.create(null);
  observer.disconnect();
  clearInterval(flushTimer);
  if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
  scheduledFrame = null;
  try {
    chrome.storage.onChanged.removeListener(onStorageChanged);
  } catch {
    // コンテキスト無効化後はリスナー解除もできないため、停止フラグで遮断する。
  }
}

function stopIfInvalidated(error) {
  if (stopped) return true;
  if (!extensionAlive() || /Extension context invalidated/i.test(error?.message ?? "")) {
    shutdown();
    return true;
  }
  return false;
}

async function flushCounts() {
  if (stopIfInvalidated()) return;
  if (!statisticsScope || Object.keys(pendingCounts).length === 0) return;
  const scope = statisticsScope;
  const counts = pendingCounts;
  pendingCounts = Object.create(null);
  try {
    await XTaggerStatistics.request("count", { scope, counts });
    stopIfInvalidated();
  } catch (error) {
    if (stopIfInvalidated(error)) return;
    if (XTaggerStatistics.sameScope(scope, statisticsScope)) {
      for (const [word, count] of Object.entries(counts)) {
        pendingCounts[word] = (pendingCounts[word] || 0) + count;
      }
    }
  }
}

const flushTimer = setInterval(() => {
  if (stopIfInvalidated()) return;
  if (ready) flushCounts();
  else refreshState();
}, FLUSH_INTERVAL_MS);

// ------------------------------------------------------------ ツイート処理

// 単語カウント済みツイートのID。仮想スクロールで同じツイートが再描画されても
// 二重カウントしないためのセット(セッション内のみ有効)
let countedTweetIds = new Set();
const countedByScope = new Map();
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
  if (!ready || stopIfInvalidated()) return;
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
  (cell ?? article).classList.remove("xt-hidden");

  if (state.settings.hidePromoted && isPromoted(article)) {
    (cell ?? article).classList.add("xt-hidden");
    return;
  }

  // 本文テキストがないツイート(画像・動画のみ等)も rawText="" として
  // 処理を続ける。フィルタモードで取りこぼさないため
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const rawText = textEl ? textEl.innerText : "";
  const text = normalize(rawText);

  // 同義語のどれにヒットしてもチップはタグの表示名1つだけ
  const hitTags = compiledTags.filter((tag) => tagMatches(tag, text));
  const tagWords = allTagWords();
  const autoHits = compiledAuto
    .filter((a) => !tagWords.has(normalize(a.word)) && a.re.test(text))
    .map((a) => a.word);
  const matchesTopic = hitTags.length > 0 || autoHits.length > 0;

  // フィルタモード: ホームTLでどのタグにもヒットしないツイートを隠す
  // (プロフィールや詳細ページまで隠すと使いものにならないのでTL限定)
  if (
    state.settings.filterMode &&
    isHomeTimeline() &&
    !matchesTopic
  ) {
    (cell ?? article).classList.add("xt-hidden");
    return;
  }

  // 登録タグ・自動タグのどちらにヒットした投稿も集計する。
  // 例: Python関連でDjangoが昇格したら、Pythonを含まないDjango投稿からも
  // 次の関連語を見つける。どちらにも一致しない投稿は集計しない。
  // ツイートIDごとに1回だけ数える(再描画・スクロール往復で重複させない)
  if (matchesTopic && rawText && link && !countedTweetIds.has(link)) {
    countedTweetIds.add(link);
    if (countedTweetIds.size > COUNTED_IDS_MAX) {
      countedTweetIds.delete(countedTweetIds.values().next().value);
    }
    countWords(rawText);
  }

  if (matchesTopic) {
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
  // 新しく登録・昇格した語は、フィルタで隠していた投稿も含めて再判定する。
  document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
    delete a.dataset.xtDone;
  });
  scan(document);
}

// ------------------------------------------------------------------- 監視

let scheduledFrame = null;
const observer = new MutationObserver(() => {
  // 変更が連発するのでフレーム単位でまとめて処理
  if (stopIfInvalidated() || scheduledFrame !== null) return;
  scheduledFrame = requestAnimationFrame(() => {
    scheduledFrame = null;
    if (stopIfInvalidated()) return;
    scan(document);
  });
});

// --------------------------------------------------------------------- 起動

async function refreshState() {
  if (stopIfInvalidated()) return;
  const serial = ++refreshSerial;
  ready = false;
  try {
    await flushCounts();
    if (stopIfInvalidated() || serial !== refreshSerial) return;
    const snapshot = await XTaggerStatistics.request("get");
    if (stopIfInvalidated() || serial !== refreshSerial) return;
    const previous = statisticsScope;
    statisticsScope = snapshot.scope;
    if (!XTaggerStatistics.sameScope(previous, statisticsScope)) {
      const key = `${statisticsScope.setId}:${statisticsScope.revision}`;
      // リセット直後は処理済み投稿を数え直さず、新しい投稿から再開する。
      const wasReset = previous?.setId === statisticsScope.setId &&
        previous.signature === statisticsScope.signature;
      countedTweetIds = countedByScope.get(key) ?? new Set(wasReset ? countedTweetIds : []);
      countedByScope.set(key, countedTweetIds);
      if (countedByScope.size > 50) countedByScope.delete(countedByScope.keys().next().value);
      pendingCounts = Object.create(null);
    }
    Object.assign(state, snapshot.config, snapshot.stats);
    state.keywords = migrateTags(state.keywords);
    compileMatchers();
    ready = true;
    reprocessAll();
  } catch (error) {
    if (!stopIfInvalidated(error)) console.warn("X Tagger: 集計の読み込みに失敗しました", error);
  }
}

// ポップアップで設定が変わったら即反映
function onStorageChanged(changes, area) {
  if (stopIfInvalidated() || area !== "local") return;
  if (Object.keys(changes).some((key) =>
    ["keywords", "tagSets", "activeSet", "settings", "statisticsVersion"].includes(key) ||
    key === XTaggerStatistics.key(statisticsScope?.setId))) {
    refreshState();
  }
}

if (!stopIfInvalidated()) {
  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
    observer.observe(document.body, { childList: true, subtree: true });
    refreshState();
  } catch (error) {
    if (!stopIfInvalidated(error)) console.warn("X Tagger: 起動に失敗しました", error);
  }
}
