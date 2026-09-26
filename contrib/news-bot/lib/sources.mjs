// Default news sources. Everything here is free and needs no API key.
// Override or extend with a JSON file (NEWS_BOT_CONFIG) or NEWS_BOT_EXTRA_PEOPLE.

export const CATEGORIES = {
  breaking: { label: "Top Stories", emoji: "🚨", color: 0xe74c3c },
  world: { label: "World", emoji: "🌍", color: 0x3498db },
  markets: { label: "Markets & Business", emoji: "💹", color: 0x2ecc71 },
  people: { label: "Watchlist", emoji: "🗣️", color: 0x9b59b6 },
  official: { label: "Official Statements", emoji: "🏛️", color: 0x34495e },
  trump: { label: "Trump on Truth Social", emoji: "🇺🇸", color: 0xe67e22 },
  predictions: { label: "What Could Happen", emoji: "🔮", color: 0x1abc9c },
  calendar: { label: "Market-Moving Events", emoji: "📅", color: 0xf1c40f },
  prices: { label: "Market Snapshot", emoji: "📊", color: 0x16a085 },
  outlook: { label: "AI Outlook", emoji: "🧠", color: 0x95a5a6 },
};

// Ceremonial White House posts ("National Hunting and Fishing Day, 2026") that never move markets.
const CEREMONIAL = /^presidential message\b|\b(?:day|week|month|anniversary),? \d{4}$/i;
const fed = (feed) => `https://www.federalreserve.gov/feeds/${feed}.xml`;

// Primary sources: what the Fed, the White House and the ECB say, straight from them.
export const OFFICIAL_FEEDS = [
  { id: "fed-policy", name: "Federal Reserve", url: fed("press_monetary") },
  { id: "fed-speeches", name: "Fed speeches", url: fed("speeches") },
  { id: "fed-testimony", name: "Fed testimony", url: fed("testimony") },
  {
    id: "white-house",
    name: "White House",
    url: "https://www.whitehouse.gov/news/feed/",
    exclude: CEREMONIAL,
  },
  {
    id: "white-house-actions",
    name: "White House · Presidential actions",
    url: "https://www.whitehouse.gov/presidential-actions/feed/",
    exclude: CEREMONIAL,
  },
  { id: "ecb", name: "European Central Bank", url: "https://www.ecb.europa.eu/rss/press.html" },
].map((feed) => ({ ...feed, category: "official" }));

