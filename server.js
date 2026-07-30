const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/interpret", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).send("Missing prompt");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).send("Missing GEMINI_API_KEY");

    const model = "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, topP: 0.9, maxOutputTokens: 800 }
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "（AI 未返回內容）";
    res.json({ text });
  } catch (e) {
    res.status(500).send(`Server error: ${e.message}`);
  }
});

// SPA fallback
app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on ${port}`));