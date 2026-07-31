#!/usr/bin/env node
// Fetch 10 years of daily close prices for the canonical Chronoticker
// symbol list and write one JSON file per symbol to ../data/.
//
// Run locally:
//   TIINGO_TOKEN=... node scripts/fetch-data.js
//
// Run in CI:
//   .github/workflows/refresh-data.yml invokes this on a schedule with
//   TIINGO_TOKEN provided as a repo secret.
//
// Sources, in priority order:
//   1. Tiingo        — sanctioned free API, token auth. Works from any
//                      IP including GitHub-hosted runners. Returns
//                      dividend+split-adjusted closes (adjClose).
//   2. Yahoo+crumb   — cookie + crumb auth flow. Emergency fallback;
//                      429s from datacenter IPs and often elsewhere.
//   3. Yahoo direct  — last resort. Frequently 429s.
//
// Stooq was the original source but now serves a JavaScript
// proof-of-work challenge to all non-browser clients (since ~June
// 2026), even with an apikey — it is no longer scriptable.
//
// Requires Node 18+ (built-in fetch). Zero external dependencies.

const fs   = require('fs/promises');
const path = require('path');

const SYMBOLS = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META',
    'TSLA', 'NFLX', 'AMD',  'AVGO',  'SPY',  'QQQ',
];

const RANGE_DAYS = 3653;   // ~10 years
const RANGE_YAHOO = '10y'; // Yahoo's range param for the same window

// Tiingo API token — free tier at https://www.tiingo.com (50 req/hr,
// 1000/day; this script uses 12/day). Set as TIINGO_TOKEN env var
// (locally) or repo secret (CI).
const TIINGO_TOKEN = process.env.TIINGO_TOKEN || '';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,text/csv,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function snippet(s, n = 160) {
    return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

// ── Source 1: Tiingo ────────────────────────────────────────────────
async function fetchTiingo(symbol) {
    if (!TIINGO_TOKEN) throw new Error('Tiingo: TIINGO_TOKEN not set');

    const start = new Date(Date.now() - RANGE_DAYS * 86400000);
    // columns= keeps the response to the fields we read — full rows are
    // ~6x larger and eat into the free tier's monthly bandwidth cap.
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol.toLowerCase())}/prices` +
                `?startDate=${isoDate(start)}&resampleFreq=daily&format=json` +
                `&columns=date,adjClose,close`;

    const res = await fetch(url, {
        headers: {
            'Accept':        'application/json',
            'Authorization': `Token ${TIINGO_TOKEN}`,
        },
    });
    if (!res.ok) {
        const body = snippet(await res.text().catch(() => ''));
        throw new Error(`Tiingo HTTP ${res.status}: "${body}"`);
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
        throw new Error(`Tiingo: empty result: "${snippet(JSON.stringify(rows))}"`);
    }

    const timestamps = [];
    const closes     = [];
    for (const row of rows) {
        const t = Math.floor(Date.parse(row.date) / 1000);
        const c = (row.adjClose != null) ? row.adjClose : row.close;
        if (Number.isFinite(t) && Number.isFinite(c)) {
            timestamps.push(t);
            closes.push(c);
        }
    }
    if (!timestamps.length) throw new Error('Tiingo: no rows parsed');

    return { source: 'tiingo', timestamps, closes };
}

// ── Source 2: Yahoo with cookie + crumb ─────────────────────────────
async function fetchYahooCrumb(symbol) {
    // 1. Get session cookies
    const sessionRes = await fetch('https://fc.yahoo.com', {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
    });
    const rawSetCookie = sessionRes.headers.get('set-cookie') || '';
    const cookies = rawSetCookie
        .split(/,(?=\s*[A-Za-z0-9_!#$&'*+\-.^`|~]+=)/)
        .map(c => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    if (!cookies) throw new Error('Yahoo: no session cookies');

    // 2. Get crumb
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { ...BROWSER_HEADERS, 'Cookie': cookies, 'Referer': 'https://finance.yahoo.com/' },
    });
    if (!crumbRes.ok) throw new Error(`Yahoo crumb HTTP ${crumbRes.status}`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 64) throw new Error(`Yahoo: bad crumb "${snippet(crumb, 40)}"`);

    // 3. Fetch chart with cookie + crumb
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${RANGE_YAHOO}&interval=1d` +
        `&includeAdjustedClose=true&crumb=${encodeURIComponent(crumb)}`;
    const chartRes = await fetch(chartUrl, {
        headers: {
            ...BROWSER_HEADERS,
            'Accept':  'application/json, text/plain, */*',
            'Cookie':  cookies,
            'Referer': 'https://finance.yahoo.com/',
        },
    });
    if (!chartRes.ok) throw new Error(`Yahoo chart HTTP ${chartRes.status}`);
    const json = await chartRes.json();
    return parseYahoo(json, 'yahoo-crumb');
}

// ── Source 3: Yahoo direct (no auth) ────────────────────────────────
async function fetchYahooDirect(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${RANGE_YAHOO}&interval=1d&includeAdjustedClose=true`;
    const res = await fetch(url, {
        headers: {
            ...BROWSER_HEADERS,
            'Accept':  'application/json, text/plain, */*',
            'Referer': 'https://finance.yahoo.com/',
        },
    });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    return parseYahoo(json, 'yahoo-direct');
}

