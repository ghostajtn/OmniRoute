// Discord webhook client: embed builders that respect Discord's size limits, and
// a poster that honours rate limits (429 retry_after + X-RateLimit headers).

const WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

export const LIMITS = {
  embedsPerMessage: 10,
  charsPerMessage: 6000,
  title: 256,
  description: 4096,
  authorName: 256,
  footer: 2048,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  username: 80,
};

export function isValidWebhookUrl(url) {
  return typeof url === "string" && WEBHOOK_RE.test(url.trim());
}

/** Mask the token part of a webhook URL so it never ends up in logs. */
export function redactWebhook(url) {
  return String(url).replace(/(\/webhooks\/\d+\/)[\w-]+/, "$1***");
}

export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Clamp every field of an embed to Discord's limits. */
export function clampEmbed(embed) {
  const out = { ...embed };
  if (out.title) out.title = truncate(out.title, LIMITS.title);
  if (out.description) out.description = truncate(out.description, LIMITS.description);
  if (out.author?.name)
    out.author = { ...out.author, name: truncate(out.author.name, LIMITS.authorName) };
  if (out.footer?.text)
    out.footer = { ...out.footer, text: truncate(out.footer.text, LIMITS.footer) };
  if (out.url && !/^https?:\/\//i.test(out.url)) delete out.url;
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.slice(0, LIMITS.fields).map((f) => ({
      name: truncate(f.name || "​", LIMITS.fieldName),
      value: truncate(f.value || "​", LIMITS.fieldValue),
      inline: Boolean(f.inline),
    }));
  }
  return out;
}

function embedSize(embed) {
  let size = (embed.title || "").length + (embed.description || "").length;
  size += (embed.author?.name || "").length + (embed.footer?.text || "").length;
  for (const f of embed.fields || []) size += f.name.length + f.value.length;
  return size;
}

/** Split embeds into message-sized batches (≤10 embeds and ≤6000 chars each). */
export function chunkEmbeds(embeds) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const raw of embeds) {
    const embed = clampEmbed(raw);
    const s = embedSize(embed);
    if (
      current.length > 0 &&
      (current.length >= LIMITS.embedsPerMessage || size + s > LIMITS.charsPerMessage)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(embed);
    size += s;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordWebhook {
  /**
   * @param {string} url
   * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, dryRun?: boolean,
   *   log?: (msg:string)=>void, maxRetries?: number, gapMs?: number}} [options]
   */
  constructor(url, options = {}) {
    this.url = url?.trim();
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.sleep = options.sleep || sleepMs;
    this.dryRun = Boolean(options.dryRun);
    this.log = options.log || (() => {});
    this.maxRetries = options.maxRetries ?? 5;
    this.gapMs = options.gapMs ?? 400;
    this.sent = 0;
  }

  /**
   * Post one message. Mentions are always disabled so a headline containing
   * "@everyone" can never ping the server.
   */
  async send({ username, content, embeds = [] }) {
    const payload = {
      username: username ? truncate(username, LIMITS.username) : undefined,
      content: content ? truncate(content, 2000) : undefined,
      embeds: embeds.map(clampEmbed),
      allowed_mentions: { parse: [] },
    };

    if (this.dryRun) {
      this.log(`[dry-run] ${JSON.stringify(payload, null, 2)}`);
      this.sent++;
      return;
    }

    const endpoint = `${this.url}${this.url.includes("?") ? "&" : "?"}wait=true`;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this.fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        if (attempt === this.maxRetries) throw new Error(`Discord request failed: ${err.message}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const retryAfter = Number(body.retry_after ?? res.headers.get("retry-after") ?? 1);
        this.log(`Discord rate limit hit, waiting ${retryAfter}s`);
        await this.sleep(Math.ceil(retryAfter * 1000) + 100);
        continue;
      }

      if (res.status >= 500) {
        if (attempt === this.maxRetries) throw new Error(`Discord returned HTTP ${res.status}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Discord rejected the message (HTTP ${res.status}): ${truncate(text, 300)}`
        );
      }

      this.sent++;
      const remaining = res.headers.get("x-ratelimit-remaining");
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
      if (remaining === "0" && Number.isFinite(resetAfter)) {
        await this.sleep(Math.ceil(resetAfter * 1000) + 100);
      } else if (this.gapMs > 0) {
        await this.sleep(this.gapMs);
      }
      return;
    }
    throw new Error("Discord kept rate limiting the webhook; giving up on this message");
  }

  /**
   * Post any number of embeds, split across as many messages as needed.
   * `onSent(count)` is called after each message with how many embeds it carried.
   */
  async sendEmbeds(embeds, { username, content, onSent } = {}) {
    const batches = chunkEmbeds(embeds);
    for (let i = 0; i < batches.length; i++) {
      await this.send({ username, content: i === 0 ? content : undefined, embeds: batches[i] });
      onSent?.(batches[i].length);
    }
    return batches.length;
  }
}