export const NEWS_FEEDS = [
  {
    id: "google-top",
    category: "breaking",
    name: "Google News",
    url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  },
  {
    id: "bbc-world",
    category: "world",
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
  },
  { id: "npr", category: "world", name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  {
    id: "aljazeera",
    category: "world",
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
  },
  {
    id: "cnbc",
    category: "markets",
    name: "CNBC",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
  },
  {
    id: "marketwatch",
    category: "markets",
    name: "MarketWatch",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  },
  {
    id: "google-business",
    category: "markets",
    name: "Google News Business",
    url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
  },
  {
    id: "seeking-alpha",
    category: "markets",
    name: "Seeking Alpha",
    url: "https://seekingalpha.com/market_currents.xml",
  },
  ...OFFICIAL_FEEDS,
];

// Trump's Truth Social posts, mirrored as RSS by trumpstruth.org.
export const TRUMP_FEED = {
  id: "truth-social",
  category: "trump",
  name: "Truth Social",
  url: "https://www.trumpstruth.org/feed",
};

// People whose words move markets. `query` is a Google News search; the bot adds
// a 1-day time window. Add your own with NEWS_BOT_EXTRA_PEOPLE="Name, Other Name".
// A story is only kept when its headline `mentions` the person (by default, their last
// name): searches also return pages that merely mention them somewhere in the text.
export const WATCHLIST = [
  {
    name: "Donald Trump",
    query: '"Trump" (says OR said OR announces OR warns OR threatens)',
    mentions: ["Trump"],
  },
  { name: "Elon Musk", query: '"Elon Musk"', mentions: ["Musk"] },
  {
    name: "Warren Buffett",
    query: '"Warren Buffett" OR "Berkshire Hathaway"',
    mentions: ["Buffett", "Berkshire"],
  },
  {
    name: "Federal Reserve",
    query: '"Fed chair" OR "Federal Reserve" (rates OR says)',
    mentions: ["Fed", "Federal Reserve", "Powell", "FOMC"],
  },
  {
    name: "US Treasury",
    query: '"Treasury Secretary"',
    mentions: ["Bessent", "Treasury Secretary", "Treasury chief"],
  },
  { name: "Jamie Dimon", query: '"Jamie Dimon"', mentions: ["Dimon"] },
  { name: "Bill Ackman", query: '"Bill Ackman"', mentions: ["Ackman", "Pershing Square"] },
  { name: "Michael Burry", query: '"Michael Burry"', mentions: ["Burry"] },
  { name: "Ray Dalio", query: '"Ray Dalio"', mentions: ["Dalio", "Bridgewater"] },
  { name: "Cathie Wood", query: '"Cathie Wood"', mentions: ["Cathie Wood", "ARK Invest"] },
  { name: "Larry Fink", query: '"Larry Fink"', mentions: ["Fink", "BlackRock"] },
  { name: "Jensen Huang", query: '"Jensen Huang"', mentions: ["Huang"] },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A whole-word match for any of the names, accented letters included. Short names such
 * as "Fed" or "FOMC" must match their capitals ("fed up" is not the Fed); longer names
 * match in any case.
 */
export function mentionPattern(names) {
  const pattern = (list, flags) =>
    list.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${list
            .map((n) => escapeRegExp(n.trim()).replace(/\s+/g, "\\s+"))
            .join("|")})(?![\\p{L}\\p{N}])`,
          flags
        )
      : null;
  const exact = pattern(
    names.filter((n) => n.trim().length <= 4),
    "u"
  );
  const loose = pattern(
    names.filter((n) => n.trim().length > 4),
    "iu"
  );
  return { test: (text) => Boolean(exact?.test(text) || loose?.test(text)) };
}

/** Whether a story from this feed is worth keeping, judged by its headline. */
export function feedAccepts(feed, title) {
  if (typeof feed.exclude?.test === "function" && feed.exclude.test(title)) return false;
  return typeof feed.mentions?.test !== "function" || feed.mentions.test(title);
}

export function googleNewsSearchUrl(query, window = "1d") {
  const q = `${query} when:${window}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

/** Build the full list of feeds (general news + one Google News search per person). */
export function buildFeedList({ feeds = NEWS_FEEDS, people = WATCHLIST, trump = true } = {}) {
  const list = [...feeds];
  if (trump) list.push(TRUMP_FEED);
  for (const person of people) {
    // NEWS_BOT_CONFIG may give one name as a string, or junk; fall back to the last name.
    const listed = [person.mentions].flat().filter((n) => typeof n === "string" && n.trim());
    const names = listed.length ? listed : [person.name.trim().split(/\s+/).pop()];
    list.push({
      id: `person:${person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      category: "people",
      name: person.name,
      person: person.name,
      url: googleNewsSearchUrl(person.query || `"${person.name}"`),
      mentions: mentionPattern(names),
    });
  }
  return list;
}

// Words that usually mean a headline could move prices.
const MARKET_MOVING =
  /\b(tariffs?|rate (?:cut|hike)s?|interest rates?|inflation|cpi|jobs report|recession|sanctions?|stake|buys|bought|sells|sold|dumps|earnings|guidance|layoffs?|bankrupt(?:cy)?|default|ipo|merger|acquisitions?|acquires?|antitrust|executive order|crash(?:es)?|plunges?|soars?|surges?|rall(?:y|ies)|sell-?off|war|ceasefire|invasion|opec|oil prices?|stimulus|shutdown|debt ceiling|bitcoin|crypto|fomc|open market committee|monetary policy|federal funds)\b/i;

export function isMarketMoving(text) {
  return MARKET_MOVING.test(text || "");
}
