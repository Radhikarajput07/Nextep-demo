// Vercel serverless function: NexStep AI doubt solver.
// The Gemini API key lives ONLY in Vercel Environment Variables (GEMINI_API_KEY), never in the page.
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.1-flash-lite', 'gemini-3-flash', 'gemini-2.5-flash-lite'].filter(Boolean);

const SYSTEM = `You are NexStep AI, a friendly DSA and programming doubt solver inside NexStep, a prep platform for engineering students.
- Answer only study-related questions: DSA, programming (C, C++, Java, Python, JavaScript), web dev, basic AI/ML, interview and placement prep, and how to plan prep. Politely decline anything else in one line.
- Reply in the same language style the student uses (English, Hindi or Hinglish).
- Keep answers short (under 180 words). Explain the idea first, then a small code snippet in a fenced code block if useful, then 1-2 practice problems by name.
- Never invent facts. If unsure, say so. Do not claim to be a human.
- The student's progress is given as context. Use it lightly (for example, suggest a next problem), without repeating it back.`;

const hits = new Map(); // tiny per-instance rate limit: 20 requests / 10 min / IP
function limited(ip){
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many questions, try again in a few minutes.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
  const contents = msgs
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text.slice(0, 1200) }] }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') return res.status(400).json({ error: 'No question' });

  const ctx = body.context || {};
  const solved = Array.isArray(ctx.solved) ? ctx.solved.slice(0, 40).map(s => String(s).slice(0, 60)).join(', ') : '';
  const system = SYSTEM + `\n\nStudent progress: solved ${solved ? solved : 'nothing yet'}.` +
    (ctx.weakest ? ` Weakest topic: ${String(ctx.weakest).slice(0, 40)}.` : '');

  let lastErr = 'unknown';
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: 700, temperature: 0.5 }
        })
      });
      if (!r.ok) { lastErr = model + ' ' + r.status; continue; }
      const data = await r.json();
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts.map(p => p.text || '').join('');
      if (text && text.trim()) return res.status(200).json({ reply: text.trim(), model });
      lastErr = model + ' empty';
    } catch (e) { lastErr = model + ' ' + (e && e.message); }
  }
  return res.status(502).json({ error: 'AI unavailable', detail: lastErr });
};
