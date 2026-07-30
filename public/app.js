// ===== DOM =====
const questionInput = document.getElementById("questionInput");
const drawOneBtn = document.getElementById("drawOneBtn");
const drawThreeBtn = document.getElementById("drawThreeBtn");
const cardsContainer = document.getElementById("cardsContainer");
const aiResult = document.getElementById("aiResult");

// 手動選牌（若頁面有加該區塊就會啟用）
const manualOneBtn = document.getElementById("manualOneBtn");
const manualThreeBtn = document.getElementById("manualThreeBtn");
const manualPicker = document.getElementById("manualPicker");

let tarotData = [];

// ===== 初始化 =====
init();

async function init() {
  try {
    await loadTarotData();
    bindEvents();
  } catch (err) {
    aiResult.textContent = `載入失敗：${err.message}`;
  }
}

function bindEvents() {
  drawOneBtn?.addEventListener("click", () => runReading("one"));
  drawThreeBtn?.addEventListener("click", () => runReading("three"));

  manualOneBtn?.addEventListener("click", () => renderManualPicker("one"));
  manualThreeBtn?.addEventListener("click", () => renderManualPicker("three"));
}

// ===== 資料 =====
async function loadTarotData() {
  const res = await fetch("./data/tarot-images.json");
  if (!res.ok) throw new Error(`tarot-images.json 載入失敗 (${res.status})`);
  const json = await res.json();
  tarotData = Array.isArray(json.cards) ? json.cards : [];
  if (!tarotData.length) throw new Error("牌卡資料為空");
}

// ===== 工具 =====
function cardMeaning(card) {
  return card.isReversed
    ? card.meaning_rev || "（逆位解讀待補）"
    : card.meaning_up || "（正位解讀待補）";
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setLoading(message = "正在洗牌與解讀中，請稍候...") {
  aiResult.textContent = message;
  aiResult.classList.add("shimmer");
}

function clearLoading() {
  aiResult.classList.remove("shimmer");
}

// ===== 隨機抽牌 =====
function drawRandomCards(n = 1) {
  const pool = [...tarotData];
  const result = [];

  if (n > pool.length) {
    throw new Error("抽牌數量超過牌庫總數");
  }

  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const card = pool.splice(idx, 1)[0];
    const isReversed = Math.random() < 0.5;
    result.push({ ...card, isReversed });
  }
  return result;
}

// ===== 顯示牌面 =====
function renderCards(cards, spreadType) {
  cardsContainer.innerHTML = "";

  const labels =
    spreadType === "three" ? ["過去", "現在", "未來"] : ["指引"];

  cards.forEach((card, i) => {
    const div = document.createElement("article");
    div.className = "card";

    const safeName = escapeHtml(card.name || "Unknown Card");
    const safeMeaning = escapeHtml(cardMeaning(card));
    const safeImage = escapeHtml(card.image || "");

    div.innerHTML = `
      <p class="text-sm text-amber-300 mb-2">${labels[i] || "牌位"}</p>
      <img
        class="tarot-img ${card.isReversed ? "reversed" : ""}"
        src="${safeImage}"
        alt="${safeName}"
        loading="lazy"
        onerror="this.onerror=null;this.src='https://dummyimage.com/400x700/0f172a/fbbf24&text=Tarot+Image+Not+Found';"
      />
      <h3 class="mt-3 text-lg font-bold">${safeName}</h3>
      <p class="text-sm mt-1 ${card.isReversed ? "text-rose-300" : "text-emerald-300"}">
        ${card.isReversed ? "逆位" : "正位"}
      </p>
      <p class="text-sm mt-2 text-amber-100/90">${safeMeaning}</p>
    `;

    cardsContainer.appendChild(div);
  });
}

// ===== Prompt =====
function buildPrompt(question, cards, spreadType) {
  const spreadDesc =
    spreadType === "three"
      ? "三牌陣（過去、現在、未來）"
      : "單牌陣（單一指引）";

  const positions = spreadType === "three" ? ["過去", "現在", "未來"] : ["指引"];

  const cardLines = cards
    .map((c, i) => {
      const pos = positions[i] || "牌位";
      return `- ${pos}：${c.name}（${c.isReversed ? "逆位" : "正位"}）｜牌義：${cardMeaning(c)}`;
    })
    .join("\n");

  return `
你是一位溫暖且具洞察力的塔羅師，請以繁體中文回答。
使用者問題：${question}
牌陣：${spreadDesc}
抽到的牌：
${cardLines}

請提供：
1. 先用2-3句總結核心訊息
2. 逐張牌對應到問題情境解讀
3. 給出可執行的三點建議
4. 語氣要溫柔務實，不要恐嚇，不要絕對化預言
`.trim();
}

