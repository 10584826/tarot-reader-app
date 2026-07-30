const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEFAULT_MODEL = (process.env.GEMINI_MODEL || "gemini-3.6-flash").trim();
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 5000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* -------------------- Gemini 呼叫 -------------------- */
async function generateWithGemini(prompt, model = DEFAULT_MODEL) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.65,
      topP: 0.9,
      maxOutputTokens: 1600
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `Gemini API error (${r.status})`);
    err.status = r.status;
    err.payload = data;
    throw err;
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.output ||
    "";

  return String(text || "").trim();
}

/* -------------------- 四段檢測/修復 -------------------- */
function cleanText(t = "") {
  return String(t).replace(/\r/g, "").trim();
}

function extractSection(text, patterns) {
  const lower = text.toLowerCase();
  let start = -1;
  for (const p of patterns) {
    const i = lower.search(p);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  return start;
}

function parseSections(raw) {
  const text = cleanText(raw);
  if (!text) return null;

  const idx = {
    s1: extractSection(text, [/一[、\.．\s]*核心摘要/i, /核心摘要/i]),
    s2: extractSection(text, [/二[、\.．\s]*逐張解讀/i, /逐張解讀/i]),
    s3: extractSection(text, [/三[、\.．\s]*行動建議/i, /行動建議/i]),
    s4: extractSection(text, [/四[、\.．\s]*提醒與界線/i, /提醒與界線/i, /提醒/i])
  };

  const points = Object.entries(idx)
    .filter(([, v]) => v >= 0)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => a.v - b.v);

  if (points.length === 0) return null;

  const out = { s1: "", s2: "", s3: "", s4: "" };
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const start = cur.v;
    const end = next ? next.v : text.length;
    let block = text.slice(start, end).trim();

    block = block
      .replace(/^(一|二|三|四)[、\.．\s]*(核心摘要|逐張解讀|行動建議|提醒與界線)\s*/i, "")
      .replace(/^(核心摘要|逐張解讀|行動建議|提醒與界線)\s*/i, "")
      .trim();

    out[cur.k] = block;
  }

  return out;
}

function isGoodStructured(raw) {
  const t = cleanText(raw);
  if (t.length < 280) return false;
  const s = parseSections(t);
  if (!s) return false;

  const hasAllTitles =
    /一[、\.．\s]*核心摘要|核心摘要/i.test(t) &&
    /二[、\.．\s]*逐張解讀|逐張解讀/i.test(t) &&
    /三[、\.．\s]*行動建議|行動建議/i.test(t) &&
    /四[、\.．\s]*提醒與界線|提醒與界線|提醒/i.test(t);

  if (!hasAllTitles) return false;
  if (!s.s1 || !s.s2 || !s.s3 || !s.s4) return false;
  return true;
}

function forceFourSectionFallback(raw) {
  const s = parseSections(raw) || { s1: "", s2: "", s3: "", s4: "" };

  const sec1 =
    s.s1 ||
    "你正處在關鍵轉折點，重點不是追求完美，而是先把方向釐清並開始行動。";
  const sec2 =
    s.s2 ||
    "目前可先從你最在意的核心議題下手，逐步拆解成可執行的小步驟；若感到混亂，先回到事實與優先順序。";
  const sec3 =
    s.s3 ||
    "建議1：今天先完成一個最小行動（原因：建立動能）。\n建議2：列出三個可控變因（原因：降低焦慮）。\n建議3：設定一個一週後檢核點（原因：持續修正方向）。";
  const sec4 =
    s.s4 ||
    "解讀提供的是趨勢與提醒，不是命定結論；你仍擁有選擇權，穩定前進就能逐步改善結果。";

  return [
    "一、核心摘要",
    sec1,
    "",
    "二、逐張解讀",
    sec2,
    "",
    "三、行動建議",
    sec3,
    "",
    "四、提醒與界線",
    sec4
  ].join("\n");
}

function buildRepairPrompt(originalPrompt, badOutput) {
  return `
你先前輸出不完整，現在請重新輸出完整最終答案。

${originalPrompt}

【先前不完整輸出（勿延續）】
${badOutput}

【硬性規則】
1. 必須依序輸出四段標題：
一、核心摘要
二、逐張解讀
三、行動建議
四、提醒與界線
2. 每段必須有內容，不可空白。
3. 全文 320~650 字，繁體中文。
4. 「行動建議」必須 3 點條列。
5. 不要解釋流程，不要說你將要做什麼，直接輸出答案。
`.trim();
}

/* -------------------- API -------------------- */
app.post("/api/interpret", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();

  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "AI_API_ERROR",
        message: "Missing GEMINI_API_KEY"
      });
    }

    if (!prompt) {
      return res.status(400).json({
        error: "AI_API_ERROR",
        message: "Missing prompt"
      });
    }

    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({
        error: "AI_API_ERROR",
        message: `Prompt too long (>${MAX_PROMPT_CHARS})`
      });
    }

    // 第1次生成
    let text = await generateWithGemini(prompt, DEFAULT_MODEL);

    // 不完整就第2次修復生成
    if (!isGoodStructured(text)) {
      const repairedPrompt = buildRepairPrompt(prompt, text);
      const text2 = await generateWithGemini(repairedPrompt, DEFAULT_MODEL);
      if (isGoodStructured(text2)) {
        text = text2;
      } else {
        // 第3層保險：後端強制補成四段
        text = forceFourSectionFallback(text2 || text);
      }
    }

    return res.status(200).json({
      text,
      modelUsed: DEFAULT_MODEL,
      degraded: false
    });
  } catch (err) {
    const status = Number(err.status) || 500;

    // 429 也回可顯示內容（避免前端空白）
    if (status === 429) {
      return res.status(200).json({
        text: forceFourSectionFallback(""),
        modelUsed: "fallback-local",
        degraded: true,
        reason: "quota_or_rate_limited"
      });
    }

    return res.status(status).json({
      error: "AI_API_ERROR",
      message: err?.message || "Unknown server error",
      details: err?.payload?.error || null
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});