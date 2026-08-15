#!/usr/bin/env node
// Fetch daily close history for every Tiingo-sourced instrument listed in
// data/catalog.json and write one schema-v1 JSON file per instrument into
// ../data/.
//
// Run locally:
//   TIINGO_TOKEN=... node scripts/fetch-data.js
//   node scripts/fetch-data.js --dry-run        (no network, no writes)
//   TIINGO_TOKEN=... node scripts/fetch-data.js --only=SPY,QQQ
//
// Run in CI:
//   .github/workflows/refresh-data.yml invokes this on a schedule with
//   TIINGO_TOKEN provided as a repo secret.
//
// WHY THIS SCRIPT LOOKS THE WAY IT DOES
//
//   Catalog-driven. data/catalog.json is the single source of truth for
//   which instruments exist; index.html builds its menu from the same
//   file. A hardcoded SYMBOLS array here would be a second, unvalidated
//   list that drifts from the menu the moment either one is edited — so
//   there isn't one. Entries marked "derived": true are produced by
//   fetch-macro.js from published research data (Ken French, FRED) and
//   are deliberately skipped here.
//
//   History starts 1990-01-01, not "the last 10 years". A rolling window
//   truncates every instrument to the same shallow span, which quietly
//   hides the two events a backtester most needs: the dot-com crash and
//   2008. SPY's real history starts 1993, QQQ 1999, the SPDR sectors
//   1998 — all well inside this window. Tiingo returns whatever exists
//   and starts each series at the instrument's own inception, so asking
//   for 1990 costs nothing for younger tickers and buys three extra
//   decades for the older ones. 1990 rather than 1970 because nothing in
//   the catalog predates it and the request should not imply otherwise.
//
//   Never shrink a file silently. An upstream stall that returns a
//   two-row stub is indistinguishable from a successful fetch at the
//   HTTP layer, and the nightly workflow commits whatever lands on disk.
//   Every write is therefore gated against the file it would replace:
//   fewer than 98% of the previous row count, or an older lastDate, and
//   the symbol is refused and counted as a failure. This gate is the
//   only thing standing between a bad upstream day and thirty years of
//   history being replaced by a stub in a commit nobody reads.
//
//   A rewrite is not a refresh. Every record carries an `updated` wall
//   clock stamp, so re-running against unchanged upstream rows used to
//   produce a diff in all ~42 files whose only changed field was that
//   stamp. refresh-data.yml guards against empty commits with
//   `if git diff --staged --quiet`, and the stamp defeated it: the log
//   carried a "Refresh stock data" commit every single day, weekends and
//   market holidays included, when no US equity close could have moved.
//   A write therefore happens only when the payload actually differs
//   from the file it would replace.
//
//   One failure is not the run. A single delisted or mistyped ticker
//   must not cost the other 41 their refresh, so failures are collected
//   per symbol; everything that succeeded is written, and the process
//   exits non-zero with a summary at the end.
//
// SOURCES, in priority order:
//   1. Tiingo        — sanctioned free API, token auth. Works from any
//                      IP including GitHub-hosted runners. Returns
//                      dividend+split-adjusted closes (adjClose).
//   2. Yahoo+crumb   — cookie + crumb auth flow. Emergency fallback;
//                      429s from datacenter IPs and often elsewhere.
//   3. Yahoo direct  — last resort. Frequently 429s.
//
//   Stooq was the original source but now serves a JavaScript
//   proof-of-work challenge to all non-browser clients (since ~June
//   2026), even with an apikey — it is no longer scriptable.
//
//   Budget note: one request per instrument, ~42 today, against a free
//   Tiingo tier of 50 requests/hour and 1000/day. The hourly ceiling is
//   the binding one — adding more than a handful of Tiingo instruments
//   to the catalog will require spreading the run across an hour
//   boundary or a paid tier.
//
// Requires Node 18+ (built-in fetch). Zero external dependencies.

const fs   = require('fs/promises');
const path = require('path');

