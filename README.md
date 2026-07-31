# Project: Chronoticker

A stock portfolio backtester. Simulate any custom allocation across the last 6 months to 10 years and see how it would have performed against the S&P 500. Configure stocks, weights, lookback window, rebalance cadence, and an optional monthly DCA contribution. Outputs an equity curve, a sortable per-asset breakdown table (start/end prices, asset return, P/L, best performer), and headline performance stats: total return, CAGR, max drawdown, annualized volatility, Sharpe ratio, and best/worst day.

## Architecture

Static single-page app (vanilla JS + Chart.js) deployed to Netlify, served entirely from CDN. Stock price data is **pre-baked into the repo** and refreshed nightly by a GitHub Action — no live API calls at runtime.

```
GitHub Action (nightly, 02:00 UTC)
    ↓ runs scripts/fetch-data.js
    ↓ fetches the Tiingo API (free token, works from CI IPs)
    ↓ writes data/AAPL.json, data/MSFT.json, … (one per symbol)
    ↓ commits + pushes
        ↓
Netlify auto-deploys
        ↓
Browser reads /data/SYMBOL.json directly (same-origin, on CDN)
```

### Why this architecture

The original design was a Netlify serverless function ([`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js)) that proxied Yahoo Finance live. It works locally, but keyless live stock-data sources have progressively locked out scripted access:

- **Yahoo** rate-limits datacenter IP ranges (Netlify, GitHub runners, Cloudflare) with HTTP 429, and per the yfinance/yahoo-finance2 communities this extends to many residential IPs now too.
- **Stooq** first required a captcha-solved apikey for cloud IPs (early 2026), then put a JavaScript proof-of-work challenge in front of its CSV endpoint (~June 2026) that blocks *all* non-browser clients, apikey or not. This is what killed the nightly refresh between 2026-06-06 and 2026-07-30.
- Public CORS proxies routinely get IP-banned.

There is no reliable keyless path anymore. The current fix: fetch from **Tiingo**, a sanctioned free API with token auth that works identically from any IP. The free tier (50 requests/hour, 1,000/day) dwarfs this project's 12 requests/day, and returns 30+ years of dividend+split-adjusted daily closes. Data is fetched at refresh time and served as static JSON — for a backtester this is the correct architecture anyway, since historical data doesn't change intraday.

### Components

- **[`scripts/fetch-data.js`](scripts/fetch-data.js)** — Node 18+ script that fetches 10 years of daily adjusted-close prices for the canonical symbol list and writes one JSON file per symbol to `data/`. Zero dependencies. Tries Tiingo first, then Yahoo (cookie+crumb, then direct) as emergency fallbacks.
- **[`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml)** — GitHub Action that runs the script daily at 02:00 UTC and auto-commits the refreshed JSON. Manually triggerable via the Actions tab. Needs the `TIINGO_TOKEN` repo secret.
- **[`data/`](data/)** — One `SYMBOL.json` file per stock, structured as `{ symbol, updated, source, rangeDays, timestamps[], closes[] }`. Served as static assets by Netlify.
- **[`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js)** — Legacy runtime fallback in case the static data is missing for a symbol. Best-effort only; its sources rarely work from datacenter IPs anymore.

### Frontend fallback chain

The browser's `fetchYahooSeries` tries sources in this order:

1. **`/data/SYMBOL.json`** — pre-baked static data (primary, bulletproof).
2. **`/api/chart`** — serverless function (rarely succeeds in production from Netlify IPs).
3. **Direct Yahoo** — sometimes works in local dev.
4. **`corsproxy.io`** — last-resort public proxy.

In practice (1) handles every backtest. The remaining steps exist so the UI doesn't break if `data/` happens to be empty during the very first deploy. If the baked data is more than a week stale (i.e. the nightly refresh is failing), the UI shows a staleness warning after each backtest.

## Setup (one-time)

1. Sign up for a free Tiingo account at [tiingo.com](https://www.tiingo.com) and copy your API token from [tiingo.com/account/api/token](https://www.tiingo.com/account/api/token).

2. Add it as a repo secret (paste the token when prompted):

```bash
gh secret set TIINGO_TOKEN
```

3. Trigger the first refresh — it fetches the full 10-year history for every symbol and commits it:

```bash
gh workflow run "Refresh stock data"
```

After that, the GitHub Action takes over — it'll refresh and auto-commit nightly. You can also run the script locally with `TIINGO_TOKEN=... node scripts/fetch-data.js`.

> **Note:** Tiingo's free tier is licensed for personal/internal use and prohibits redistributing the data. Committing the JSON to a public repo is a gray area — keep the repo private if that matters to you.

## Development

To run locally:

```bash
# Open index.html in any browser, or:
python3 -m http.server 8000
# → http://localhost:8000
```

The pre-baked data path works locally as long as `data/` is populated (it's committed to the repo). No build step required — vanilla JS, no bundler.

See [`guide.html`](guide.html) for a quick-start walkthrough of the UI and metrics.
