const express = require("express");
const path = require("path");

const app = express();

/**
 * =========================
 * 基本設定
 * =========================
 */
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 5000);

// 若未設定，預設以 3.6 flash 優先
const ENV_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * =========================
 * 模型名稱正規化
 * =========================
 */
function normalizeModelName(name = "") {
  const n = String(name).trim().toLowerCase();

  const map = {
    "gemini 3.6 flash": "gemini-3.6-flash",
    "gemini 3.5 flash lite": "gemini-3.5-flash-lite",
    "gemini 3.5 flash": "gemini-3.5-flash",
    "gemini 3.1 flash lite": "gemini-3.1-flash-lite",
    "gemini 3 flash": "gemini-3-flash",
    "gemini 2.5 flash lite": "gemini-2.5-flash-lite",
    "gemini 2.0 flash": "gemini-2.0-flash",
    "gemini 2.0 flash lite": "gemini-2.0-flash-lite",
    "gemini 1.5 flash": "gemini-1.5-flash"
  };

  if (map[n]) return map[n];
  return n.includes("gemini-") ? n : n.replace(/\s+/g, "-");
}

/**
 * =========================
 * 可用模型查詢（可選）
 * =========================
 */
async function listAvailableModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const err = new Error(data?.error?.message || `List models failed (${r.status})`);
    err.status = r.status;
    err.payload = data;
    throw err;
  }

  return (data.models || [])
    .filter(
      (m) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent")
    )
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

/**
 * =========================
 * 請求 Gemini
 * =========================
 */
async function generateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

  if (!String(text).trim()) {
    const err = new Error("Gemini returned empty content.");
    err.status = 502;
    err.payload = data;
    throw err;
  }

  return { text: String(text).trim(), raw: data };
}

/**
 * =========================
 * 錯誤判斷：是否可換模型重試
 * =========================
 */
function isQuotaOrRateLimit429(err) {
  const status = Number(err?.status || err?.payload?.error?.code);
  if (status !== 429) return false;

  const msg = String(err?.message || err?.payload?.error?.message || "").toLowerCase();
  return (
    msg.includes("quota exceeded") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("retry") ||
    msg.includes("generativelanguage.googleapis.com")
  );
}

function isRetryableModelError(err) {
  // 404 model not found, 429 quota/rate, 503 service unavailable 皆可換下一個
  const status = Number(err?.status || err?.payload?.error?.code);
  if ([404, 429, 500, 503].includes(status)) return true;
  return false;
}

/**
 * =========================
 * 內容品質檢查（四段）
 * =========================
 */
function cleanText(t = "") {
  return String(t).replace(/\r/g, "").trim();
}

function findSectionIndex(text, patterns) {
  const lower = text.toLowerCase();
  let found = -1;
  let best = Number.POSITIVE_INFINITY;
  for (const p of patterns) {
    const idx = lower.search(p);
    if (idx >= 0 && idx < best) {
      best = idx;
      found = idx;
    }
  }
  return found;
}

function parseReadingSections(rawText) {
  const text = cleanText(rawText);
  if (!text) return null;

  const i1 = findSectionIndex(text, [/一[、\.．\s]*核心摘要/i, /核心摘要/i]);
  const i2 = findSectionIndex(text, [/二[、\.．\s]*逐張解讀/i, /逐張解讀/i]);
  const i3 = findSectionIndex(text, [/三[、\.．\s]*行動建議/i, /行動建議/i]);
  const i4 = findSectionIndex(text, [/四[、\.．\s]*提醒與界線/i, /提醒與界線/i, /提醒/i]);

  const found = [
    { key: "summary", idx: i1, title: "一、核心摘要" },
    { key: "detail", idx: i2, title: "二、逐張解讀" },
    { key: "actions", idx: i3, title: "三、行動建議" },
    { key: "reminder", idx: i4, title: "四、提醒與界線" }
  ]
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  if (!found.length) return null;

  const sections = {};
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    const next = found[i + 1];
    const start = cur.idx;
    const end = next ? next.idx : text.length;
    let block = text.slice(start, end).trim();

    block = block
      .replace(
        /^(一|二|三|四)[、\.．\s]*(核心摘要|逐張解讀|行動建議|提醒與界線)\s*/i,
        ""
      )
      .replace(/^(核心摘要|逐張解讀|行動建議|提醒與界線)\s*/i, "")
      .trim();

    sections[cur.key] = block;
  }

  return {
    summary: sections.summary || "",
    detail: sections.detail || "",
    actions: sections.actions || "",
    reminder: sections.reminder || ""
  };
}

function isStructuredReading(text = "") {
  const t = cleanText(text);
  if (t.length < 280) return false;

  const has1 = /一[、\.．\s]*核心摘要|核心摘要/i.test(t);
  const has2 = /二[、\.．\s]*逐張解讀|逐張解讀/i.test(t);
  const has3 = /三[、\.．\s]*行動建議|行動建議/i.test(t);
  const has4 = /四[、\.．\s]*提醒與界線|提醒與界線|提醒/i.test(t);

  if (!(has1 && has2 && has3 && has4)) return false;

  const sec = parseReadingSections(t);
  if (!sec) return false;

  return Boolean(sec.summary && sec.detail && sec.actions && sec.reminder);
}

