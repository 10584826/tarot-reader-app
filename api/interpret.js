module.exports = async function (context, req) {
  try {
    if (req.method !== "POST") {
      context.res = { status: 405, body: "Method Not Allowed" };
      return;
    }

    const { prompt } = req.body || {};
    if (!prompt) {
      context.res = { status: 400, body: "Missing prompt" };
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      context.res = { status: 500, body: "Missing GEMINI_API_KEY" };
      return;
    }

    const model = "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, topP: 0.9, maxOutputTokens: 800 }
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      context.res = { status: geminiRes.status, body: JSON.stringify(data) };
      return;
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "（AI 未返回內容）";
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { text }
    };
  } catch (error) {
    context.res = { status: 500, body: `Server error: ${error.message}` };
  }
};