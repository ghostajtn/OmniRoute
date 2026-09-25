# News Radar: a Discord news bot

News Radar posts news to a Discord channel through a webhook. It needs no dependencies and no API keys.

| Channel post                   | What it is                                                                                                                                                        | How often       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 🚨 **Top Stories**             | Google News top headlines                                                                                                                                         | every run       |
| 🌍 **World**                   | BBC World, NPR, Al Jazeera                                                                                                                                        | every run       |
| 💹 **Markets & Business**      | CNBC, MarketWatch, Google News Business, Seeking Alpha                                                                                                            | every run       |
| 🗣️ **Watchlist**               | Coverage of what market movers say and do: Trump, Musk, Buffett, the Fed, the Treasury Secretary, Dimon, Ackman, Burry, Dalio, Cathie Wood, Fink and Jensen Huang | every run       |
| 🇺🇸 **Trump on Truth Social**   | Trump's own posts and re-posts                                                                                                                                    | every run       |
| 🔮 **What Could Happen**       | Live prediction-market odds on the biggest open questions (Fed decisions, elections, wars, recession…), from Polymarket                                           | digest every 6h |
| 🔮 **Odds shift**              | Alert when a market's odds move ≥10 points                                                                                                                        | when it happens |
| 📅 **Market-Moving Events**    | High-impact economic releases in the next 36h (CPI, jobs report, FOMC, central-bank speeches) with forecast and previous values                                   | once a day      |
| 🧠 **AI Outlook** _(optional)_ | An LLM reads recent headlines and odds, then lists 5 things that could happen next and their likely market impact                                                 | every 6h        |

The bot marks headlines that could move prices (tariffs, rate cuts, earnings, sanctions, crashes…) with ⚡.
It drops duplicate stories that appear in more than one feed, never posts the same story twice, and disables @mentions
so a headline can't ping your server.

> Prediction odds and AI outlooks are speculation, not financial advice.

---

## 1. Get a webhook URL

In Discord, open **Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL**.

Treat the URL like a password: anyone who has it can post to the channel. Keep it in an environment variable or
a GitHub secret, never in a committed file. If it leaks, delete the webhook and create a new one.

## 2a. Run it 24/7 for free on GitHub Actions (recommended)

The workflow `.github/workflows/news-bot.yml` runs the bot every 15 minutes.

1. In the repo, open **Settings → Secrets and variables → Actions → New repository secret**.
   Name it `DISCORD_WEBHOOK_URL` and paste the webhook URL as its value.
2. Forks only: open the **Actions** tab and click **"I understand my workflows, go ahead and enable them"**.
3. Make sure the workflow file is on the repo's **default branch**. GitHub only runs scheduled workflows from that branch.
4. Open **Actions → News Bot → Run workflow**. Tick _"Only send a test message"_ to check the webhook first, then
   run it again without the tick to post the first batch of news.

The bot's memory of which stories it already posted is kept between runs in the Actions cache.

Notes:

- Public repos get Actions minutes for free. A private repo uses about 2,900 minutes a month at the
  15-minute schedule, so change the cron to `*/30 * * * *` to stay inside the free tier.
- GitHub may start scheduled runs a few minutes late, and it pauses them after 60 days without repository activity.

## 2b. Or run it on any machine

It needs Node.js 22 or newer and nothing else.

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"

