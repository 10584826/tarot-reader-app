const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 5000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeModelName(name = "") {
  const n = String(name).trim().toLowerCase();
  const map = {
    "gemini 3.6 flash": "gemini-3.6-flash",
    "gemini 3.5 flash lite": "gemini-3.5-flash-lite",
    "gemini 3.5 flash": "gemini-3.5-flash",
    "gemini 3.1 flash lite": "gemini-3.1-flash-lite",
    "gemini 3 flash": "gemini-3-flash",
    "gemini 2.0 flash": "gemini-2.0-flash",
    "gemini 2.0 flash lite": "gemini-2.0-flash-lite",
    "gemini 1.5 flash": "gemini-1.5-flash"
  };
  if (map[n]) return map[n];
  return n.includes("gemini-") ? n : n.replace(/\s+/g, "-");
}

const DEFAULT_MODEL = normalizeModelName(process.env.GEMINI_MODEL || "gemini-3.6-flash");

async function generateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1400
      }
    })
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

// 檢查是否有完整四段
function isStructuredReading(text = "") {
  const t = String(text).trim();
  if (t.length < 260) return false;

  const has1 = /一[、\.．\s]*核心摘要|核心摘要/i.test(t);
  const has2 = /二[、\.．\s]*逐張解讀|逐張解讀/i.test(t);
  const has3 = /三[、\.．\s]*行動建議|行動建議/i.test(t);
  const has4 = /四[、\.．\s]*提醒與界線|提醒與界線|提醒/i.test(t);

  return has1 && has2 && has3 && has4;
}

function buildRepairPrompt(originalPrompt, badOutput) {
  return `
你上一次輸出不完整，只給了局部段落。請「完全重寫」並嚴格遵守格式。

${originalPrompt}

【失敗輸出（不要延續）】
${badOutput}

【硬性規則】
1) 必須輸出四段完整標題：
一、核心摘要
二、逐張解讀
三、行動建議
四、提醒與界線
2) 總字數 320~650 字。
3) 使用繁體中文。
4) 不可只輸出其中一段，不可從「3.」或中間段落開始。
5) 直接輸出最終答案，不要說明你在做什麼。
`.trim();
}

app.post("/api/interpret", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();

  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: "Prompt too long" });
    }

    const modelUsed = DEFAULT_MODEL;

    // 第一次
    let text = await generateWithGemini({
      apiKey: GEMINI_API_KEY,
      model: modelUsed,
      prompt
    });

    // 若不完整，強制第二次重寫
    if (!isStructuredReading(text)) {
      const repairedPrompt = buildRepairPrompt(prompt, text);
      const text2 = await generateWithGemini({
        apiKey: GEMINI_API_KEY,
        model: modelUsed,
        prompt: repairedPrompt
      });

      if (isStructuredReading(text2)) {
        text = text2;
      }
    }

    return res.status(200).json({
      text,
      modelUsed,
      degraded: false
    });
  } catch (err) {
    const status = Number(err.status) || 500;
    return res.status(status).json({
      error: "AI_API_ERROR",
      message: err?.message || "Unknown server error",
      details: err?.payload?.error || null
    });
  }
});

// health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});