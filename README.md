# Project: Chronoticker

A stock portfolio backtester. Simulate any custom allocation across the last 6 months to 10 years and see how it would have performed against the S&P 500. Configure stocks, weights, lookback window, rebalance cadence, and an optional monthly DCA contribution. Outputs an equity curve, a sortable per-asset breakdown table (start/end prices, asset return, P/L, best performer), and headline performance stats: total return, CAGR, max drawdown, annualized volatility, Sharpe ratio, and best/worst day.

Live historical prices via the public [Yahoo Finance](https://finance.yahoo.com/) chart endpoint with a `corsproxy.io` fallback. Static single-page app — no backend, no API keys. See [`guide.html`](guide.html) for a quick-start walkthrough.
