# Project: Chronoticker

A stock portfolio backtester. Simulate any custom allocation across the last 6 months to 10 years and see how it would have performed against the S&P 500. Configure stocks, weights, lookback window, rebalance cadence, and an optional monthly DCA contribution. Outputs an equity curve, a sortable per-asset breakdown table (start/end prices, asset return, P/L, best performer), and headline performance stats: total return, CAGR, max drawdown, annualized volatility, Sharpe ratio, and best/worst day.

## Architecture

Static single-page app (vanilla JS + Chart.js) deployed to Netlify, with a small serverless function as the data layer. The function lives at [`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js) and is exposed at `/api/chart?symbol=AAPL&range=1y`.

**Why the proxy:** browsers can't call stock-data APIs directly (CORS), and public CORS proxies routinely get IP-banned by anti-bot systems. The proxy runs on Netlify's edge with a real-looking User-Agent and keeps the project fully keyless — no API keys, no signed requests, no per-user auth.

**Multi-source fallback (inside the function):**

1. **[Stooq](https://stooq.com/)** — keyless CSV historical data, generous rate limits. Most reliable for US-listed equities and ETFs. Primary source.
2. **[Yahoo Finance](https://finance.yahoo.com/) v8 chart endpoint** — better adjusted-close handling, but rate-limits aggressively from cloud IPs (Yahoo returns HTTP 429 to Netlify edges). Fallback for symbols Stooq doesn't carry.

The function reshapes Stooq CSV into Yahoo's chart-API JSON format, so the frontend doesn't need to know which source actually answered.

**Frontend fallback chain:** the browser tries `/api/chart` first, then direct Yahoo (works in local dev), then a public CORS proxy as last resort.

See [`guide.html`](guide.html) for a quick-start walkthrough of the UI and metrics.
