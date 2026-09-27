// Market snapshot: the main US stock indexes, volatility, the 10-year yield, oil, gold, the
// dollar and bitcoin, from Yahoo Finance's public "spark" endpoint (one request, no key).

const MINUTE_MS = 60 * 1000;

/**
 * `alertAt` is the day move that triggers a "big move" alert: percent for prices, basis
 * points for the yield. Futures are shown but never alerted (the index itself is).
 */
export const TICKERS = [
  { symbol: "^GSPC", name: "S&P 500", kind: "index", alertAt: 2 },
  { symbol: "^IXIC", name: "Nasdaq", kind: "index", alertAt: 2.5 },
  { symbol: "^DJI", name: "Dow", kind: "index", alertAt: 2 },
  { symbol: "ES=F", name: "S&P futures", kind: "index" },
  { symbol: "^VIX", name: "VIX", kind: "volatility", alertAt: 20 },
  { symbol: "^TNX", name: "10-yr yield", kind: "yield", alertAt: 15 },
  { symbol: "CL=F", name: "Oil", kind: "dollars", alertAt: 5 },
  { symbol: "GC=F", name: "Gold", kind: "dollars", alertAt: 3 },
  { symbol: "DX-Y.NYB", name: "Dollar", kind: "level", alertAt: 1 },
  { symbol: "BTC-USD", name: "Bitcoin", kind: "dollars", alertAt: 5 },
];

const MAX_POINTS = 32;

export function sparkUrl(tickers = TICKERS) {
  const symbols = tickers.map((t) => encodeURIComponent(t.symbol)).join(",");
  return `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=15m`;
}

function downsample(values, max) {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]);
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Turn the spark response into one quote per ticker, skipping any without a price. */
export function parseSpark(data, tickers = TICKERS) {
  const quotes = [];
  for (const ticker of tickers) {
    const raw = data?.[ticker.symbol];
    const price = Number(raw?.fulldayPrice);
    const previous = Number(raw?.previousClose ?? raw?.chartPreviousClose);
    if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) continue;
    const change = price - previous;
    const points = (Array.isArray(raw.close) ? raw.close : []).filter(Number.isFinite);
    // `end` is when the session ends, not when the last price came in.
    const times = (Array.isArray(raw.timestamp) ? raw.timestamp : []).filter(Number.isFinite);
    const asOf = (times.length ? Math.max(...times) : Number(raw.end)) * 1000 || 0;
    quotes.push({
      symbol: ticker.symbol,
      name: ticker.name,
      kind: ticker.kind,
      price: round(price, 4),
      change: round(change, 4),
      changePct: round((change / previous) * 100, 2),
      asOf,
      points: downsample(points, MAX_POINTS).map((p) => round(p, 4)),
    });
  }
  return quotes;
}

export async function fetchQuotes(httpGet, tickers = TICKERS) {
  return parseSpark(JSON.parse(await httpGet(sparkUrl(tickers))), tickers);
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "7,743", "$92.41", "5.18%", "14.87". */
export function formatPrice(quote) {
  const { kind, price } = quote;
  if (kind === "yield") return `${price.toFixed(2)}%`;
  if (kind === "dollars")
    return price >= 1000 ? USD.format(Math.round(price)).replace(/\.00$/, "") : USD.format(price);
  if (kind === "index") return Math.round(price).toLocaleString("en-US");
  return price.toFixed(2);
}

/** How far it moved today, in the unit its alerts use: bp for the yield, % otherwise. */
export function moveSize(quote) {
  return quote.kind === "yield" ? quote.change * 100 : quote.changePct;
}

/** "+0.51%", "−2.30%", "+2 bp". */
export function formatMove(quote) {
  const size = moveSize(quote);
  const sign = size > 0 ? "+" : size < 0 ? "−" : "";
  const abs = Math.abs(size);
  return quote.kind === "yield" ? `${sign}${Math.round(abs)} bp` : `${sign}${abs.toFixed(2)}%`;
}

/**
 * Quotes that made a big move since the last alert. Each ticker alerts once per trading
 * day and direction, again only if the move doubles, and never on stale prices (such as
 * Friday's close seen on a Saturday).
 */
export function detectBigMoves(quotes, alerted = {}, { now = Date.now(), tickers = TICKERS } = {}) {
  const moves = [];
  // Remember alerts for a few days, so a move that fades and comes back isn't re-sent.
  const keepFrom = new Date(now - 3 * 24 * 60 * MINUTE_MS).toISOString().slice(0, 10);
  const next = Object.fromEntries(
    Object.entries(alerted).filter(([key]) => key.split(":").at(-2) >= keepFrom)
  );
  for (const quote of quotes) {
    const ticker = tickers.find((t) => t.symbol === quote.symbol);
    if (!ticker?.alertAt || now - quote.asOf > 30 * MINUTE_MS) continue;
    const size = moveSize(quote);
    const level = Math.floor(Math.abs(size) / ticker.alertAt);
    if (level < 1) continue;
    const key = `${quote.symbol}:${new Date(quote.asOf).toISOString().slice(0, 10)}:${size > 0 ? "up" : "down"}`;
    if (level > (next[key] || 0)) {
      next[key] = level;
      moves.push(quote);
    }
  }
  return { moves, alerted: next };
}

export function quoteLine(quote) {
  const size = moveSize(quote);
  const arrow = size > 0 ? "🟢" : size < 0 ? "🔴" : "⚪";
  return `${arrow} **${quote.name}** ${formatPrice(quote)} (${formatMove(quote)})`;
}
