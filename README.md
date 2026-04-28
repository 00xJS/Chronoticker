# Project: Chronoticker

A stock portfolio backtester. Simulate any custom allocation across the last 6 months to 10 years and see how it would have performed against the S&P 500. Configure stocks, weights, lookback window, rebalance cadence, and an optional monthly DCA contribution. Outputs an equity curve, a sortable per-asset breakdown table (start/end prices, asset return, P/L, best performer), and headline performance stats: total return, CAGR, max drawdown, annualized volatility, Sharpe ratio, and best/worst day.

## Architecture

Static single-page app (vanilla JS + Chart.js) deployed to Netlify, with a small serverless function as the data layer. The function lives at [`netlify/functions/yahoo-chart.js`](netlify/functions/yahoo-chart.js) and proxies the public [Yahoo Finance](https://finance.yahoo.com/) chart endpoint, exposed at `/api/chart?symbol=AAPL&range=1y`.

**Why the proxy:** browsers can't call `query1.finance.yahoo.com` directly (CORS), and public CORS proxies (corsproxy.io, allorigins, etc.) routinely get IP-banned by Yahoo's anti-bot system. Running the proxy on Netlify's edge with a real-looking User-Agent gives Yahoo a normal-browser-shaped request and keeps the project fully keyless — no API keys, no signed requests, no per-user auth.

The frontend tries the own-proxy first, falls back to direct Yahoo (works in local dev), and finally to a public CORS proxy as a last resort.

See [`guide.html`](guide.html) for a quick-start walkthrough of the UI and metrics.
