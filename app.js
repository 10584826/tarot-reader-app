const questionInput = document.getElementById("questionInput");
const drawOneBtn = document.getElementById("drawOneBtn");
const drawThreeBtn = document.getElementById("drawThreeBtn");
const cardsContainer = document.getElementById("cardsContainer");
const aiResult = document.getElementById("aiResult");

let tarotData = [];

// 載入本地卡牌資料
async function loadTarotData() {
  const res = await fetch("./data/tarot-images.json");
  const json = await res.json();
  tarotData = json.cards || [];
}

// 隨機抽 n 張不重複牌
function drawRandomCards(n = 1) {
  const pool = [...tarotData];
  const result = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const card = pool.splice(idx, 1)[0];
    const isReversed = Math.random() < 0.5;
    result.push({ ...card, isReversed });
  }
  return result;
}

function cardMeaning(card) {
  return card.isReversed ? card.meaning_rev || "（逆位解讀待補）" : card.meaning_up || "（正位解讀待補）";
}

// 顯示牌卡
function renderCards(cards, spreadType) {
  cardsContainer.innerHTML = "";
  const labels = spreadType === "three" ? ["過去", "現在", "未來"] : ["指引"];
  cards.forEach((card, i) => {
    const div = document.createElement("article");
    div.className = "card";
    div.innerHTML = `
      <p class="text-sm text-amber-300 mb-2">${labels[i]}</p>
      <img class="tarot-img ${card.isReversed ? "reversed" : ""}" src="${card.image}" alt="${card.name}" />
      <h3 class="mt-3 text-lg font-bold">${card.name}</h3>
      <p class="text-sm mt-1 ${card.isReversed ? "text-rose-300" : "text-emerald-300"}">
        ${card.isReversed ? "逆位" : "正位"}
      </p>
      <p class="text-sm mt-2 text-amber-100/90">${cardMeaning(card)}</p>
    `;
    cardsContainer.appendChild(div);
  });
}

// 組 Prompt
function buildPrompt(question, cards, spreadType) {
  const spreadDesc = spreadType === "three"
    ? "三牌陣（過去、現在、未來）"
    : "單牌陣（單一指引）";

  const cardLines = cards.map((c, i) => {
    const pos = spreadType === "three" ? ["過去", "現在", "未來"][i] : "指引";
    return `- ${pos}：${c.name}（${c.isReversed ? "逆位" : "正位"}）｜牌義：${cardMeaning(c)}`;
  }).join("\n");

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

// 呼叫自己的後端 API（安全）
async function getAIInterpretation(prompt) {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API 錯誤：${err}`);
  }

  const data = await res.json();
  return data.text || "目前無法取得解讀，請稍後再試。";
}

async function runReading(spreadType) {
  const question = questionInput.value.trim();
  if (!question) {
    alert("請先輸入你的問題 🙏");
    return;
  }

  aiResult.textContent = "正在洗牌與解讀中，請稍候...";
  aiResult.classList.add("shimmer");

  const count = spreadType === "three" ? 3 : 1;
  const cards = drawRandomCards(count);
  renderCards(cards, spreadType);

  try {
    const prompt = buildPrompt(question, cards, spreadType);
    const text = await getAIInterpretation(prompt);
    aiResult.textContent = text;
  } catch (e) {
    aiResult.textContent = `發生錯誤：${e.message}`;
  } finally {
    aiResult.classList.remove("shimmer");
  }
}

drawOneBtn.addEventListener("click", () => runReading("one"));
drawThreeBtn.addEventListener("click", () => runReading("three"));

loadTarotData().catch(err => {
  aiResult.textContent = `載入牌卡資料失敗：${err.message}`;
});