// ── Configuration ───────────────────────────────────────────────────
const ROOT         = path.join(__dirname, '..');
const DATA_DIR     = path.join(ROOT, 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');

// Deep history. See the header for why this is a fixed date and not a
// rolling window.
const START_DATE  = '1990-01-01';
const START_EPOCH = Math.floor(Date.parse(`${START_DATE}T00:00:00Z`) / 1000);

// Yahoo has no startDate param on the chart endpoint; 'max' plus a
// client-side trim to START_EPOCH is the equivalent request.
const RANGE_YAHOO = 'max';

// A refreshed file may lose up to 2% of its rows — enough slack for an
// upstream removing a handful of bad ticks, nowhere near enough to let a
// stub through.
const SHRINK_TOLERANCE = 0.98;

// A source may legitimately carry no close for a day inside the window —
// a halt, a session nobody printed. It may not carry none for many of
// them: a response that is mostly holes is a broken response, not a quiet
// market. Rows outside the window (Yahoo's pre-1990 history) are trimmed,
// not dropped, and do not count against this.
const MAX_DROPPED_FRACTION = 0.02;

// Be polite — this much delay between symbols, regardless of source.
const DELAY_MS = 1500;

// Tiingo API token — free tier at https://www.tiingo.com. Set as
// TIINGO_TOKEN env var (locally) or repo secret (CI).
const TIINGO_TOKEN = process.env.TIINGO_TOKEN || '';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
    'User-Agent':      UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,text/csv,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

// Instrument ids become filenames. Anything outside this character set
// is rejected rather than joined into a path.
const ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;

// ── Small helpers ───────────────────────────────────────────────────
function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function isoFromEpoch(seconds) {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function snippet(s, n = 160) {
    return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Thrown when an upstream says the ticker itself does not exist, as
// opposed to "the request failed". The catalog now carries symbols that
// have never been fetched, so a typo there must read as a typo and not
// as a network fault.
class NotFoundError extends Error {}

// ── Catalog ─────────────────────────────────────────────────────────
// Read data/catalog.json and return the instruments this script owns:
// source === 'tiingo' and not derived. Everything about the output file
// except the numbers comes from here, so a malformed entry is a hard
// failure of the whole run — it would otherwise mislabel a data file.
async function loadInstruments(only) {
    let catalog;
    try {
        catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Cannot read ${CATALOG_PATH}: ${err.message}`);
    }
    if (catalog.schema !== 1) {
        throw new Error(`catalog.json: unsupported schema ${JSON.stringify(catalog.schema)} (expected 1)`);
    }
    if (!Array.isArray(catalog.instruments) || !catalog.instruments.length) {
        throw new Error('catalog.json: "instruments" is missing or empty');
    }

    const mine = catalog.instruments.filter(e => e && e.source === 'tiingo' && e.derived !== true);
    if (!mine.length) {
        throw new Error('catalog.json: no instruments with source "tiingo"');
    }

    // Validate before fetching anything — a bad entry found after 40
    // requests is 40 wasted requests.
    const problems = [];
    const seen = new Set();
    for (const e of mine) {
        const id = e.id;
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
            problems.push(`bad id ${JSON.stringify(id)} (must match ${ID_PATTERN})`);
            continue;
        }
        if (seen.has(id)) problems.push(`${id}: duplicate id`);
        seen.add(id);
        if (typeof e.name !== 'string' || !e.name) problems.push(`${id}: missing "name"`);
        if (!['equity', 'etf', 'index'].includes(e.class)) {
            problems.push(`${id}: class ${JSON.stringify(e.class)} is not a priced class (equity|etf|index)`);
        }
        if (!['sessions', 'continuous'].includes(e.calendar)) {
            problems.push(`${id}: calendar must be "sessions" or "continuous", got ${JSON.stringify(e.calendar)}`);
        }
        // `returns` is honest labelling, not decoration: GLD and DBC are
        // price-return series and must not be presented as total return.
        if (!['total', 'price'].includes(e.returns)) {
            problems.push(`${id}: returns must be "total" or "price", got ${JSON.stringify(e.returns)}`);
        }
    }
    if (problems.length) {
        throw new Error(`catalog.json is invalid:\n  ${problems.join('\n  ')}`);
    }

    if (!only) return mine;

    const wanted = new Set(only.map(s => s.trim().toUpperCase()).filter(Boolean));
    // `--only=` with nothing after it (an unset shell variable, most
    // likely) must not resolve to "refresh nothing" and exit green.
    if (!wanted.size) {
        throw new Error('--only: no instrument ids given (drop the flag to fetch everything)');
    }
    const picked = mine.filter(e => wanted.has(e.id));
    const missing = [...wanted].filter(id => !picked.some(e => e.id === id));
    if (missing.length) {
        throw new Error(`--only: not a Tiingo instrument in catalog.json: ${missing.join(', ')}`);
    }
    return picked;
}

// ── Source 1: Tiingo ────────────────────────────────────────────────
async function fetchTiingo(symbol) {
    if (!TIINGO_TOKEN) throw new Error('Tiingo: TIINGO_TOKEN not set');

    // columns= keeps the response to the fields we read — full rows are
    // ~6x larger and eat into the free tier's monthly bandwidth cap.
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol.toLowerCase())}/prices` +
                `?startDate=${START_DATE}&endDate=${isoDate(new Date())}` +
                `&resampleFreq=daily&format=json&columns=date,adjClose,close`;

    const res = await fetch(url, {
        headers: {
            'Accept':        'application/json',
            'Authorization': `Token ${TIINGO_TOKEN}`,
        },
    });
    if (res.status === 404) {
        const body = snippet(await res.text().catch(() => ''));
        throw new NotFoundError(`Tiingo does not know the ticker "${symbol}" (HTTP 404: "${body}")`);
    }
    if (!res.ok) {
        const body = snippet(await res.text().catch(() => ''));
        throw new Error(`Tiingo HTTP ${res.status}: "${body}"`);
    }

    const rows = await res.json();
    if (!Array.isArray(rows)) {
        throw new Error(`Tiingo: unexpected response: "${snippet(JSON.stringify(rows))}"`);
    }
    if (!rows.length) {
        throw new Error(`Tiingo: no rows for ${symbol} since ${START_DATE} ` +
                        '(ticker may exist but carry no price history on this plan)');
    }

    // Pick the price column ONCE for the whole series, never per row.
    // adjClose is split- and dividend-adjusted; close is raw. Falling back
    // per row splices raw prices into an adjusted series at exactly the
    // rows where the adjustment is missing, which reads downstream as a
    // real overnight move of several hundred percent and back. If adjClose
    // is absent for the whole response the raw close is a coherent (if
    // unadjusted) series; if it is absent for only some rows those rows
    // are holes, and holes are what MAX_DROPPED_FRACTION is for.
    const useAdj = rows.some(row => Number.isFinite(row.adjClose));
    const points = [];
    let dropped = 0;
    for (const row of rows) {
        const t = Math.floor(Date.parse(row.date) / 1000);
        const c = useAdj ? row.adjClose : row.close;
        if (Number.isFinite(t) && Number.isFinite(c)) points.push([t, c]);
        else dropped++;
    }
    assertCoverage('Tiingo', points.length, rows.length);

    return toSeries('tiingo', points, dropped, useAdj ? 'adjClose' : 'close');
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
    if (chartRes.status === 404) {
        throw new NotFoundError(`Yahoo does not know the ticker "${symbol}" (HTTP 404)`);
    }
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
    if (res.status === 404) {
        throw new NotFoundError(`Yahoo does not know the ticker "${symbol}" (HTTP 404)`);
    }
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
    // Same rule as the Tiingo path: one column for the whole series.
    // Yahoo's adjclose array routinely carries nulls where quote.close is
    // populated, and taking the raw close for just those rows splices an
    // unadjusted price into an adjusted series.
    const useAdj = Array.isArray(adj) && adj.some(v => Number.isFinite(v));
    const column = useAdj ? adj : close;
    if (!Array.isArray(column)) throw new Error(`${source}: no close column in response`);

    const points = [];
    let offered = 0;
    let dropped = 0;
    for (let i = 0; i < ts.length; i++) {
        // Yahoo stamps each daily bar at the session open (13:30/14:30
        // UTC); Tiingo (and the old Stooq data) use midnight UTC. Floor
        // to midnight so mixed-source data files stay alignable — the
        // frontend intersects timestamps exactly. US sessions never
        // cross a UTC day boundary, so flooring is safe.
        const day = ts[i] - (ts[i] % 86400);
        // range=max means Yahoo hands back everything it has; trim to
        // the same window Tiingo was asked for so a source failover
        // cannot change a file's start date. Trimmed rows are outside the
        // window, not missing from it, so they are counted before the
        // coverage test rather than against it.
        if (day < START_EPOCH) continue;
        offered++;
        const p = column[i];
        if (!Number.isFinite(p)) { dropped++; continue; }
        points.push([day, p]);
    }
    if (!offered) throw new Error(`${source}: no rows since ${START_DATE}`);
    assertCoverage(source, points.length, offered);
    return toSeries(source, points, dropped, useAdj ? 'adjclose' : 'close');
}

// A series is only usable if most of the window actually carries a price.
// Without this a source that answers 200 with half its closes nulled out
// produces a file full of holes — and for the thirty catalog symbols that
// have no file yet, the no-shrink gate has no baseline to catch it with.
function assertCoverage(source, kept, offered) {
    if (!kept) throw new Error(`${source}: no rows parsed`);
    const missing = offered - kept;
    if (missing > offered * MAX_DROPPED_FRACTION) {
        throw new Error(`${source}: ${missing} of ${offered} rows in window carried no usable close ` +
                        `(over ${Math.round(MAX_DROPPED_FRACTION * 100)}%) — refusing a series full of holes`);
    }
}

// Sort ascending and split into the two parallel arrays. Upstreams
// happen to return ascending rows today, but nothing in their contract
// promises it, and the schema does. Duplicate timestamps are left in
// place on purpose: validate() rejects them loudly rather than letting
// a de-dupe hide a source serving the same day twice.
function toSeries(source, points, dropped = 0, column = '') {
    points.sort((a, b) => a[0] - b[0]);
    return {
        source,
        // Which upstream column the closes came from, and how many rows in
        // the window had to be skipped. Neither goes in the file; both are
        // printed, because a silent drop is the failure this script is
        // least able to detect on a symbol that has no baseline yet.
        column,
        dropped,
        timestamps: points.map(p => p[0]),
        closes:     points.map(p => p[1]),
    };
}

// ── Source chain ────────────────────────────────────────────────────
async function fetchSymbol(symbol) {
    const errors = [];
    for (const fn of [fetchTiingo, fetchYahooCrumb, fetchYahooDirect]) {
        try {
            return await fn(symbol);
        } catch (err) {
            // A ticker that does not exist will not start existing at the
            // next source. Stop here so a typo in the catalog is reported
            // as a typo instead of as three stacked network errors.
            if (err instanceof NotFoundError) throw err;
            errors.push(err.message || String(err));
        }
    }
    throw new Error(errors.join(' / '));
}

// ── Schema v1 assembly + validation ─────────────────────────────────
// Build the complete record in memory. Nothing touches the disk until
// this has passed validate() and the no-regression gate.
function buildRecord(entry, result) {
    const { timestamps, closes } = result;
    const record = {
        schema:   1,
        id:       entry.id,
        name:     entry.name,
        class:    entry.class,
        calendar: entry.calendar,
        returns:  entry.returns,
        // Every Tiingo instrument in the catalog is US-listed and quoted
        // in USD; the catalog carries no currency field yet, so this is
        // the documented default rather than a guess per symbol.
        currency: entry.currency || 'USD',
        // The actual source that answered, not the catalog's intent — a
        // Yahoo failover must be visible in the file it produced.
        source:   result.source,
        updated:  new Date().toISOString(),
        count:     timestamps.length,
        firstDate: isoFromEpoch(timestamps[0]),
        lastDate:  isoFromEpoch(timestamps[timestamps.length - 1]),
        timestamps,
        closes,
    };
    return record;
}

function validate(record) {
    const problems = [];
    const ts = record.timestamps;
    const cl = record.closes;

    if (!Array.isArray(ts) || !Array.isArray(cl)) {
        problems.push('timestamps/closes are not both arrays');
    } else {
        if (!ts.length) problems.push('empty series');
        if (ts.length !== cl.length) {
            problems.push(`length mismatch: ${ts.length} timestamps vs ${cl.length} closes`);
        }
        if (ts.length !== record.count) {
            problems.push(`count ${record.count} disagrees with ${ts.length} rows`);
        }
        for (let i = 0; i < ts.length; i++) {
            const t = ts[i];
            const c = cl[i];
            if (!Number.isInteger(t)) {
                problems.push(`timestamps[${i}] is not an integer: ${t}`); break;
            }
            if (t % 86400 !== 0) {
                problems.push(`timestamps[${i}] (${t}) is not midnight UTC`); break;
            }
            if (i > 0 && t <= ts[i - 1]) {
                problems.push(`timestamps[${i}] is not strictly ascending: ${ts[i - 1]} → ${t} ` +
                              `(${isoFromEpoch(ts[i - 1])} → ${isoFromEpoch(t)})`); break;
            }
            if (!Number.isFinite(c) || c <= 0) {
                problems.push(`closes[${i}] is not a positive finite number: ${c}`); break;
            }
        }
    }
    if (problems.length) {
        throw new Error(`schema validation failed — ${problems.join('; ')}`);
    }
}

// ── No-regression gate ──────────────────────────────────────────────
// Load whatever is on disk today so the new fetch can be compared to it.
// A file that cannot be parsed is treated as "no baseline" and reported,
// not as a reason to abort: refusing to fix a corrupt file would be the
// wrong failure mode.
async function readExisting(file, id) {
    let raw;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    try {
        const old = JSON.parse(raw);
        const ts = Array.isArray(old.timestamps) ? old.timestamps : [];
        const count = Number.isFinite(old.count) ? old.count : ts.length;
        // Pre-v1 files (the 12 originals) carry no lastDate — derive it.
        const lastDate = old.lastDate || (ts.length ? isoFromEpoch(ts[ts.length - 1]) : '');
        if (!count) return null;
        // The parsed record travels with the two gate fields because the
        // unchanged check needs every field of it, not just these two.
        return { count, lastDate, record: old };
    } catch (err) {
        console.log(`  ! ${id}: existing file is unreadable (${err.message}); no-shrink gate has no baseline`);
        return null;
    }
}

// Returns a reason string when the new record must NOT replace the old
// one, or null when the write is safe.
function regressionReason(record, baseline) {
    if (!baseline) return null;
    if (record.count < baseline.count * SHRINK_TOLERANCE) {
        return `row count collapsed: ${record.count} rows is under ${Math.round(SHRINK_TOLERANCE * 100)}% ` +
               `of the ${baseline.count} already on disk`;
    }
    if (baseline.lastDate && record.lastDate < baseline.lastDate) {
        return `last date went backwards: ${record.lastDate} is older than the ${baseline.lastDate} already on disk`;
    }
    return null;
}

// ── Unchanged detection ─────────────────────────────────────────────
// `updated` is stamped from the wall clock, so a record rebuilt from
// byte-identical upstream rows still differs from the file on disk — by
// that one field and nothing else. See the header for why writing it
// anyway is a problem the workflow cannot solve on its own.
//
// The comparison is field by field on purpose. Serializing both objects
// and comparing the strings would answer "different" every time, because
// `updated` is in the string; it would also make key order — which says
// nothing about the data — decide whether a file gets rewritten.
function onlyStampDiffers(record, old) {
    if (!old || typeof old !== 'object') return false;
    // Union of both key sets, so a field present on one side and absent on
    // the other counts as a change. Pre-v1 files missing `lastDate` land
    // here and are rewritten once, which is the point.
    const fields = new Set([...Object.keys(record), ...Object.keys(old)]);
    fields.delete('updated');
    for (const field of fields) {
        if (!sameValue(record[field], old[field])) return false;
    }
    return true;
}

// Scalars compare with ===; `timestamps` and `closes` are arrays and
// compare element by element. A double survives a JSON round trip exactly,
// so === is the correct test for a close and a tolerance would be wrong —
// a price that moved in the last decimal place is a price that moved.
// Anything else (a nested object, should the schema ever grow one)
// compares false and the file is rewritten, which is the safe direction.
function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => v === b[i]);
    }
    return a === b;
}

// Serialize fully, then write through a temp file and rename, so an
// interrupted run can never leave a half-written JSON file in data/.
async function writeRecord(file, record) {
    const json = JSON.stringify(record);
    const tmp  = `${file}.tmp`;
    await fs.writeFile(tmp, json);
    await fs.rename(tmp, file);
}

// ── Dry run ─────────────────────────────────────────────────────────
async function dryRun(instruments) {
    console.log(`Dry run — no network calls, no writes.\n`);
    console.log(`Catalog:  ${CATALOG_PATH}`);
    console.log(`Window:   ${START_DATE} → ${isoDate(new Date())} (Tiingo startDate/endDate; Yahoo range=${RANGE_YAHOO}, trimmed to ${START_DATE})`);
    console.log(`Output:   ${DATA_DIR}${path.sep}<ID>.json  (schema 1)`);
    console.log(`Gate:     refuse any file under ${Math.round(SHRINK_TOLERANCE * 100)}% of its current row count, or with an older lastDate`);
    console.log(`Writes:   skipped entirely when the fetched payload matches the file already on disk\n`);

    const w = (s, n) => String(s).padEnd(n);
    console.log(`${w('SYMBOL', 7)}${w('CLASS', 7)}${w('RET', 6)}${w('ON DISK NOW', 24)}WOULD WRITE`);
    console.log('─'.repeat(96));

    let existing = 0;
    for (const e of instruments) {
        const file = path.join(DATA_DIR, `${e.id}.json`);
        const base = await readExisting(file, e.id);
        if (base) existing++;
        const now = base ? `${base.count} rows → ${base.lastDate}` : 'new file';
        console.log(`${w(e.id, 7)}${w(e.class, 7)}${w(e.returns, 6)}${w(now, 24)}${path.relative(ROOT, file)}`);
    }

    console.log('─'.repeat(96));
    console.log(`${plural(instruments.length, 'instrument')} — ${existing} already on disk (rewritten only if the ` +
                `payload moved), ${instruments.length - existing} created.`);
    console.log(`${plural(instruments.length, 'Tiingo request')} (free tier: 50/hour, 1000/day), ` +
                `~${Math.round(instruments.length * DELAY_MS / 1000)}s of politeness delay.`);
}

// ── Main ────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = { dryRun: false, only: null };
    for (const arg of argv) {
        if (arg === '--dry-run')      opts.dryRun = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length).split(',');
        else throw new Error(`Unknown argument "${arg}" (try --help)`);
    }
    return opts;
}