function buildRepairPrompt(originalPrompt, badOutput) {
  return `
你先前輸出不完整，請重新輸出完整答案。

${originalPrompt}

【不完整輸出（勿沿用）】
${badOutput}

【硬性規則】
1) 必須依序輸出：
一、核心摘要
二、逐張解讀
三、行動建議
四、提醒與界線
2) 每段都要有內容，不可只輸出其中一段。
3) 全文 320~650 字，繁體中文。
4) 行動建議必須 3 點條列。
5) 直接輸出最終答案，不要說明流程。
`.trim();
}

function forceFourSectionFallback(rawText = "") {
  const sec = parseReadingSections(rawText) || {
    summary: "",
    detail: "",
    actions: "",
    reminder: ""
  };

  const s1 =
    sec.summary ||
    "你目前處於調整到行動的轉折點，重點不是追求完美，而是先建立清楚方向並開始執行。";
  const s2 =
    sec.detail ||
    "從牌意來看，眼前課題在於把感受轉成可落地的選擇；先釐清你最在意的一件事，再拆成可執行步驟，會比同時處理所有問題更有效。";
  const s3 =
    sec.actions ||
    "建議1：今天完成一個最小行動（原因：建立動能）。\n建議2：列出三項可控變因（原因：降低焦慮、聚焦資源）。\n建議3：設定 7 天後回顧點（原因：持續修正方向）。";
  const s4 =
    sec.reminder ||
    "塔羅提供的是趨勢與提醒，不是命定結論；你始終擁有選擇權，穩定前進就能逐步改善結果。";

  return [
    "一、核心摘要",
    s1,
    "",
    "二、逐張解讀",
    s2,
    "",
    "三、行動建議",
    s3,
    "",
    "四、提醒與界線",
    s4
  ].join("\n");
}

/**
 * =========================
 * 模型輪詢：429/RPD 自動切換
 * =========================
 */
function buildCandidateModels() {
  // 你可用模型優先序（可自行調整）
  const preferred = [
    normalizeModelName(ENV_MODEL),
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash"
  ];
  return [...new Set(preferred)];
}

async function generateWithModelFallback({ apiKey, prompt }) {
  const candidates = buildCandidateModels();
  const tried = [];

  // 先嘗試用 API 實際可用模型做交集（若 list 失敗就忽略，照候選跑）
  let runnable = candidates;
  try {
    const available = await listAvailableModels(apiKey);
    const set = new Set(available);
    const filtered = candidates.filter((m) => set.has(m));
    if (filtered.length) runnable = filtered;
  } catch {
    // ignore
  }

  let lastErr = null;

  for (const model of runnable) {
    try {
      const out = await generateWithGemini({ apiKey, model, prompt });
      return { ...out, modelUsed: model, triedModels: tried };
    } catch (err) {
      tried.push({
        model,
        status: Number(err?.status) || null,
        message: String(err?.message || "").slice(0, 260)
      });

      lastErr = err;

      // 404/429/503 可換下一個模型
      if (isRetryableModelError(err)) continue;

      // 其他錯誤直接拋
      throw err;
    }
  }

  if (lastErr) throw Object.assign(lastErr, { triedModels: tried });
  throw new Error("No model succeeded.");
}

/**
 * =========================
 * API：解讀
 * =========================
 */
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

    // 1) 先做模型輪詢（含 429/RPD 自動切換）
    let first = await generateWithModelFallback({
      apiKey: GEMINI_API_KEY,
      prompt
    });

    let finalText = first.text;
    let modelUsed = first.modelUsed;
    const triedModels = first.triedModels || [];

    // 2) 結構不完整 -> 用同一成功模型再修復一次
    if (!isStructuredReading(finalText)) {
      const repairPrompt = buildRepairPrompt(prompt, finalText);

      try {
        const repaired = await generateWithGemini({
          apiKey: GEMINI_API_KEY,
          model: modelUsed,
          prompt: repairPrompt
        });

        if (isStructuredReading(repaired.text)) {
          finalText = repaired.text;
        } else {
          // 3) 仍不完整 -> 強制四段保底
          finalText = forceFourSectionFallback(repaired.text || finalText);
        }
      } catch {
        finalText = forceFourSectionFallback(finalText);
      }
    }

    return res.status(200).json({
      text: finalText,
      modelUsed,
      triedModels,
      degraded: false
    });
  } catch (err) {
    const status = Number(err?.status) || 500;

    // 若 429（可能所有模型都限流）-> 回傳可顯示保底內容
    if (status === 429 || isQuotaOrRateLimit429(err)) {
      return res.status(200).json({
        text: forceFourSectionFallback(""),
        modelUsed: "fallback-local",
        triedModels: err?.triedModels || [],
        degraded: true,
        reason: "quota_exceeded_or_rate_limited"
      });
    }

    return res.status(status).json({
      error: "AI_API_ERROR",
      message: err?.message || "Unknown server error",
      details: err?.payload?.error || null,
      triedModels: err?.triedModels || []
    });
  }
});

/**
 * 健康檢查
 */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    envModel: normalizeModelName(ENV_MODEL)
  });
});

/**
 * SPA fallback
 */
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});