node contrib/news-bot/newsBot.mjs --test            # send a "connected" test message
node contrib/news-bot/newsBot.mjs                   # run forever (checks every 10 min)
node contrib/news-bot/newsBot.mjs --once            # one cycle, for cron / systemd timers
node contrib/news-bot/newsBot.mjs --once --dry-run  # print what would be posted
```

To keep it running in the background, use `pm2 start contrib/news-bot/newsBot.mjs --name news-bot` or
`nohup node contrib/news-bot/newsBot.mjs &`.

On the very first run the bot posts only the 3 newest stories per section, so it doesn't flood the channel with
a day of backlog. After that, it posts every new story.

## 3. Options (environment variables)

| Variable                                   | Default                                | Meaning                                                                                  |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `DISCORD_WEBHOOK_URL`                      | — (required)                           | Where to post                                                                            |
| `NEWS_BOT_EXTRA_PEOPLE`                    | —                                      | More people to follow, comma-separated, e.g. `Nancy Pelosi, Tim Cook`                    |
| `NEWS_BOT_DISABLE`                         | —                                      | Sections to turn off: `breaking,world,markets,people,trump,predictions,calendar,outlook` |
| `NEWS_BOT_INTERVAL_MINUTES`                | `10`                                   | Loop interval when running forever                                                       |
| `NEWS_BOT_MAX_AGE_HOURS`                   | `24`                                   | Ignore stories older than this                                                           |
| `NEWS_BOT_MAX_PER_CATEGORY`                | `15`                                   | Most stories per section per run; the rest are posted on the next run                    |
| `NEWS_BOT_FIRST_RUN_PER_CATEGORY`          | `3`                                    | Stories per section on the very first run                                                |
| `NEWS_BOT_PREDICTIONS_EVERY_HOURS`         | `6`                                    | How often to post the "What could happen" odds digest                                    |
| `NEWS_BOT_PREDICTIONS_COUNT`               | `8`                                    | How many questions the digest shows                                                      |
| `NEWS_BOT_ODDS_ALERT_POINTS`               | `10`                                   | Percentage-point move that triggers an "Odds shift" alert                                |
| `NEWS_BOT_MARKET_TAGS`                     | `politics,economy,finance,geopolitics` | Polymarket topics to follow (e.g. add `crypto`)                                          |
| `NEWS_BOT_TIMEZONE`                        | `America/New_York`                     | Time zone for the calendar                                                               |
| `NEWS_BOT_NAME`                            | `News Radar`                           | Name the bot posts under                                                                 |
| `NEWS_BOT_STATE_FILE`                      | `contrib/news-bot/.state/state.json`   | Where the bot remembers what it already posted                                           |
| `NEWS_BOT_CONFIG`                          | —                                      | Path to a JSON file with extra feeds and people (see below)                              |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | —                                      | Turn on the 🧠 AI outlook (see below)                                                    |
| `NEWS_BOT_OUTLOOK_EVERY_HOURS`             | `6`                                    | How often to post the AI outlook                                                         |

On GitHub Actions, set `NEWS_BOT_EXTRA_PEOPLE`, `NEWS_BOT_DISABLE` and `NEWS_BOT_LLM_MODEL` as repository
**variables**. Set `NEWS_BOT_LLM_BASE_URL` and `NEWS_BOT_LLM_API_KEY` as repository **secrets**.

### Add your own feeds and people

Copy `sources.example.json`, edit it, and point `NEWS_BOT_CONFIG` at your copy. Each feed needs a `category`,
which must be one of `breaking`, `world`, `markets` or `people`. Each person can have a
[Google News search](https://support.google.com/news/publisher-center/answer/9606702) `query`. Without one, the
bot searches for the person's name in quotes. Set `"replaceDefaults": true` to use only your own lists.

### AI "what could happen next" (optional)

Point the bot at any OpenAI-compatible endpoint, for example your own OmniRoute:

```bash
export LLM_BASE_URL="http://localhost:20128/v1"   # OmniRoute, OpenAI, OpenRouter, Ollama…
export LLM_MODEL="auto"                           # any model / combo name the endpoint accepts
export LLM_API_KEY="sk-…"                          # if the endpoint needs one
```

Every 6 hours the bot sends the latest headlines and the prediction-market odds to the model. It posts the
model's list of the 5 most likely next developments, each with a likelihood and its market impact.

## Tests

```bash
node --test contrib/news-bot/test/*.test.mjs
```

## Sources

- Google News RSS. Google allows it for personal, non-commercial use.
- BBC, NPR, Al Jazeera, CNBC, MarketWatch and Seeking Alpha public RSS feeds.
- [trumpstruth.org](https://www.trumpstruth.org), a public archive of Truth Social posts.
- The [Polymarket](https://polymarket.com) public Gamma API.
- The Forex Factory weekly economic calendar (`nfs.faireconomy.media`). The bot fetches it once a day.
