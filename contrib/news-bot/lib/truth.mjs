// Trump's photo and video posts reach the Truth Social archive's feed with no text at all,
// just "[No Title] - Post from <date>". The archive's page for each post has what the feed
// lacks: whether it is a video or a photo, its caption or transcript, and a preview image.

import { decodeEntities } from "./rss.mjs";

const ARCHIVE_HOST = "www.trumpstruth.org";
const PLACEHOLDER_TITLE = /^\[no title\]/i;
// What the archive says when a post has no caption or transcript.
const GENERIC_TEXT = /^Donald J\. Trump \w+ (?:post|published)\b/i;

export function isMediaOnlyPost(item) {
  return (
    item.category === "trump" &&
    PLACEHOLDER_TITLE.test(item.title || "") &&
    !String(item.summary || "").trim()
  );
}

function metaContent(html, property) {
  const tag = html.match(new RegExp(`<meta[^>]+property="${property}"[^>]*>`, "i"))?.[0];
  const content = tag?.match(/\scontent="([^"]*)"/i)?.[1];
  return content ? decodeEntities(content).trim() : "";
}

/** Read the kind of post, its text and its preview image from an archive page. */
export function parsePostPage(html) {
  const kind = metaContent(html, "og:title").match(/\b(video|image|photo) post\b/i)?.[1];
  const text = metaContent(html, "og:description");
  const image = metaContent(html, "og:image");
  return {
    kind: kind ? (kind.toLowerCase() === "video" ? "video" : "photo") : "",
    text: GENERIC_TEXT.test(text) ? "" : text,
    image: /^https:\/\/[^\s"<>]+$/.test(image) ? image : "",
  };
}

/**
 * Fill in the text-less photo and video posts from their archive pages, in place.
 * A page that can't be read leaves its post as it was.
 */
export async function describeMediaPosts(items, httpGet, { limit = 20 } = {}) {
  const posts = items.filter((item) => {
    if (!isMediaOnlyPost(item)) return false;
    try {
      return new URL(item.link).hostname === ARCHIVE_HOST;
    } catch {
      return false;
    }
  });
  for (const item of posts.slice(0, limit)) {
    try {
      const page = parsePostPage(await httpGet(item.link));
      if (page.kind) item.mediaKind = page.kind;
      if (page.text) item.summary = page.text;
      if (page.image) item.image = page.image;
    } catch {
      // Keep the bare post.
    }
  }
}