// ===== 呼叫後端 API =====
async function getAIInterpretation(prompt) {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });

  const data = await res.json().catch(() => ({}));

  // 後端可能回非 200，或回 200 但帶錯誤訊息
  if (!res.ok) {
    const msg =
      data?.message ||
      data?.error ||
      `API Error (${res.status})`;
    throw new Error(msg);
  }

  // 相容你的 server.js：text / modelUsed / degraded
  return {
    text: data?.text || "目前無法取得解讀，請稍後再試。",
    modelUsed: data?.modelUsed || "unknown",
    degraded: !!data?.degraded
  };
}

// ===== 共用執行流程 =====
async function runReadingWithCards(spreadType, cards) {
  const question = questionInput.value.trim();
  if (!question) {
    alert("請先輸入你的問題 🙏");
    return;
  }

  renderCards(cards, spreadType);
  setLoading("正在解讀中，請稍候...");

  try {
    const prompt = buildPrompt(question, cards, spreadType);
    const result = await getAIInterpretation(prompt);

    let header = "";
    if (result.degraded) {
      header = "⚠️ 目前使用備援解讀模式（AI 配額或速率限制）\n\n";
    } else {
      header = `✨ 模型：${result.modelUsed}\n\n`;
    }

    aiResult.textContent = `${header}${result.text}`;
  } catch (e) {
    aiResult.textContent = `發生錯誤：${e.message}`;
  } finally {
    clearLoading();
  }
}

// ===== 隨機模式入口 =====
async function runReading(spreadType) {
  try {
    const question = questionInput.value.trim();
    if (!question) {
      alert("請先輸入你的問題 🙏");
      return;
    }

    setLoading("正在洗牌與解讀中，請稍候...");

    const count = spreadType === "three" ? 3 : 1;
    const cards = drawRandomCards(count);

    await runReadingWithCards(spreadType, cards);
  } catch (e) {
    aiResult.textContent = `發生錯誤：${e.message}`;
    clearLoading();
  }
}

// ===== 手動選牌 UI =====
function renderManualPicker(spreadType = "one") {
  if (!manualPicker) return; // 頁面未放該區塊時安全略過

  const count = spreadType === "three" ? 3 : 1;
  const labels = spreadType === "three" ? ["過去", "現在", "未來"] : ["指引"];

  const gridClass = count === 3 ? "md:grid-cols-3" : "md:grid-cols-1";

  let html = `<div class="grid grid-cols-1 ${gridClass} gap-3">`;

  for (let i = 0; i < count; i++) {
    html += `
      <div class="bg-slate-800 rounded-xl p-3 border border-amber-500/20">
        <label class="block text-sm mb-2 text-amber-200">${labels[i]}：選牌</label>
        <select id="manualCard_${i}" class="w-full rounded-lg bg-slate-900 border border-amber-500/20 p-2">
          <option value="">-- 請選擇牌卡 --</option>
          ${tarotData
            .map((c, idx) => `<option value="${idx}">${escapeHtml(c.name)}</option>`)
            .join("")}
        </select>

        <label class="block text-sm mt-3 mb-2 text-amber-200">牌位</label>
        <select id="manualOri_${i}" class="w-full rounded-lg bg-slate-900 border border-amber-500/20 p-2">
          <option value="up">正位</option>
          <option value="rev">逆位</option>
        </select>
      </div>
    `;
  }

  html += `</div>
    <button id="confirmManualBtn" class="mt-4 px-4 py-2 rounded-xl bg-emerald-500 text-slate-900 font-semibold hover:bg-emerald-400">
      產生解讀
    </button>
  `;

  manualPicker.innerHTML = html;
  manualPicker.classList.remove("hidden");

  document.getElementById("confirmManualBtn")?.addEventListener("click", async () => {
    const question = questionInput.value.trim();
    if (!question) {
      alert("請先輸入你的問題 🙏");
      return;
    }

    const selected = [];
    const used = new Set();

    for (let i = 0; i < count; i++) {
      const cardSelect = document.getElementById(`manualCard_${i}`);
      const oriSelect = document.getElementById(`manualOri_${i}`);

      const cardIdx = cardSelect?.value;
      const ori = oriSelect?.value || "up";

      if (cardIdx === "") {
        alert(`請完成第 ${i + 1} 張牌的選擇`);
        return;
      }

      // 三牌時避免重複
      if (count === 3) {
        if (used.has(cardIdx)) {
          alert("手動三牌不可重複，請重新選擇");
          return;
        }
        used.add(cardIdx);
      }

      const base = tarotData[Number(cardIdx)];
      if (!base) {
        alert(`第 ${i + 1} 張牌資料錯誤，請重選`);
        return;
      }

      selected.push({
        ...base,
        isReversed: ori === "rev"
      });
    }

    await runReadingWithCards(spreadType, selected);
  });
}