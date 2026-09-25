// Optional AI "what could happen next" analysis. Works with any OpenAI-compatible
// endpoint — e.g. a local OmniRoute at http://localhost:20128/v1 — and is skipped
// entirely when LLM_BASE_URL / LLM_MODEL are not set.

import { formatPct } from "./markets.mjs";

const SYSTEM_PROMPT = [
  "You are a sharp, neutral news and markets analyst writing for a Discord channel.",
  "From the headlines and prediction-market odds you are given, list the 5 most important",
  "things that could plausibly happen next (days to weeks). For each: one bold headline-style",
  "line, a likelihood tag (Low / Medium / High), one sentence of reasoning that cites the",
  "headline or odds it comes from, and the likely market impact (sectors, assets or tickers).",
  "Do not invent facts beyond the input. Keep the whole answer under 1500 characters.",
  "Plain Discord markdown only, no tables. This is not financial advice.",
].join(" ");

export function buildOutlookPrompt(headlines, scenarios) {
  const news = headlines
    .slice(-50)
    .map((h) => `- [${h.who || h.category}] ${h.title}`)
    .join("\n");
  const odds = scenarios
    .slice(0, 8)
    .map((s) => {
      const top = s.markets
        .slice(0, 3)
        .map((m) => `${m.label} ${formatPct(m.probability)}`)
        .join(", ");
      return `- ${s.title}: ${top}`;
    })
    .join("\n");
  return `Recent headlines:\n${news || "(none)"}\n\nPrediction-market odds:\n${odds || "(none)"}`;
}

export function isOutlookConfigured(config) {
  return Boolean(config.llmBaseUrl && config.llmModel);
}

export async function generateOutlook(config, headlines, scenarios, fetchImpl = fetch) {
  const url = `${config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (config.llmApiKey) headers.Authorization = `Bearer ${config.llmApiKey}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.4,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildOutlookPrompt(headlines, scenarios) },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`LLM endpoint returned HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("LLM returned an empty answer");
  return text.trim();
}
