// X Tagger - 設定ポップアップ
// タグは { label: 表示名, words: [同義語(labelを含む)], excludes: [除外語] }。
// チップをクリックすると同義語・除外語を編集できる。

const DEFAULTS = {
  keywords: [],
  autoKeywords: [],
  ignoredWords: [],
  wordCounts: {},
  settings: {
    hidePromoted: true,
    autoEnabled: true,
    autoThreshold: 20,
    filterMode: false,
  },
};

const FREQ_DISPLAY_MAX = 15;

let data = structuredClone(DEFAULTS);
let editingIndex = null; // 編集中のタグの index。null なら編集パネル非表示

const $ = (id) => document.getElementById(id);

function migrateTags(keywords) {
  return (keywords ?? []).map((k) =>
    typeof k === "string" ? { label: k, words: [k], excludes: [] } : k
  );
}

function save(keys) {
  const patch = {};
  for (const k of keys) patch[k] = data[k];
  chrome.storage.local.set(patch);
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
  editingIndex = index;
  const tag = data.keywords[index];
  $("edit-label").value = tag.label;
  $("edit-words").value = (tag.words ?? [])
    .filter((w) => w !== tag.label)
    .join(", ");
  $("edit-excludes").value = (tag.excludes ?? []).join(", ");
  $("editor").style.display = "block";
  render();
}

function closeEditor() {
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
  save(["keywords"]);
  closeEditor();
});

$("edit-cancel").addEventListener("click", closeEditor);

// ------------------------------------------------------------------- 描画

function render() {
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
          save(["keywords"]);
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
  data.autoKeywords.forEach((word, i) => {
    autoBox.appendChild(
      makeChip(word, "auto", {
        onRemove: () => {
          data.autoKeywords.splice(i, 1);
          if (!data.ignoredWords.includes(word)) data.ignoredWords.push(word);
          save(["autoKeywords", "ignoredWords"]);
          render();
        },
      })
    );
  });

  // 頻出単語ランキング
  const freqBox = $("freq");
  freqBox.textContent = "";
  const known = new Set([...data.autoKeywords, ...data.ignoredWords]);
  for (const tag of data.keywords) {
    known.add(tag.label);
    for (const w of tag.words ?? []) known.add(w);
  }
  const top = Object.entries(data.wordCounts)
    .filter(([w]) => !known.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, FREQ_DISPLAY_MAX);

  if (top.length === 0) {
    freqBox.innerHTML =
      '<span class="empty">x.com をスクロールすると集計されます</span>';
  }
  for (const [word, count] of top) {
    const row = document.createElement("div");
    row.className = "freq-row";
    const left = document.createElement("span");
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
      save(["keywords"]);
      render();
    });
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
    save(["keywords"]);
  }
  input.value = "";
  render();
}

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

$("reset-counts").addEventListener("click", () => {
  data.wordCounts = {};
  save(["wordCounts"]);
  render();
});

chrome.storage.local.get(DEFAULTS, (stored) => {
  data = stored;
  data.keywords = migrateTags(stored.keywords);
  data.settings = { ...DEFAULTS.settings, ...stored.settings };
  render();
});