function usage() {
    console.log(`Usage: node scripts/fetch-data.js [--dry-run] [--only=SPY,QQQ]

  --dry-run       List what would be fetched and written; make no network
                  calls and touch no files.
  --only=A,B      Restrict the run to these catalog ids (useful for
                  testing one symbol without spending the hourly quota).

Environment:
  TIINGO_TOKEN    Free token from https://www.tiingo.com. Required in CI.`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }

    const instruments = await loadInstruments(opts.only);

    if (opts.dryRun) {
        await dryRun(instruments);
        return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    console.log(`Tiingo token: ${TIINGO_TOKEN ? '✓ present' : '✗ missing (get a free one at https://www.tiingo.com and set TIINGO_TOKEN)'}`);

    // In CI, a missing token must be a hard failure. Falling through to
    // Yahoo could produce a green run that silently masks the missing
    // secret (and commits mixed-provenance data).
    if (!TIINGO_TOKEN && process.env.GITHUB_ACTIONS) {
        console.error('Refusing to run in CI without TIINGO_TOKEN. Set it with: gh secret set TIINGO_TOKEN');
        process.exit(1);
    }

    console.log(`${plural(instruments.length, 'instrument')} from ${path.relative(ROOT, CATALOG_PATH)}, history from ${START_DATE}.\n`);

    let success   = 0;
    let unchanged = 0;
    const failures = [];   // { id, kind, message }

    for (let i = 0; i < instruments.length; i++) {
        const entry = instruments[i];
        try {
            process.stdout.write(`Fetching ${entry.id}... `);

            const result   = await fetchSymbol(entry.id);
            const record   = buildRecord(entry, result);
            validate(record);

            const file     = path.join(DATA_DIR, `${entry.id}.json`);
            const baseline = await readExisting(file, entry.id);
            const refuse   = regressionReason(record, baseline);
            if (refuse) {
                // Loud, because this is the case where doing nothing is
                // the correct behaviour and the run must still go red.
                console.log('✗ REFUSED TO WRITE');
                console.log(`  !! ${entry.id}: ${refuse}`);
                console.log(`  !! Kept the existing file. Check the upstream before re-running.`);
                failures.push({ id: entry.id, kind: 'refused', message: refuse });
            } else {
                const provenance = `${record.source}${result.column ? `:${result.column}` : ''}`;
                // `baseline?.` — a symbol with no file on disk has no
                // baseline to be unchanged from, and must be written.
                if (onlyStampDiffers(record, baseline?.record)) {
                    console.log(`= ${record.count} pts ${record.firstDate}..${record.lastDate} ` +
                                `(${provenance}, unchanged — file left alone)`);
                    unchanged++;
                } else {
                    await writeRecord(file, record);
                    const grew = baseline ? `${baseline.count} → ${record.count}` : `${record.count} new`;
                    console.log(`✓ ${record.count} pts ${record.firstDate}..${record.lastDate} ` +
                                `(${provenance}, ${grew})`);
                    success++;
                }
                // Printed either way: rows going missing every night is worth
                // seeing even on the runs that change nothing on disk.
                if (result.dropped) {
                    console.log(`  ~ ${entry.id}: ${plural(result.dropped, 'row')} in window had no usable close and were skipped`);
                }
            }
        } catch (err) {
            const notFound = err instanceof NotFoundError;
            console.log(`✗ ${notFound ? 'NOT FOUND' : ''} ${err.message}`.replace(/\s+/g, ' '));
            failures.push({
                id:      entry.id,
                kind:    notFound ? 'not-found' : 'error',
                message: err.message || String(err),
            });
        }

        // Be polite — 1.5s between requests, regardless of source.
        if (i < instruments.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\n${success} written, ${unchanged} unchanged, ${failures.length} failed, ` +
                `of ${plural(instruments.length, 'instrument')}.`);

    // Said out loud because this is the shape of a healthy weekend run, and
    // an operator scanning CI output should not have to work out whether
    // "0 written" means the fetch quietly did nothing.
    if (unchanged === instruments.length) {
        console.log('Every instrument already held the latest upstream data — nothing rewritten, ' +
                    'so the refresh commit will be empty by design.');
    }

    if (failures.length) {
        const notFound = failures.filter(f => f.kind === 'not-found');
        const refused  = failures.filter(f => f.kind === 'refused');
        const errored  = failures.filter(f => f.kind === 'error');

        if (notFound.length) {
            console.error(`\nNot found upstream (${notFound.length}) — check the ticker in data/catalog.json:`);
            notFound.forEach(f => console.error(`  ${f.id}: ${f.message}`));
        }
        if (refused.length) {
            console.error(`\nRefused to write (${refused.length}) — existing data kept, upstream looks wrong:`);
            refused.forEach(f => console.error(`  ${f.id}: ${f.message}`));
        }
        if (errored.length) {
            console.error(`\nFetch errors (${errored.length}):`);
            errored.forEach(f => console.error(`  ${f.id}: ${f.message}`));
        }
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
});
