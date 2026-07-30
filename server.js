const express = require("express");
const path = require("path");

const app = express();

/**
 * ===== 基本設定 =====
 */
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// 你可用環境變數覆蓋這些值（避免被濫用）
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 4000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000); // 1 分鐘
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12); // 每 IP 每分鐘最多 12 次

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * ===== 簡易記憶體 Rate Limit（免費版夠用） =====
 */
const ipBuckets = new Map();

function getClientIp(req) {
  // App Service / proxy 情境下常見 header
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
 * ===== Gemini 工具函式 =====
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
    .filter((m) => Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function pickAvailableModel(apiKey) {
  const supported = await listAvailableModels(apiKey);

  // 依偏好排序，挑第一個可用
  const preferred = [
    DEFAULT_MODEL,
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash"
  ];

  for (const name of preferred) {
    if (supported.includes(name)) return name;
  }

  // 若偏好都沒有，就退回第一個可 generateContent 的模型
  if (supported.length > 0) return supported[0];

  throw new Error("No available Gemini model supports generateContent.");
}

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
    const errMsg = data?.error?.message || `Gemini API error (${r.status})`;
    const err = new Error(errMsg);
    err.status = r.status;
    err.payload = data;
    throw err;
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.output ||
    "";

  if (!text) {
    throw new Error("Gemini returned empty content.");
  }

  return { text, raw: data };
}

/**
 * ===== API =====
 */
app.post("/api/interpret", rateLimit, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Missing GEMINI_API_KEY",
        message: "伺服器尚未設定 Gemini API 金鑰"
      });
    }

    const prompt = String(req.body?.prompt || "").trim();
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

    // 1) 優先使用指定模型（環境變數）
    // 2) 失敗時自動探測可用模型重試一次
    let modelUsed = DEFAULT_MODEL;
    let result;

    try {
      result = await generateWithGemini({
        apiKey: GEMINI_API_KEY,
        model: modelUsed,
        prompt
      });
    } catch (firstErr) {
      // 常見 404 / model not found -> fallback
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
      modelUsed
    });
  } catch (err) {
    const status = Number(err.status) || 500;
    const safeMessage =
      err?.message || "Unknown server error";

    return res.status(status).json({
      error: "AI_API_ERROR",
      message: safeMessage,
      details: err?.payload?.error || null
    });
  }
});

/**
 * 健康檢查（可選）
 */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
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