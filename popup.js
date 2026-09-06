// X Tagger - 設定ポップアップ
// タグは { label: 表示名, words: [同義語(labelを含む)], excludes: [除外語] }。
// チップをクリックすると同義語・除外語を編集できる。

const DEFAULTS = {
  ...XTaggerStatistics.defaults,
  autoKeywords: [],
  ignoredWords: [],
  wordCounts: {},
};

const FREQ_DISPLAY_MAX = 15;

let data = structuredClone(DEFAULTS);
let editingIndex = null; // 編集中のタグの index。null なら編集パネル非表示
let statisticsScope = null;
let refreshSerial = 0;
let noiseRequest = 0;
let suggestionRequest = 0;
let initialized = false;

const $ = (id) => document.getElementById(id);
document.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });

function save(keys) {
  const patch = {};
  for (const k of keys) patch[k] = data[k];
  return chrome.storage.local.set(patch).then(refreshPopup).catch(showStorageError);
}

// タグの変更は必ずアクティブセットにも書き戻す(保存し忘れ防止)
function saveKeywords() {
  cancelNoiseRequest();
  const set = data.tagSets.find((s) => s.name === data.activeSet);
  if (set) set.keywords = data.keywords;
  save(["keywords", "tagSets"]);
}

function switchSet(name) {
  const set = data.tagSets.find((s) => s.name === name);
  if (!set) return;
  cancelNoiseRequest();
  data.activeSet = name;
  data.keywords = structuredClone(set.keywords);
  save(["keywords", "activeSet"]);
  closeEditor();
}

function addSet(name) {
  if (!name || data.tagSets.some((s) => s.name === name)) return;
  cancelNoiseRequest();
  data.tagSets.push({ id: crypto.randomUUID(), name, keywords: [] });
  data.activeSet = name;
  data.keywords = [];
  save(["tagSets", "activeSet", "keywords"]);
  closeEditor();
}

function deleteSet(name) {
  const i = data.tagSets.findIndex((s) => s.name === name);
  if (i === -1) return;
  if (!confirm(`セット「${name}」を削除しますか?(中のタグも消えます)`)) return;
  cancelNoiseRequest();
  data.tagSets.splice(i, 1);
  if (data.tagSets.length === 0) {
    data.tagSets.push({ id: crypto.randomUUID(), name: "セット1", keywords: [] });
  }
  if (data.activeSet === name) {
    data.activeSet = data.tagSets[0].name;
    data.keywords = structuredClone(data.tagSets[0].keywords);
  }
  save(["tagSets", "activeSet", "keywords"]);
  closeEditor();
}

// セットのチップ。クリック=切り替え、ダブルクリック=名前のインライン編集。
// シングルクリックは少し待ってから実行し、ダブルクリックだったら取り消す
function makeSetChip(set) {
  const isActive = set.name === data.activeSet;
  const chip = document.createElement("span");
  chip.className = "chip " + (isActive ? "chip-set-active" : "chip-set");

  const label = document.createElement("span");
  label.textContent = `${set.name} (${set.keywords.length})`;
  label.style.cursor = "pointer";
  label.title = "クリックで切り替え / ダブルクリックで名前変更";

  let clickTimer = null;
  label.addEventListener("click", () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (set.name !== data.activeSet) switchSet(set.name);
    }, 250);
  });
  label.addEventListener("dblclick", () => {
    clearTimeout(clickTimer);
    startRenameSet(chip, label, set);
  });

  const btn = document.createElement("button");
  btn.textContent = "×";
  btn.title = "削除";
  btn.addEventListener("click", () => deleteSet(set.name));

  chip.append(label, btn);
  return chip;
}

function startRenameSet(chip, label, set) {
  const input = document.createElement("input");
  input.className = "set-rename";
  input.value = set.name;
  chip.replaceChild(input, label);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    const valid =
      newName &&
      newName !== set.name &&
      !data.tagSets.some((s) => s.name === newName);
    if (valid) {
      if (data.activeSet === set.name) data.activeSet = newName;
      set.name = newName;
      save(["tagSets", "activeSet"]);
    }
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      done = true;
      render();
    }
  });
  input.addEventListener("blur", commit);
}