function parseYahoo(json, source) {
    const r = json?.chart?.result?.[0];
    if (!r || !r.timestamp) throw new Error(`${source}: empty result`);
    const ts    = r.timestamp;
    const adj   = r.indicators?.adjclose?.[0]?.adjclose;
    const close = r.indicators?.quote?.[0]?.close;
    const timestamps = [];
    const closes     = [];
    for (let i = 0; i < ts.length; i++) {
        const p = (adj && adj[i] != null) ? adj[i]
                : (close && close[i] != null ? close[i] : null);
        if (p != null) {
            // Yahoo stamps each daily bar at the session open (13:30/14:30
            // UTC); Tiingo (and the old Stooq data) use midnight UTC. Floor
            // to midnight so mixed-source data files stay alignable — the
            // frontend intersects timestamps exactly. US sessions never
            // cross a UTC day boundary, so flooring is safe.
            timestamps.push(ts[i] - (ts[i] % 86400));
            closes.push(p);
        }
    }
    if (!timestamps.length) throw new Error(`${source}: no usable points`);
    return { source, timestamps, closes };
}

async function fetchSymbol(symbol) {
    const errors = [];
    for (const fn of [fetchTiingo, fetchYahooCrumb, fetchYahooDirect]) {
        try {
            return await fn(symbol);
        } catch (err) {
            errors.push(err.message || String(err));
        }
    }
    throw new Error(errors.join(' / '));
}

async function main() {
    const dataDir = path.join(__dirname, '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });

    console.log(`Tiingo token: ${TIINGO_TOKEN ? '✓ present' : '✗ missing (get a free one at https://www.tiingo.com and set TIINGO_TOKEN)'}`);

    // In CI, a missing token must be a hard failure. Falling through to
    // Yahoo could produce a green run that silently masks the missing
    // secret (and commits mixed-provenance data).
    if (!TIINGO_TOKEN && process.env.GITHUB_ACTIONS) {
        console.error('Refusing to run in CI without TIINGO_TOKEN. Set it with: gh secret set TIINGO_TOKEN');
        process.exit(1);
    }

    let success = 0, failed = 0;
    const errors = [];

    for (const symbol of SYMBOLS) {
        try {
            process.stdout.write(`Fetching ${symbol}... `);
            const result = await fetchSymbol(symbol);
            const out = path.join(dataDir, `${symbol}.json`);
            await fs.writeFile(out, JSON.stringify({
                symbol,
                updated:    new Date().toISOString(),
                source:     result.source,
                rangeDays:  RANGE_DAYS,
                timestamps: result.timestamps,
                closes:     result.closes,
            }));
            console.log(`✓ ${result.timestamps.length} pts (${result.source})`);
            success++;
            // Be polite — 1.5s between requests, regardless of source.
            await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
            console.log(`✗ ${err.message}`);
            errors.push(`${symbol}: ${err.message}`);
            failed++;
        }
    }

    console.log(`\n${success} succeeded, ${failed} failed.`);
    if (failed > 0) {
        console.error('\nErrors:');
        errors.forEach(e => console.error(`  ${e}`));
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
