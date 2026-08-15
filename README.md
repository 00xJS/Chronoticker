# Project: Chronoticker

A portfolio backtester. Describe an allocation — holdings, weights, money in, over what period — and it replays that portfolio against real daily closing prices, then tells you how much of the result was the allocation and how much was the start date.

Static single-page app, vanilla JS, no build step, no backend, no runtime API calls. Prices are pre-baked into the repo and refreshed by scheduled GitHub Actions.

## What it measures

- **Two returns, kept apart.** Time-weighted growth rate (how the *strategy* did, immune to contribution timing) and money-weighted IRR (how *your dollars* did). Conflating these is the classic backtest lie.
- **Risk on the strategy, not the balance.** Drawdown, volatility, Sharpe and best/worst day are computed on a per-unit NAV index, so a deposit can never look like a gain.
- **Sharpe against real cash.** Excess return over the actual Treasury-bill rate of the day, not over an assumed 0%.
- **Real or nominal.** Restate any run in today's purchasing power using CPI.
- **Costs and fees.** Basis points per trade plus an annual fee, accrued daily.
- **A base rate, not an anecdote.** Every run is replayed from every other start date the data allows, with a win rate and a distribution — plus an explicit warning when there is not enough independent history to make that number mean anything.
- **Measured selection bias.** The tool computes and states how rigged its own megacap menu is instead of only warning about it in prose.
- **A century of history.** A daily total-return US market index back to 1 July 1926, so 1929, 1973–74, 2000 and 2008 are inside the tool rather than outside it.
- **All at once vs. spread out.** Same money, same window, with idle cash earning the real T-bill rate.

Every run is a URL. Copy the link, get the run.

## Architecture

```
GitHub Action (nightly 02:00 UTC)        GitHub Action (weekly, Sun 03:30 UTC)
    ↓ scripts/fetch-data.js                  ↓ scripts/fetch-macro.js
    ↓ Tiingo (token, 1990→today)             ↓ Ken French + FRED (keyless)
    ↓ data/AAPL.json, data/SPY.json…         ↓ data/USMKT.json, RF.json, CPI.json
                    ↓                                    ↓
              scripts/verify-data.js  ← the gate; also writes data/manifest.json
                    ↓
              scripts/replay.mjs      ← goldens must still pass
                    ↓
              commit + push → Netlify auto-deploys
                    ↓
      Browser reads /data/*.json directly (same-origin, on CDN)
```

### Why pre-baked data

Keyless live stock-data sources have progressively locked out scripted access: Yahoo rate-limits datacenter IPs, and Stooq put a JavaScript proof-of-work challenge in front of its CSV endpoint in June 2026 that blocks all non-browser clients. That killed the nightly refresh for eight weeks and nothing noticed, because nothing was checking the files on disk.

The fix was two-part: fetch from **Tiingo** (sanctioned free API, token auth, works from any IP), and add a **validation gate** so a stalled upstream can never again pass as a green run. For a backtester this architecture is correct anyway — historical data does not change intraday.

### Files

| Path | What it is |
|---|---|
| [`index.html`](index.html) | The app. UI only — all maths lives in the engine. |
| [`guide.html`](guide.html) | Plain-language explanation of every number and every omission. |
| [`assets/engine.js`](assets/engine.js) | The simulation and measurement core. ES module, zero deps, imported by both the browser and the test harness — so the site and the tests cannot disagree. |
| [`assets/deck.css`](assets/deck.css) | Observation Deck theme + components, shared by both pages. |
| [`data/catalog.json`](data/catalog.json) | The instrument registry. **Single source of truth** — the menu and the fetch scripts both read it. |
| [`data/manifest.json`](data/manifest.json) | Which instruments actually have data. Generated; the app falls back to probing if it is missing. |
| [`scripts/fetch-data.js`](scripts/fetch-data.js) | Prices from Tiingo, 1990→today, schema v1. Refuses to shrink a file. |
| [`scripts/fetch-macro.js`](scripts/fetch-macro.js) | The deep index, risk-free rate and CPI. Keyless. |
| [`scripts/verify-data.js`](scripts/verify-data.js) | Validation gate: shape, consistency, catalog agreement, staleness. |
| [`scripts/replay.mjs`](scripts/replay.mjs) | Golden scenarios + property tests. |
| [`scripts/migrate-schema.js`](scripts/migrate-schema.js) | One-shot old→v1 migration. Idempotent. |
| [`scripts/serve.mjs`](scripts/serve.mjs) | Local static server. |
| [`tests/goldens.json`](tests/goldens.json) | Recorded output. A value moving is either an intended fix or a regression. |

### Data schema v1

```jsonc
{
  "schema": 1,
  "id": "SPY", "name": "S&P 500",
  "class": "etf",           // equity | etf | index | rate | deflator
  "calendar": "sessions",   // drives the annualization factor
  "returns": "total",       // total | price — honest labelling; GLD and DBC are price-only
  "currency": "USD",
  "source": "tiingo",
  "updated": "2026-08-15T04:08:45Z",
  "count": 2514, "firstDate": "2016-08-15", "lastDate": "2026-08-14",
  "timestamps": [ /* unix SECONDS, midnight UTC, strictly ascending */ ],
  "closes":     [ /* parallel array */ ]
}
```

## Development

```bash
node scripts/serve.mjs
```

Then open <http://localhost:8177>. Opening `index.html` as a `file://` URL no longer works — the app is an ES module and browsers refuse cross-origin module loads from the filesystem.

Before and after any change to the engine:

```bash
node scripts/replay.mjs
```

Ten golden scenarios and nine property tests. The load-bearing one is `contribution-invariance`: the size of your monthly deposit must have *zero* effect on growth rate, volatility, Sharpe or drawdown. That single assertion is the entire bug class this rebuild fixed, and it fails loudly on the old implementation.

If a change is an intended fix, re-record and say which values moved and why:

```bash
node scripts/replay.mjs --record
```

Check the data at any time:

```bash
node scripts/verify-data.js
```

## Setup

1. Free Tiingo account at [tiingo.com](https://www.tiingo.com), token from [tiingo.com/account/api/token](https://www.tiingo.com/account/api/token).

2. Add it as a repo secret:

```bash
gh secret set TIINGO_TOKEN
```

3. Backfill. The catalog lists ~41 instruments and only 12 have ever been fetched, so the first run pulls a lot:

```bash
gh workflow run "Refresh stock data"
```

4. The macro series need no secret:

```bash
gh workflow run "Refresh macro data"
```

## Data licensing — unresolved, read before making this public

Two of the three sources carry redistribution questions that committing data to a public repo does not obviously satisfy:

- **Tiingo's free tier** is documented as internal, personal use — [their terms](https://app.tiingo.com/tos/) describe the data as for your own use and not for sharing with another person or organization. Serving it publicly as static JSON is at best a gray area, and it scales with the instrument count.
- **The Fama/French data library** is free to download and marked `Copyright Eugene F. Fama and Kenneth R. French`, with no explicit redistribution grant. What is committed here is a derived cumulative index rather than the source file, which is not the same thing as permission.
- **FRED** series used here are US government statistics and the least constrained of the three, but attribution is expected.

Options, none of which this repo has picked for you: pay for redistribution rights, keep the repo and site private, move the committed layer to sources that clearly permit redistribution, or have visitors supply their own API token. Worth resolving deliberately.