function splitWords(value) {
  return value
    .split(/[,、，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeChip(word, kind, { onRemove, onClick, active } = {}) {
  const chip = document.createElement("span");
  chip.className = `chip chip-${kind}` + (active ? " chip-active" : "");
  const labelSpan = document.createElement("span");
  labelSpan.textContent = word;
  if (onClick) {
    labelSpan.style.cursor = "pointer";
    labelSpan.title = "クリックで同義語・除外語を編集";
    labelSpan.addEventListener("click", onClick);
  }
  chip.appendChild(labelSpan);
  if (onRemove) {
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "削除";
    btn.addEventListener("click", onRemove);
    chip.appendChild(btn);
  }
  return chip;
}

// ------------------------------------------------------------ タグ編集パネル

function openEditor(index) {
  suggestionRequest++;
  editingIndex = index;
  const tag = data.keywords[index];
  $("edit-label").value = tag.label;
  $("edit-words").value = (tag.words ?? [])
    .filter((w) => w !== tag.label)
    .join(", ");
  $("edit-excludes").value = (tag.excludes ?? []).join(", ");
  $("ai-candidates").style.display = "none";
  $("ai-status").textContent = "";
  $("editor").style.display = "block";
  render();
}

function closeEditor() {
  suggestionRequest++;
  editingIndex = null;
  $("editor").style.display = "none";
  render();
}

$("edit-save").addEventListener("click", () => {
  if (editingIndex === null) return;
  const label = $("edit-label").value.trim();
  if (!label) return;
  const synonyms = splitWords($("edit-words").value);
  data.keywords[editingIndex] = {
    label,
    // 表示名自体も判定対象に含める(重複は除去)
    words: [...new Set([label, ...synonyms])],
    excludes: splitWords($("edit-excludes").value),
  };
  saveKeywords();
  closeEditor();
});

$("edit-cancel").addEventListener("click", closeEditor);

// タグ・除外済みの語を除いた頻出単語の上位リスト
function topFreqWords() {
  const known = new Set([...data.autoKeywords, ...data.ignoredWords].map(XTaggerStatistics.normalize));
  for (const tag of data.keywords) {
    known.add(XTaggerStatistics.normalize(tag.label));
    for (const w of tag.words ?? []) known.add(XTaggerStatistics.normalize(w));
  }
  return Object.entries(data.wordCounts)
    .filter(([w]) => !known.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, FREQ_DISPLAY_MAX);
}

// ------------------------------------------------------------------- 描画

function render() {
  // タグセット(アクティブなものは青塗り)
  const setsBox = $("sets");
  setsBox.textContent = "";
  data.tagSets.forEach((set) => setsBox.appendChild(makeSetChip(set)));

  // ユーザータグ
  const kwBox = $("keywords");
  kwBox.textContent = "";
  if (data.keywords.length === 0) {
    kwBox.innerHTML = '<span class="empty">まだ登録されていません</span>';
  }
  data.keywords.forEach((tag, i) => {
    const extra =
      (tag.words?.length > 1 ? ` +${tag.words.length - 1}` : "") +
      (tag.excludes?.length ? " −" : "");
    kwBox.appendChild(
      makeChip(tag.label + extra, "user", {
        active: i === editingIndex,
        onClick: () => openEditor(i),
        onRemove: () => {
          data.keywords.splice(i, 1);
          saveKeywords();
          if (editingIndex === i) closeEditor();
          else render();
        },
      })
    );
  });

  // 自動タグ(削除すると ignoredWords に入り、再昇格しなくなる)
  const autoBox = $("auto-keywords");
  autoBox.textContent = "";
  if (data.autoKeywords.length === 0) {
    autoBox.innerHTML = '<span class="empty">まだありません</span>';
  }
  data.autoKeywords.forEach((word) => {
    autoBox.appendChild(
      makeChip(word, "auto", {
        onRemove: async () => {
          try {
            await XTaggerStatistics.request("ignore", { scope: statisticsScope, words: [word] });
            await refreshPopup();
          } catch (error) { showStorageError(error); }
        },
      })
    );
  });

  // 頻出単語ランキング
  const freqBox = $("freq");
  freqBox.textContent = "";
  const top = topFreqWords();

  if (top.length === 0) {
    freqBox.innerHTML =
      data.keywords.length || data.autoKeywords.length
        ? '<span class="empty">このセットの登録タグ・自動タグに一致した投稿から集計します</span>'
        : '<span class="empty">タグを登録すると、関連する投稿から集計が始まります</span>';
  }
  for (const [word, count] of top) {
    const row = document.createElement("div");
    row.className = "freq-row";
    const left = document.createElement("span");
    left.className = "freq-info";
    const w = document.createElement("span");
    w.className = "freq-word";
    w.textContent = word;
    const c = document.createElement("span");
    c.className = "freq-count";
    c.textContent = `${count}回`;
    left.append(w, c);
    const btn = document.createElement("button");
    btn.className = "freq-add";
    btn.textContent = "＋ タグに追加";
    btn.addEventListener("click", () => {
      data.keywords.push({ label: word, words: [word], excludes: [] });
      saveKeywords();
      render();
    });
    const scope = statisticsScope;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "freq-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "このセットの頻出単語・自動タグから除外";
    removeBtn.setAttribute("aria-label", `${word}を頻出単語から除外`);
    removeBtn.addEventListener("click", async () => {
      if (!XTaggerStatistics.sameScope(scope, statisticsScope)) return;
      removeBtn.disabled = true;
      btn.disabled = true;
      try {
        const result = await XTaggerStatistics.request("ignore", { scope, words: [word] });
        await refreshPopup();
        if (result.stale) showStorageError(new Error("集計が変更されました。もう一度除外してください"));
      } catch (error) { showStorageError(error); }
      finally { removeBtn.disabled = false; btn.disabled = false; }
    });
    left.appendChild(removeBtn);
    row.append(left, btn);
    freqBox.appendChild(row);
  }

  // 設定
  $("hide-promoted").checked = data.settings.hidePromoted;
  $("filter-mode").checked = data.settings.filterMode;
  $("auto-enabled").checked = data.settings.autoEnabled;
  $("auto-threshold").value = data.settings.autoThreshold;
}

function addKeyword() {
  const input = $("new-keyword");
  const word = input.value.trim();
  if (!word) return;
  if (!data.keywords.some((t) => t.label === word)) {
    data.keywords.push({ label: word, words: [word], excludes: [] });
    saveKeywords();
  }
  input.value = "";
  render();
}

function addSetFromInput() {
  const input = $("new-set");
  addSet(input.value.trim());
  input.value = "";
}

$("add-set-btn").addEventListener("click", addSetFromInput);
$("new-set").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSetFromInput();
});

$("add-btn").addEventListener("click", addKeyword);
$("new-keyword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addKeyword();
});

