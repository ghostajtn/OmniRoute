// Near-duplicate headlines: one story reworded by several outlets, such as
// "Trump rejects Iran proposal to reopen Hormuz" and
// "Trump says he rejects Iran's proposal to reopen Hormuz".

const STOPWORDS = new Set(
  (
    "a an the of to in on for and or at by with from as is are was were be been it its this " +
    "that after over into says said say will would could can may might not no than then about " +
    "amid against up down out new just more most has have had he she they we you i his her " +
    "their our us report reports what who how why when where which there here"
  ).split(" ")
);

function stem(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words that carry a headline's meaning, lower-cased and lightly stemmed. */
export function titleTokens(title) {
  const tokens = new Set();
  const words = String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ");
  for (const word of words) {
    if (word.length > 1 && !STOPWORDS.has(word)) tokens.add(stem(word));
  }
  return tokens;
}

/**
 * Whether two headlines tell the same story: most of their words are shared, or nearly
 * all of the shorter one's are. Very short headlines never match, since a few shared
 * words ("Fed cuts rates") can start very different stories.
 */
export function isSameStory(a, b) {
  const smaller = Math.min(a.size, b.size);
  if (smaller < 4) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  const jaccard = shared / (a.size + b.size - shared);
  return jaccard >= 0.6 || shared / smaller >= 0.85;
}
