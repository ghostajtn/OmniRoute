// How widely a story is covered. The same-story check sees every outlet's version of a
// story it already posted; when many outlets carry one story within hours, it is usually
// big news, and the bot says so once.

const HOUR_MS = 60 * 60 * 1000;
export const WIDELY_REPORTED_OUTLETS = 5;
const ALERT_WINDOW_MS = 6 * HOUR_MS;
const KEEP_MS = 24 * HOUR_MS;

/** Record that `item` (another outlet's version) covers the posted `story`. */
export function noteCoverage(state, story, item, now = Date.now()) {
  state.coverage ||= {};
  const entry = (state.coverage[story.link] ||= {
    title: story.title,
    link: story.link,
    first: now,
    sources: [story.source].filter(Boolean),
    alerted: false,
  });
  const source = item.source || item.feedName;
  if (source && !entry.sources.includes(source)) entry.sources.push(source);
}

/** Stories that just reached WIDELY_REPORTED_OUTLETS outlets, and haven't been flagged. */
export function widelyReported(state, now = Date.now()) {
  return Object.values(state.coverage || {}).filter(
    (entry) =>
      !entry.alerted &&
      entry.sources.length >= WIDELY_REPORTED_OUTLETS &&
      now - entry.first <= ALERT_WINDOW_MS
  );
}

/** Outlet counts by story link, for the web app. */
export function outletCounts(state) {
  return new Map(Object.values(state.coverage || {}).map((e) => [e.link, e.sources.length]));
}

export function pruneCoverage(state, now = Date.now()) {
  for (const [link, entry] of Object.entries(state.coverage || {})) {
    if (now - entry.first > KEEP_MS) delete state.coverage[link];
  }
}