$("hide-promoted").addEventListener("change", (e) => {
  data.settings.hidePromoted = e.target.checked;
  save(["settings"]);
});
$("filter-mode").addEventListener("change", (e) => {
  data.settings.filterMode = e.target.checked;
  save(["settings"]);
});
$("auto-enabled").addEventListener("change", (e) => {
  data.settings.autoEnabled = e.target.checked;
  save(["settings"]);
});
$("auto-threshold").addEventListener("change", (e) => {
  const n = parseInt(e.target.value, 10);
  if (Number.isFinite(n) && n >= 2) {
    data.settings.autoThreshold = n;
    save(["settings"]);
  }
});

// ---------------- AI 機能(Chrome内蔵 Gemini Nano / Prompt API) ----------------
// Chrome 138+ で拡張機能から利用可能。APIキー不要・モデルDL後は外部通信なし。
// 対応していないマシンでは AI ボタンを非表示にし、他の機能には影響させない。

let aiSession = null;
// 利用可否の確認とセッション作成で、同じ入出力言語を指定する。
// 日本語の指示と、英語を含むタグ名・候補を扱う。
const AI_LANGUAGE_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja", "en"] }],
};

async function aiAvailability() {
  if (typeof LanguageModel === "undefined") return "unavailable";
  try {
    return await LanguageModel.availability(AI_LANGUAGE_OPTIONS);
  } catch {
    return "unavailable";
  }
}

