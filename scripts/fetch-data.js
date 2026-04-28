#!/usr/bin/env node
// Fetch 10 years of daily close prices for the canonical Chronoticker
// symbol list and write one JSON file per symbol to ../data/.
//
// Run locally:
//   node scripts/fetch-data.js
//
// Run in CI:
//   .github/workflows/refresh-data.yml invokes this on a schedule.
//
// Sources, in priority order:
//   1. Stooq        — keyless CSV. Works from residential and CI IPs.
//                     (Cloud IPs get a captcha gate, so this script
//                      only runs from non-cloud IPs by design.)
//   2. Yahoo+crumb  — cookie + crumb auth flow. Fallback when Stooq
//                     misses a symbol or rate-limits.
//   3. Yahoo direct — last resort. Frequently 429s.
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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,text/csv,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

function ymd(date) {
    return `${date.getUTCFullYear()}` +
           `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
           `${String(date.getUTCDate()).padStart(2, '0')}`;
}

function snippet(s, n = 160) {
    return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

// ── Source 1: Stooq ─────────────────────────────────────────────────
async function fetchStooq(symbol) {
    const end   = new Date();
    const start = new Date(end.getTime() - RANGE_DAYS * 86400000);
    const url   = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us` +
                  `&d1=${ymd(start)}&d2=${ymd(end)}&i=d`;

    const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, 'Referer': 'https://stooq.com/' },
    });
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);

    const body = (await res.text()).trim();
    if (!body) throw new Error('Stooq: empty body');
    if (/^</.test(body)) throw new Error(`Stooq: HTML response: "${snippet(body)}"`);
    if (/get your apikey/i.test(body)) {
        throw new Error('Stooq: captcha gate (cloud-IP detected)');
    }
    if (/^no data/i.test(body) || body.length < 30) {
        throw new Error(`Stooq: no-data: "${snippet(body)}"`);
    }

    const lines  = body.split(/\r?\n/);
    const header = lines[0].split(',').map(s => s.trim().toLowerCase());
    const dateIdx  = header.indexOf('date');
    const closeIdx = header.indexOf('close');
    if (dateIdx < 0 || closeIdx < 0) {
        throw new Error(`Stooq: bad header: "${snippet(body)}"`);
    }

    const timestamps = [];
    const closes     = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(',');
        const ds = cells[dateIdx];
        const cs = cells[closeIdx];
        if (!ds || !cs) continue;
        const t = Math.floor(new Date(`${ds}T00:00:00Z`).getTime() / 1000);
        const c = parseFloat(cs);
        if (Number.isFinite(t) && Number.isFinite(c)) {
            timestamps.push(t);
            closes.push(c);
        }
    }
    if (!timestamps.length) throw new Error('Stooq: no rows parsed');

    return { source: 'stooq', timestamps, closes };
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
            timestamps.push(ts[i]);
            closes.push(p);
        }
    }
    if (!timestamps.length) throw new Error(`${source}: no usable points`);
    return { source, timestamps, closes };
}

async function fetchSymbol(symbol) {
    const errors = [];
    for (const fn of [fetchStooq, fetchYahooCrumb, fetchYahooDirect]) {
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
