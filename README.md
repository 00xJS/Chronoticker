# Project: Chronoticker

A stock portfolio backtester. Simulate any custom allocation across the last 6 months to 10 years and see how it would have performed against the S&P 500. Configure stocks, weights, lookback window, rebalance cadence, and an optional monthly DCA contribution. Outputs an equity curve, a sortable per-asset breakdown table (start/end prices, asset return, P/L, best performer), and headline performance stats: total return, CAGR, max drawdown, annualized volatility, Sharpe ratio, and best/worst day.

## Architecture

Static single-page app (vanilla JS + Chart.js) deployed to Netlify, served entirely from CDN. Stock price data is **pre-baked into the repo** and refreshed nightly by a GitHub Action — no live API calls at runtime.

```
GitHub Action (nightly, 02:00 UTC)
    ↓ runs scripts/fetch-data.js
    ↓ fetches Yahoo Finance from a clean IP
    ↓ writes data/AAPL.json, data/MSFT.json, … (one per symbol)
    ↓ commits + pushes
        ↓
Netlify auto-deploys
        ↓
Browser reads /data/SYMBOL.json directly (same-origin, on CDN)
```

### Why this architecture

The original design was a Netlify serverless function ([`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js)) that proxied Yahoo Finance live. It works locally, but **all keyless live stock-data sources block cloud IPs** — Yahoo rate-limits Netlify's edges with HTTP 429, Stooq now requires a captcha-solved API key for cloud requests, and public CORS proxies routinely get IP-banned. There is no reliable runtime keyless path for stock data from a serverless function.

The fix: fetch from non-blocked IPs (your laptop or a GitHub Actions runner) at build/refresh time, and serve the result as static JSON. For a backtester this is the correct architecture anyway — historical data doesn't change, so refreshing once per day is plenty.

### Components

- **[`scripts/fetch-data.js`](scripts/fetch-data.js)** — Node 18+ script that fetches 10 years of daily adjusted-close prices for the canonical symbol list and writes one JSON file per symbol to `data/`. Zero dependencies.
- **[`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml)** — GitHub Action that runs the script daily at 02:00 UTC and auto-commits the refreshed JSON. Manually triggerable via the Actions tab.
- **[`data/`](data/)** — One `SYMBOL.json` file per stock, structured as `{ symbol, updated, source, range, timestamps[], closes[] }`. Served as static assets by Netlify.
- **[`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js)** — Kept as a runtime fallback in case the static data is missing for a symbol. Tries Stooq, then Yahoo with cookie+crumb auth, then Yahoo direct. Best-effort only.

### Frontend fallback chain

The browser's `fetchYahooSeries` tries sources in this order:

1. **`/data/SYMBOL.json`** — pre-baked static data (primary, bulletproof).
2. **`/api/chart`** — serverless function (rarely succeeds in production from Netlify IPs).
3. **Direct Yahoo** — sometimes works in local dev.
4. **`corsproxy.io`** — last-resort public proxy.

In practice (1) handles every backtest. The remaining steps exist so the UI doesn't break if `data/` happens to be empty during the very first deploy.

## Setup (one-time)

```bash
# 1. Seed the data folder with initial JSON files. Run from your laptop —
#    your residential IP isn't rate-limited by Yahoo.
node scripts/fetch-data.js

# 2. Commit the data files and push.
git add data/
git commit -m "Seed initial stock data"
git push
```

After that, the GitHub Action takes over — it'll refresh and auto-commit nightly. You can also trigger a manual refresh anytime from the repo's **Actions** tab → "Refresh stock data" → "Run workflow."

## Development

To run locally:

```bash
# Open index.html in any browser, or:
python3 -m http.server 8000
# → http://localhost:8000
```

The pre-baked data path works locally as long as you've run `node scripts/fetch-data.js` at least once. No build step required — vanilla JS, no bundler.

See [`guide.html`](guide.html) for a quick-start walkthrough of the UI and metrics.