async function getAiSession(statusEl) {
  if (aiSession) return aiSession;
  statusEl.textContent = "モデルを準備中...(初回は数GBのダウンロードが走ります)";
  const monitor = (m) => {
    m.addEventListener("downloadprogress", (e) => {
      statusEl.textContent = `モデルをダウンロード中... ${Math.round(e.loaded * 100)}%`;
    });
  };
  // 失敗時も言語指定を外して再試行せず、呼び出し元で理由を表示する。
  aiSession = await LanguageModel.create({ ...AI_LANGUAGE_OPTIONS, monitor });
  return aiSession;
}

function makeCandidateChip(word) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip chip-cand";
  chip.textContent = word;
  chip.dataset.word = word;
  chip.setAttribute("aria-pressed", "false");
  chip.addEventListener("click", () => {
    chip.setAttribute("aria-pressed", String(chip.classList.toggle("selected")));
  });
  return chip;
}

function renderAiCandidates(result, tag) {
  const existing = new Set(
    [tag.label, ...(tag.words ?? []), ...(tag.excludes ?? [])].map((w) =>
      w.toLowerCase()
    )
  );
  const clean = (list) =>
    [...new Set((list ?? []).map((w) => String(w).trim()).filter(Boolean))].filter(
      (w) => !existing.has(w.toLowerCase())
    );

  const synBox = $("ai-syn");
  const excBox = $("ai-exc");
  synBox.textContent = "";
  excBox.textContent = "";
  clean(result.synonyms).forEach((w) => synBox.appendChild(makeCandidateChip(w)));
  clean(result.excludes).forEach((w) => excBox.appendChild(makeCandidateChip(w)));
  if (!synBox.childElementCount) synBox.innerHTML = '<span class="empty">なし</span>';
  if (!excBox.childElementCount) excBox.innerHTML = '<span class="empty">なし</span>';
  $("ai-candidates").style.display = "block";
}

