// Minimal, dependency-free RSS 2.0 / Atom parser. Good enough for news feeds
// (Google News, BBC, CNBC, MarketWatch, Truth Social archive, ...). It only
// extracts the handful of fields the bot needs.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const value = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function unwrapCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function stripHtml(html) {
  const withoutTags = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/a>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withoutTags)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function escapeTagName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTag(block, name) {
  const tag = escapeTagName(name);
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? unwrapCdata(match[1]).trim() : "";
}

function getAttr(block, name, attr) {
  const tag = escapeTagName(name);
  const match = block.match(new RegExp(`<${tag}\\s[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function getAtomLink(block) {
  const links = block.match(/<link\s[^>]*>/gi) || [];
  let fallback = "";
  for (const link of links) {
    const href = link.match(/\bhref\s*=\s*"([^"]*)"/i);
    if (!href) continue;
    const rel = link.match(/\brel\s*=\s*"([^"]*)"/i);
    if (!rel || rel[1] === "alternate") return decodeEntities(href[1]);
    fallback ||= decodeEntities(href[1]);
  }
  return fallback;
}

function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse an RSS or Atom document into a flat list of items.
 * @param {string} xml
 * @returns {{title: string, link: string, guid: string, published: number|null,
 *   summary: string, source: string}[]}
 */
export function parseFeed(xml) {
  if (typeof xml !== "string" || !xml) return [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const isAtom = blocks.length === 0;
  const entries = isAtom ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [] : blocks;

  const items = [];
  for (const block of entries) {
    const title = stripHtml(getTag(block, "title"));
    const link = isAtom
      ? getAtomLink(block)
      : decodeEntities(getTag(block, "link")) || getAttr(block, "link", "href");
    if (!title && !link) continue;

    const guid = decodeEntities(getTag(block, isAtom ? "id" : "guid")) || link;
    const published = parseDate(
      getTag(block, "pubDate") ||
        getTag(block, "published") ||
        getTag(block, "updated") ||
        getTag(block, "dc:date")
    );
    const summary = stripHtml(
      getTag(block, "description") || getTag(block, "summary") || getTag(block, "content")
    );
    const source = stripHtml(getTag(block, "source"));

    items.push({
      title: cleanTitle(title, source),
      link: link.trim(),
      guid,
      published,
      summary,
      source,
    });
  }
  return items;
}

/** Google News appends " - Publisher" to every headline; drop it when we know the publisher. */
export function cleanTitle(title, source) {
  if (source && title.endsWith(` - ${source}`)) {
    return title.slice(0, -(source.length + 3)).trim();
  }
  return title;
}
