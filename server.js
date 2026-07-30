const express = require("express");
const path = require("path");

const app = express();

/**
 * ===== 基本設定 =====
 */
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 4000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000); // 1 分鐘
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12); // 每 IP 每分鐘最多 12 次

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * ===== 模型名稱正規化 =====
 * 把 UI 顯示名轉成 API 常用 ID 格式，避免 404 model not found
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

    // 兼容舊名
    "gemini 2.0 flash": "gemini-2.0-flash",
    "gemini 2.0 flash lite": "gemini-2.0-flash-lite",
    "gemini 1.5 flash": "gemini-1.5-flash"
  };

  if (map[n]) return map[n];

  // 若已是 gemini-xxx 格式，直接回傳；否則把空白轉連字號
  return n.includes("gemini-") ? n : n.replace(/\s+/g, "-");
}

const DEFAULT_MODEL = normalizeModelName(
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
);

/**
 * ===== 基本安全：簡易記憶體 Rate Limit =====
 */
const ipBuckets = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  const bucket = ipBuckets.get(ip) || { count: 0, windowStart: now };
  if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count += 1;
  ipBuckets.set(ip, bucket);

  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: "Too many requests",
      message: "請稍後再試（請求過於頻繁）"
    });
  }

  next();
}

/**
 * ===== 可用模型查詢 =====
 */
async function listAvailableModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg = data?.error?.message || `List models failed (${r.status})`;
    throw new Error(msg);
  }

  return (data.models || [])
    .filter((m) =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent")
    )
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function pickAvailableModel(apiKey) {
  const supported = await listAvailableModels(apiKey);

  // 你提供的可用模型優先順序（先用環境變數，再依序 fallback）
  const preferredRaw = [
    process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-2.5-flash-lite",
    // 額外保底
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash"
  ];

  const preferred = [...new Set(preferredRaw.map(normalizeModelName))];

  for (const model of preferred) {
    if (supported.includes(model)) return model;
  }

  if (supported.length > 0) return supported[0];
  throw new Error("No available Gemini model supports generateContent.");
}

/**
 * ===== 生成請求 =====
 */
async function generateWithGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      topP: 0.9,
      maxOutputTokens: 900
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

  if (!text) {
    const err = new Error("Gemini returned empty content.");
    err.status = 502;
    throw err;
  }

  return { text, raw: data };
}

/**
 * ===== 429/配額耗盡備援文字 =====
 */
function buildFallbackReading(prompt = "") {
  const trimmed = String(prompt).trim().slice(0, 320);

  return [
    "目前 AI 服務額度已滿或暫時繁忙，我先提供一段備援指引：",
    "",
    "你此刻最需要的不是一次到位的答案，而是先釐清「最重要的一個問題核心」。",
    "請把焦點放在你現在能主動影響的行動上，而非不可控的外在結果。",
    "",
    "建議你現在做三件事：",
    "1. 寫下你最在意的目標，以及本週可完成的一個最小步驟。",
    "2. 列出兩個可行選項，分別評估風險與收益。",
    "3. 設定 3~7 天後的回顧時間，檢查進展再調整。",
    "",
    "（系統摘要）",
    trimmed || "未收到有效問題內容。"
  ].join("\n");
}

/**
 * ===== API：塔羅 AI 解讀 =====
 */
app.post("/api/interpret", rateLimit, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();

  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Missing GEMINI_API_KEY",
        message: "伺服器尚未設定 Gemini API 金鑰"
      });
    }

    if (!prompt) {
      return res.status(400).json({
        error: "Missing prompt",
        message: "請提供 prompt"
      });
    }

    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({
        error: "Prompt too long",
        message: `prompt 長度不可超過 ${MAX_PROMPT_CHARS} 字元`
      });
    }

    // 先用預設模型，失敗（如404）再自動挑可用模型重試
    let modelUsed = DEFAULT_MODEL;
    let result;

    try {
      result = await generateWithGemini({
        apiKey: GEMINI_API_KEY,
        model: modelUsed,
        prompt
      });
    } catch (firstErr) {
      // 429 直接降級，不再重試避免浪費配額
      if (Number(firstErr.status) === 429) throw firstErr;

      const fallbackModel = await pickAvailableModel(GEMINI_API_KEY);
      modelUsed = fallbackModel;

      result = await generateWithGemini({
        apiKey: GEMINI_API_KEY,
        model: modelUsed,
        prompt
      });
    }

    return res.status(200).json({
      text: result.text,
      modelUsed,
      degraded: false
    });
  } catch (err) {
    const status = Number(err.status) || 500;

    // 配額耗盡或頻率超限：回傳 200 + 備援文字，前端可正常顯示
    if (status === 429) {
      return res.status(200).json({
        text: buildFallbackReading(prompt),
        modelUsed: "fallback-local",
        degraded: true,
        reason: "quota_exceeded_or_rate_limited"
      });
    }

    return res.status(status).json({
      error: "AI_API_ERROR",
      message: err?.message || "Unknown server error",
      details: err?.payload?.error || null
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
    uptimeSec: Math.floor(process.uptime())
  });
});

/**
 * SPA fallback（放最後）
 */
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});