$("ai-suggest").addEventListener("click", async () => {
  if (editingIndex === null) return;
  const tag = data.keywords[editingIndex];
  const status = $("ai-status");
  const btn = $("ai-suggest");
  const request = ++suggestionRequest;
  btn.disabled = true;
  try {
    const session = await getAiSession(status);
    status.textContent = "候補を考え中...";
    const schema = {
      type: "object",
      properties: {
        synonyms: { type: "array", items: { type: "string" }, maxItems: 8 },
        excludes: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: ["synonyms", "excludes"],
    };
    const res = await session.prompt(
      `「${tag.label}」というキーワードでSNS投稿を検索する設定を作っています。\n` +
        `synonyms: 「${tag.label}」と同じ対象を指す表記ゆれ・略称・カタカナ/英語表記(最大8個)。\n` +
        `excludes: 「${tag.label}」という文字列を含むのに意味が違う語(誤ヒットの原因。例:「猫」に対する「猫背」。なければ空配列)。\n` +
        `JSONのみを出力してください。`,
      { responseConstraint: schema }
    );
    if (request !== suggestionRequest) return;
    renderAiCandidates(JSON.parse(res), tag);
    status.textContent = "使いたい候補をクリックして選び、「選んだ候補を反映」を押してください";
  } catch (e) {
    if (request === suggestionRequest) status.textContent = `AIエラー: ${e.message ?? e}`;
  } finally {
    btn.disabled = false;
  }
});

$("ai-apply").addEventListener("click", () => {
  const pick = (boxId) =>
    [...$(boxId).querySelectorAll(".chip-cand.selected")].map((c) => c.dataset.word);
  const appendTo = (inputId, words) => {
    if (words.length === 0) return;
    const cur = splitWords($(inputId).value);
    $(inputId).value = [...new Set([...cur, ...words])].join(", ");
  };
  appendTo("edit-words", pick("ai-syn"));
  appendTo("edit-excludes", pick("ai-exc"));
  $("ai-candidates").style.display = "none";
  $("ai-status").textContent = "反映しました。「保存」を押すと確定します";
});

$("ai-clean").addEventListener("click", async () => {
  const status = $("ai-clean-status");
  const btn = $("ai-clean");
  const words = topFreqWords().map(([w]) => w);
  cancelNoiseRequest();
  const request = noiseRequest;
  const scope = statisticsScope;
  if (words.length === 0) {
    status.textContent = "まだ頻出単語がありません";
    return;
  }
  btn.disabled = true;
  try {
    const session = await getAiSession(status);
    status.textContent = "ノイズを判定中...";
    const schema = {
      type: "object",
      properties: { noise: { type: "array", items: { type: "string" } } },
      required: ["noise"],
    };
    const res = await session.prompt(
      `次の単語はSNSタイムラインの頻出単語ランキングです:\n${words.join("、")}\n` +
        `この中から、話題・テーマの名前として意味を持たない語(一般的すぎる語、単語の断片、動詞や形容詞など)だけを noise に入れてください。` +
        `固有名詞・作品名・商品名・ジャンル名はテーマなので入れないでください。JSONのみを出力してください。`,
      { responseConstraint: schema }
    );
    if (request !== noiseRequest || !XTaggerStatistics.sameScope(scope, statisticsScope)) return;
    const wordSet = new Set(words);
    const result = JSON.parse(res);
    if (!Array.isArray(result.noise)) throw new Error("候補の形式が正しくありません");
    const noise = [...new Set(result.noise)].filter((w) => typeof w === "string" && wordSet.has(w));
    if (noise.length === 0) {
      status.textContent = "ノイズは見つかりませんでした";
    } else {
      const saved = await XTaggerStatistics.request("ignore", { scope, words: noise });
      if (request !== noiseRequest || !XTaggerStatistics.sameScope(scope, statisticsScope)) return;
      status.textContent = saved.stale
        ? "集計が変更されました。もう一度ノイズ除去を実行してください"
        : `${noise.length}語を除外しました: ${noise.join("、")}`;
      await refreshPopup();
    }
  } catch (e) {
    if (request === noiseRequest) status.textContent = `AIエラー: ${e.message ?? e}`;
  } finally {
    btn.disabled = false;
  }
});

function cancelNoiseRequest() {
  noiseRequest++;
  $("ai-clean-status").textContent = "";
}

async function initAi() {
  const a = await aiAvailability();
  if (a === "unavailable") {
    // 内蔵AI非対応の環境ではAI機能ごと隠す(他機能には影響なし)
    $("ai-suggest").style.display = "none";
    $("ai-clean").style.display = "none";
  } else if (a === "downloadable") {
    $("ai-clean-status").textContent =
      "初回利用時にAIモデルのダウンロードが必要です(数GB・Wi-Fi推奨)";
  }
}

$("reset-counts").addEventListener("click", async () => {
  const btn = $("reset-counts");
  btn.disabled = true;
  cancelNoiseRequest();
  try {
    const result = await XTaggerStatistics.request("reset", { scope: statisticsScope });
    await refreshPopup();
    if (result.stale) showStorageError(new Error("集計が変更されました。もう一度リセットしてください"));
  } catch (error) { showStorageError(error); }
  finally { btn.disabled = false; }
});

function showStorageError(error) {
  $("storage-status").textContent = error.message ?? String(error);
}

async function refreshPopup() {
  const serial = ++refreshSerial;
  try {
    const snapshot = await XTaggerStatistics.request("get");
    if (serial !== refreshSerial) return;
    if (!XTaggerStatistics.sameScope(statisticsScope, snapshot.scope)) {
      cancelNoiseRequest();
    }
    statisticsScope = snapshot.scope;
    data = { ...snapshot.config, ...snapshot.stats };
    $("storage-status").textContent = "";
    render();
    if (!initialized) {
      initialized = true;
      document.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
      initAi();
    }
  } catch (error) { showStorageError(error); }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((key) =>
    ["keywords", "tagSets", "activeSet", "settings", "statisticsVersion"].includes(key) ||
    key === XTaggerStatistics.key(statisticsScope?.setId))) {
    refreshPopup();
  }
});

refreshPopup();
