#!/usr/bin/env node
// Build the three "deep history" macro series that the per-symbol price
// feed cannot supply: a US total-market total-return index back to 1926,
// the matching risk-free rate, and the CPI used to deflate to real terms.
//
// Run locally or in CI — no token, no secret, no dependencies:
//   node scripts/fetch-macro.js
//
// Writes data/USMKT.json, data/RF.json, data/CPI.json (schema v1).
//
// Sources, and why these:
//   1. Ken French's data library — the Fama/French daily research
//      factors. This is the only free, keyless, machine-readable source
//      of a daily US total-return market series that reaches 1926. The
//      file gives Mkt-RF and RF as percent-per-day, so the market's
//      total return is simply (Mkt-RF + RF) and the index is the running
//      product. Its cost is latency: French rebuilds from CRSP monthly
//      and publishes ~6 weeks in arrears.
//      Alternatives that were rejected: Shiller's dataset is monthly and
//      price-only (dividends are a separate annual column); the CRSP
//      indices themselves are licensed; every free vendor API (Tiingo,
//      Yahoo, Stooq) starts in the ETF era at best — SPY begins 1993,
//      VTI 2001 — so none of them can show 1929 or 1973 at all.
//   2. FRED (fredgraph.csv) — keyless CSV export. Used for the DTB3
//      3-month bill to carry the risk-free rate across French's
//      publication lag, and for CPIAUCNS. FRED is chosen over BLS's own
//      API because the BLS API requires a registered key for anything
//      beyond a rate-limited anonymous tier.
//
// The Ken French file arrives as a ZIP. Unzipping it with zero
// dependencies means parsing the container by hand — see readZipEntries
// below. Node's zlib gives us the raw DEFLATE stream decoder, which is
// the only genuinely hard part of a ZIP; the rest is header offsets.
//
// Never shrink a file silently. An upstream that stalls and serves last
// year's rows answers HTTP 200 exactly like a good one, and the scheduled
// job commits whatever lands on disk. So nothing is written until all
// three files have been built AND compared against the files they would
// replace: fewer than 98% of the previous row count, or an older
// lastDate, and the run is refused. The whole run, not the offending
// file — USMKT and RF are cut from the same Ken French rows in one pass,
// so writing one while refusing the other would leave the pair describing
// different vintages of the world. Same thresholds and same wording as
// the gate in fetch-data.js, so the two scripts behave identically.
//
// Two approximations are baked in, and both are recorded in the `note`
// field of the affected file so a reader of the data never has to come
// back to this script to find them:
//
//   a. RF splice. French's RF is the 1-month T-bill as a simple daily
//      rate. Past French's last date we substitute the 3-month bill
//      (DTB3) de-annualized as (1 + ann/100)^(1/252) - 1. Two separate
//      approximations there: a 3-month bill is not a 1-month bill (in a
//      steep curve they differ by a few basis points annualized), and
//      252 is a nominal trading-year length rather than the actual
//      count of days to the bill's maturity. Over a splice window that
//      is only ever ~6 weeks long and at rates near 4%, the error is on
//      the order of 1e-7 per day. It is not worth a better model, but
//      it IS worth knowing about before anyone extends the window — so
//      the window is bounded rather than trusted: see SPLICE_WARN_ROWS
//      and SPLICE_ABORT_ROWS.
//
//   b. USMKT base date. The index is 1.0 at the close of the first row
//      (1926-07-01); that day's own return is therefore not applied.
//      This costs one day of return at the very start of a 100-year
//      series and keeps `closes[0]` exactly 1.0, which makes the file
//      readable by eye.
//
// Requires Node 20+ (built-in fetch). Zero external dependencies.

const fs   = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CATALOG     = path.join(DATA_DIR, 'catalog.json');

const FRENCH_URL  = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_Factors_daily_CSV.zip';
const FRED_URL    = id => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;

const DAY = 86400;

// French codes missing observations as -99.99 or -999. Anything at or
// below this is missing, not a real -99% day, and must never be
// cumulated into the index.
const MISSING_FLOOR = -99;

// Nominal trading days per year, used only to de-annualize DTB3.
const TRADING_DAYS = 252;

// Bounds on the DTB3 splice. The RF file's own `note` sells the tail as a
// stopgap covering Ken French's ~6-week publication lag, and the header's
// argument that the approximation is not worth improving rests entirely on
// the window being that short. Nothing upstream enforces it: if French
// stops publishing, the splice just grows and the file keeps making a
// claim about itself that is no longer true. 60 sessions is ~3 months —
// past that the lag is not "~6 weeks" any more and someone should look.
// 250 is about a trading year, at which point the note is not an
// approximation but a misdescription, so refuse to ship the file at all.
const SPLICE_WARN_ROWS  = 60;
const SPLICE_ABORT_ROWS = 250;

// A refreshed file may lose up to 2% of its rows — enough slack for an
// upstream revision dropping a handful of rows, nowhere near enough to let
// a stalled feed replace a century of history. Same value, and the same
// reasoning, as SHRINK_TOLERANCE in fetch-data.js.
const SHRINK_TOLERANCE = 0.98;

// Ceiling on any single request. All three fetches are sequential and run
// unattended on a schedule, so one half-open connection that never sends a
// byte would hang the job forever rather than failing it.
const REQUEST_TIMEOUT_MS = 60000;

// ...but a ceiling with no retry turns one slow response into a failed run.
// That is exactly what happened on 2026-08-16: FRED took longer than 60s to
// answer for DTB3 and the whole macro refresh died, having already done the
// expensive work of downloading and parsing a century of Fama/French rows.
// These upstreams are free academic and government endpoints; being briefly
// slow is normal behaviour, not an outage, and an unattended weekly job
// should ride it out rather than page someone.
const RETRIES = 3;
const RETRY_BACKOFF_MS = [5000, 20000];   // waits between attempts 1→2 and 2→3

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const HEADERS = {
    'User-Agent':      UA,
    'Accept':          'text/csv,application/zip,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

// ── Small helpers ────────────────────────────────────────────────────

function snippet(s, n = 160) {
    return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

function isoDate(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

// YYYYMMDD (French) → unix seconds at midnight UTC.
function compactToTimestamp(s) {
    const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
    return Date.UTC(y, m - 1, d) / 1000;
}

// YYYY-MM-DD (FRED) → unix seconds at midnight UTC.
function isoToTimestamp(s) {
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    return Date.UTC(y, m - 1, d) / 1000;
}

// Trim float noise. The inputs carry 2 decimal places of percent, so
// nine significant figures is far more than the data can justify — but
// it keeps the files a third smaller than raw IEEE round-tripping.
function round(x) {
    return Number(x.toPrecision(9));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * fetchBuffer with retries. Retries anything transport-shaped — a timeout, a
 * dropped connection, a 5xx, a 429 — and gives up immediately on a 4xx, which
 * means the URL is wrong and trying again will not fix it.
 */
async function fetchBuffer(url, label) {
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            return await fetchBufferOnce(url, label);
        } catch (err) {
            lastErr = err;
            const status = /HTTP (\d{3})/.exec(err.message)?.[1];
            const permanent = status && +status >= 400 && +status < 500 && +status !== 429;
            if (permanent || attempt === RETRIES) break;
            const wait = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
            console.log(`  ! ${label}: ${err.message} — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${RETRIES})`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

async function fetchBufferOnce(url, label) {
    // The body read is inside the timeout too, not just the handshake: an
    // upstream that sends headers and then stalls mid-stream hangs on
    // arrayBuffer(), and aborting the signal tears down the response
    // stream as well as the connection.
    let buf;
    try {
        const res = await fetch(url, {
            headers:  HEADERS,
            redirect: 'follow',
            signal:   AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);
        buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        // Node 22+ rejects with the signal's reason (a TimeoutError);
        // Node 20 wraps it in an AbortError and hangs the TimeoutError off
        // .cause. CI is on 20 and dev machines are not, so match both —
        // otherwise a timeout reads as a bare "This operation was aborted"
        // on exactly the platform the scheduled job runs on.
        if (err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError') {
            throw new Error(`${label}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw err;
    }
    if (!buf.length) throw new Error(`${label}: empty response`);
    return buf;
}

async function fetchText(url, label) {
    return (await fetchBuffer(url, label)).toString('utf8');
}

// ── ZIP container, parsed by hand ────────────────────────────────────
// Only the parts a real ZIP needs: locate the end-of-central-directory
// record, walk the central directory, then follow each entry's pointer
// to its local file header and inflate what follows.

function readZipEntries(buf) {
    const EOCD_SIG  = 0x06054b50;
    const CDIR_SIG  = 0x02014b50;
    const LOCAL_SIG = 0x04034b50;

    // The EOCD is 22 fixed bytes plus a variable-length comment, so its
    // position is not knowable in advance — scan backwards for the
    // signature. The comment length field is 16 bits, hence the floor.
    let eocd = -1;
    const floor = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= floor; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: no end-of-central-directory record found');

    const count = buf.readUInt16LE(eocd + 10);
    let cursor  = buf.readUInt32LE(eocd + 16);
    if (!count) throw new Error('ZIP: archive declares zero entries');

    const entries = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(cursor) !== CDIR_SIG) {
            throw new Error(`ZIP: bad central directory signature at entry ${n}`);
        }
        const method     = buf.readUInt16LE(cursor + 10);
        const compSize   = buf.readUInt32LE(cursor + 20);
        const uncompSize = buf.readUInt32LE(cursor + 24);
        const nameLen    = buf.readUInt16LE(cursor + 28);
        const extraLen   = buf.readUInt16LE(cursor + 30);
        const commentLen = buf.readUInt16LE(cursor + 32);
        const localOff   = buf.readUInt32LE(cursor + 42);
        const name       = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);

        if (buf.readUInt32LE(localOff) !== LOCAL_SIG) {
            throw new Error(`ZIP: bad local file header signature for "${name}"`);
        }
        // The local header repeats the name and extra fields, and its
        // extra-field length routinely differs from the central one, so
        // read the local lengths rather than reusing the central ones.
        const lNameLen  = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const data      = buf.subarray(dataStart, dataStart + compSize);

        let out;
        if (method === 8)      out = zlib.inflateRawSync(data);
        else if (method === 0) out = Buffer.from(data);
        else throw new Error(`ZIP: unsupported compression method ${method} for "${name}"`);

        if (out.length !== uncompSize) {
            throw new Error(`ZIP: "${name}" inflated to ${out.length} bytes, directory says ${uncompSize}`);
        }
        entries.set(name, out);
        cursor += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// ── Source 1: Ken French daily research factors ──────────────────────

async function fetchFrench() {
    process.stdout.write('Fetching Ken French daily factors... ');
    const zip     = await fetchBuffer(FRENCH_URL, 'ken-french');
    const entries = readZipEntries(zip);
    if (entries.size !== 1) {
        throw new Error(`ken-french: expected 1 file in ZIP, got ${entries.size}: ${[...entries.keys()].join(', ')}`);
    }
    const [name, body] = [...entries.entries()][0];
    console.log(`✓ ${(zip.length / 1024).toFixed(0)} KB zip → ${name} (${(body.length / 1024).toFixed(0)} KB)`);

    // Layout: a few lines of prose, a blank line, the header
    // ",Mkt-RF,SMB,HML,RF", then YYYYMMDD rows heavily padded with
    // spaces, then a blank line and a copyright notice. Rather than
    // counting preamble lines (which the publisher changes), accept a
    // row only when its first field is exactly eight digits.
    const rows = [];
    for (const line of body.toString('utf8').split(/\r?\n/)) {
        const fields = line.split(',');
        const date   = (fields[0] || '').trim();
        if (!/^\d{8}$/.test(date)) continue;
        // Exactly 5 — not "at least 5". fields[1] and fields[4] are read
        // positionally, so a publisher adding a column (the 5-factor
        // layout inserts RMW and CMA before HML) would silently shift RF
        // out from under fields[4] while still satisfying a `< 5` test.
        if (fields.length !== 5) {
            throw new Error(`ken-french: row ${date} has ${fields.length} fields, expected exactly 5 ` +
                            `(",Mkt-RF,SMB,HML,RF") — the column layout changed`);
        }

        const mktRf = parseFloat(fields[1]);
        const rf    = parseFloat(fields[4]);
        if (!Number.isFinite(mktRf) || !Number.isFinite(rf)) {
            throw new Error(`ken-french: unparseable numbers on row ${date}: "${snippet(line, 80)}"`);
        }
        // Abort rather than silently cumulate a missing-data sentinel
        // into a 100-year compounding chain, where it would vanish into
        // a plausible-looking number.
        if (mktRf <= MISSING_FLOOR || rf <= MISSING_FLOOR) {
            throw new Error(`ken-french: missing-data sentinel on row ${date} (Mkt-RF=${mktRf}, RF=${rf})`);
        }

        rows.push({ t: compactToTimestamp(date), mktRf, rf });
    }
    if (!rows.length) throw new Error('ken-french: no data rows matched /^\\d{8}$/ — file layout changed');

    console.log(`  parsed ${rows.length} daily rows, ${isoDate(rows[0].t)} → ${isoDate(rows[rows.length - 1].t)}`);
    return rows;
}

// ── Source 2: FRED keyless CSV ───────────────────────────────────────

async function fetchFred(id) {
    process.stdout.write(`Fetching FRED ${id}... `);
    const text  = await fetchText(FRED_URL(id), `fred:${id}`);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error(`fred:${id}: empty CSV`);

    const header = lines[0].trim();
    if (header !== `observation_date,${id}`) {
        throw new Error(`fred:${id}: unexpected header "${snippet(header, 80)}"`);
    }

    const rows    = [];
    const skipped = [];
    for (const line of lines.slice(1)) {
        const [date, raw] = line.split(',');
        if (!/^\d{4}-\d{2}-\d{2}$/.test((date || '').trim())) {
            throw new Error(`fred:${id}: unparseable date in row "${snippet(line, 80)}"`);
        }
        // FRED emits a row for every date on the series' calendar and
        // leaves the value blank where there is no observation. The
        // documented marker is a lone period, but today's export uses an
        // empty field instead (DTB3 has ~800 of them, one per market
        // holiday), so accept both. Skip these — never zero-fill, and
        // never carry the previous value forward.
        const v = (raw || '').trim();
        if (v === '.' || v === '') { skipped.push(date.trim()); continue; }
        const value = parseFloat(v);
        if (!Number.isFinite(value)) {
            throw new Error(`fred:${id}: unparseable value in row "${snippet(line, 80)}"`);
        }
        rows.push({ t: isoToTimestamp(date.trim()), value });
    }
    if (!rows.length) throw new Error(`fred:${id}: no usable observations`);

    console.log(`✓ ${rows.length} observations, ${isoDate(rows[0].t)} → ${isoDate(rows[rows.length - 1].t)}` +
                (skipped.length ? `, ${skipped.length} unobserved dates skipped` : ''));
    return { rows, skipped };
}

// Months with no published observation, between the first and last that
// do have one. For a daily series this is meaningless (weekends), so it
// is only used on the monthly CPI, where a hole is a real event worth
// shouting about: BLS did not publish October 2025 at all during the
// government shutdown, and anything interpolating across that gap needs
// to know it is spanning two months rather than one.
function missingMonths(rows) {
    const key  = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    const have = new Set(rows.map(r => key(r.t)));
    const gaps = [];
    for (let k = key(rows[0].t); k <= key(rows[rows.length - 1].t); k++) {
        if (!have.has(k)) gaps.push(`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`);
    }
    return gaps;
}

// ── Catalog: the single source of truth for what exists ──────────────

async function loadCatalog() {
    const raw = JSON.parse(await fs.readFile(CATALOG, 'utf8'));
    const byId = new Map();
    for (const entry of [...(raw.instruments || []), ...(raw.series || [])]) {
        byId.set(entry.id, entry);
    }
    return byId;
}

// Pull an id's metadata out of the catalog and confirm this script is
// actually producing what the catalog advertises. If the two disagree,
// one of them is a lie and the site would ship it.
function meta(catalog, id, expected) {
    const entry = catalog.get(id);
    if (!entry) throw new Error(`catalog: no entry for "${id}" — add it to data/catalog.json first`);
    if (entry.source !== expected.source) {
        throw new Error(`catalog: "${id}" declares source "${entry.source}" but this script produces "${expected.source}"`);
    }
    // Series entries use `kind` where instruments use `class`; they mean
    // the same thing to the reader, which only ever looks at `class`.
    const cls = entry.class || entry.kind;
    if (cls !== expected.class) {
        throw new Error(`catalog: "${id}" declares class "${cls}" but this script produces "${expected.class}"`);
    }
    return { name: entry.name, class: cls, calendar: entry.calendar || expected.calendar };
}

// ── Validation shared by every file ──────────────────────────────────

function validate(id, obj) {
    const { timestamps, closes } = obj;
    if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
        throw new Error(`${id}: timestamps/closes must be arrays`);
    }
    if (!timestamps.length) throw new Error(`${id}: no data points`);
    if (timestamps.length !== closes.length) {
        throw new Error(`${id}: ${timestamps.length} timestamps vs ${closes.length} closes`);
    }
    for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        if (!Number.isInteger(t)) throw new Error(`${id}: non-integer timestamp at ${i}: ${t}`);
        if (t % DAY !== 0) throw new Error(`${id}: timestamp at ${i} is not midnight UTC: ${t} (${new Date(t * 1000).toISOString()})`);
        if (i > 0 && t <= timestamps[i - 1]) {
            throw new Error(`${id}: timestamps not strictly ascending at ${i}: ${isoDate(timestamps[i - 1])} then ${isoDate(t)}`);
        }
        if (!Number.isFinite(closes[i])) throw new Error(`${id}: non-finite close at ${i} (${isoDate(t)}): ${closes[i]}`);
    }
    if (obj.count !== timestamps.length)          throw new Error(`${id}: count ${obj.count} != ${timestamps.length} points`);
    if (obj.firstDate !== isoDate(timestamps[0])) throw new Error(`${id}: firstDate ${obj.firstDate} != ${isoDate(timestamps[0])}`);
    if (obj.lastDate !== isoDate(timestamps[timestamps.length - 1])) {
        throw new Error(`${id}: lastDate ${obj.lastDate} != ${isoDate(timestamps[timestamps.length - 1])}`);
    }
}

// Assemble the full schema-v1 object in memory. No assertion failure can
// reach the write step, so a bad parse never lands on disk at all; and the
// write itself goes through a temp file and a rename (see writeJson), so a
// crash mid-write cannot leave a truncated JSON file behind either.
function build({ id, info, klass, returns, source, note, timestamps, closes }) {
    const obj = {
        schema:    1,
        id,
        name:      info.name,
        class:     klass,
        calendar:  info.calendar,
        ...(returns ? { returns } : {}),
        currency:  'USD',
        source,
        note,
        updated:   new Date().toISOString(),
        count:     timestamps.length,
        firstDate: isoDate(timestamps[0]),
        lastDate:  isoDate(timestamps[timestamps.length - 1]),
        timestamps,
        closes,
    };
    validate(id, obj);
    return obj;
}

// ── USMKT: cumulative daily total return, base 1.0 at 1926-07-01 ─────

function buildUSMKT(catalog, french) {
    const info = meta(catalog, 'USMKT', { source: 'ken-french', class: 'index', calendar: 'sessions' });

    const timestamps = [];
    const closes     = [];
    let idx = 1;
    for (let i = 0; i < french.length; i++) {
        const { t, mktRf, rf } = french[i];
        // Total return = excess return + risk-free, both percent/day.
        if (i > 0) idx *= 1 + (mktRf + rf) / 100;
        timestamps.push(t);
        closes.push(round(idx));
    }

    const obj = build({
        id: 'USMKT', info, klass: 'index', returns: 'total', source: 'ken-french',
        note: 'Cumulative daily total return of the CRSP value-weighted US market, ' +
              'rebuilt as (Mkt-RF + RF) from the Fama/French daily research factors. ' +
              'Base 1.0 at the close of the first row (1926-07-01); that day\'s own ' +
              'return is not applied. Ken French rebuilds from CRSP monthly, so this ' +
              'series lags live price data by up to six weeks.',
        timestamps, closes,
    });

    // ── Sanity assertions. Every one of these is a parse-failure
    // detector, not a market opinion: the historical values are known,
    // so a number outside these bands means the CSV was misread.
    if (obj.count <= 25000)             throw new Error(`USMKT: only ${obj.count} points, expected >25000 — parse truncated`);
    if (obj.firstDate !== '1926-07-01') throw new Error(`USMKT: firstDate is ${obj.firstDate}, expected 1926-07-01`);
    for (let i = 0; i < closes.length; i++) {
        if (!(closes[i] > 0)) throw new Error(`USMKT: non-positive close at ${isoDate(timestamps[i])}: ${closes[i]}`);
    }

    const dd = depressionDrawdown(timestamps, closes);
    // The Great Depression took the US market down roughly 85% peak to
    // trough (1929-09-03 → 1932-07-08). The spec band is -84%..-89%;
    // widened by one point on each side so a routine CRSP revision does
    // not fail the build. Any real parse error — percent read as
    // decimal, a sentinel cumulated, rows dropped — lands nowhere near.
    if (!(dd.drawdown <= -0.83 && dd.drawdown >= -0.90)) {
        throw new Error(`USMKT: 1929 peak-to-trough drawdown computed as ${(dd.drawdown * 100).toFixed(2)}% ` +
                        `(peak ${dd.peakDate}, trough ${dd.troughDate}), expected about -84% to -89%. The parse is wrong.`);
    }

    const cagr = longRunCagr(timestamps, closes);
    if (!(cagr >= 0.08 && cagr <= 0.12)) {
        throw new Error(`USMKT: long-run CAGR computed as ${(cagr * 100).toFixed(2)}%/yr, expected 8%–12%. The parse is wrong.`);
    }

    return { obj, dd, cagr };
}

// Max drawdown over the Depression window. Bounded to 1929–1934 so the
// running peak is the 1929 top rather than some later all-time high.
function depressionDrawdown(timestamps, closes) {
    const from = Date.UTC(1929, 0, 1) / 1000;
    const to   = Date.UTC(1935, 0, 1) / 1000;
    let peak = -Infinity, peakT = null;
    let drawdown = 0, peakDate = null, troughDate = null;
    let seen = 0;

    for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        if (t < from || t >= to) continue;
        seen++;
        if (closes[i] > peak) { peak = closes[i]; peakT = t; }
        const dd = closes[i] / peak - 1;
        if (dd < drawdown) { drawdown = dd; peakDate = isoDate(peakT); troughDate = isoDate(t); }
    }
    // Two different failures, two different messages: an empty window means
    // the rows never landed, while a window that only ever rose means the
    // returns themselves are wrong. Reporting the second as the first sends
    // whoever is debugging it to the wrong place.
    if (!seen)              throw new Error('USMKT: no observations inside the 1929–1934 window');
    if (peakDate === null)  throw new Error(`USMKT: ${seen} observations in the 1929–1934 window but no drawdown at all — the parse is wrong`);
    return { drawdown, peakDate, troughDate };
}

// Math.min(...arr) spreads every element onto the argument stack and
// blows up somewhere north of ~100k elements. These arrays are 26k
// today and only grow, so loop instead.
function extent(arr) {
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return { lo, hi };
}

function longRunCagr(timestamps, closes) {
    const years = (timestamps[timestamps.length - 1] - timestamps[0]) / (365.25 * DAY);
    return Math.pow(closes[closes.length - 1] / closes[0], 1 / years) - 1;
}

// ── RF: simple daily rate as a decimal, French spliced with FRED ─────

function buildRF(catalog, french, dtb3) {
    const info = meta(catalog, 'RF', { source: 'ken-french + fred:DTB3', class: 'rate', calendar: 'sessions' });

    const timestamps = [];
    const closes     = [];

    // Base: French's RF is already a simple daily rate, in percent.
    for (const { t, rf } of french) {
        timestamps.push(t);
        closes.push(round(rf / 100));
    }

    // Tail: everything after French's last published day. DTB3 is the
    // 3-month bill quoted as an annualized percent, so de-annualize on
    // a nominal 252-day year. See the header for what this costs.
    const spliceAfter = timestamps[timestamps.length - 1];
    let tail = 0;
    for (const { t, value } of dtb3) {
        if (t <= spliceAfter) continue;
        timestamps.push(t);
        closes.push(round(Math.pow(1 + value / 100, 1 / TRADING_DAYS) - 1));
        tail++;
    }
    console.log(`  RF splice: ${french.length} French rows through ${isoDate(spliceAfter)}, ` +
                `+${tail} DTB3 rows after it`);

    // The tail is only defensible while it is short. Past a year it is no
    // longer a stopgap and the note below would be describing a file that
    // does not exist, so refuse to write one rather than ship the claim.
    if (tail > SPLICE_ABORT_ROWS) {
        throw new Error(`RF: DTB3 splice has grown to ${tail} sessions after ${isoDate(spliceAfter)} ` +
                        `(limit ${SPLICE_ABORT_ROWS}, about a trading year). Ken French has stopped ` +
                        'publishing or the feed is stale. This file\'s note describes the tail as a ' +
                        '~6-week stopgap for a 1-month bill; at this length that is a misdescription, ' +
                        'not an approximation. Fix the upstream, or model the tail properly and rewrite the note.');
    }
    if (tail > SPLICE_WARN_ROWS) {
        console.log(`  ! RF: DTB3 splice is ${tail} sessions, past the ${SPLICE_WARN_ROWS}-session budget ` +
                    `(~3 months) — French's ~6-week lag is the premise the note and the 252-day ` +
                    `de-annualization both rest on. Check whether the data library has stalled; ` +
                    `the build refuses outright past ${SPLICE_ABORT_ROWS}.`);
    }

    const obj = build({
        id: 'RF', info, klass: 'rate', returns: null, source: 'ken-french + fred:DTB3',
        note: 'Simple daily risk-free rate as a decimal (not annualized, not percent). ' +
              `Fama/French RF (1-month T-bill) through ${isoDate(spliceAfter)}; after that date, ` +
              'FRED DTB3 (3-month bill, annualized percent) de-annualized as ' +
              '(1 + ann/100)^(1/252) - 1. The tail is an approximation on two counts: a ' +
              '3-month bill is not a 1-month bill, and 252 is a nominal trading year rather ' +
              'than the actual days to maturity. It exists only to cover Ken French\'s ' +
              '~6-week publication lag and is replaced by the real RF on the next refresh.',
        timestamps, closes,
    });

    // Catches the classic percent/decimal mix-up in either direction: a
    // percent left undivided would be ~0.01 (1%/day), and a negative
    // would mean a sign error or a genuinely negative bill yield, which
    // DTB3 has printed before (-0.05% annualized in 2015) and which
    // should stop the build for a human to look at rather than silently
    // ship a negative risk-free rate.
    for (let i = 0; i < closes.length; i++) {
        if (!(closes[i] >= 0 && closes[i] < 0.01)) {
            throw new Error(`RF: value out of range at ${isoDate(timestamps[i])}: ${closes[i]} (expected >=0 and <0.01 per day)`);
        }
    }

    return { obj, tail, spliceAfter };
}

// ── CPI: monthly index level, left monthly on purpose ────────────────

function buildCPI(catalog, cpi) {
    // Deliberately NOT seasonally adjusted: we deflate raw observed
    // price levels, and an SA series would smear a real month's
    // inflation across neighbours. Deliberately NOT interpolated to
    // daily here either — the frontend engine does that, so the file
    // stays the publisher's actual observations.
    const info = meta(catalog, 'CPI', { source: 'fred:CPIAUCNS', class: 'deflator', calendar: 'continuous' });

    const timestamps = cpi.map(r => r.t);
    const closes     = cpi.map(r => round(r.value));

    // A hole in a monthly series is a real-world event, not a parse bug,
    // so it must not abort — but it must never pass silently either.
    const gaps = missingMonths(cpi);
    if (gaps.length) {
        console.log(`  ! CPI has ${gaps.length} unpublished month(s): ${gaps.join(', ')} — ` +
                    'skipped, not interpolated here; recorded in the file\'s note field');
    }

    const obj = build({
        id: 'CPI', info, klass: 'deflator', returns: null, source: 'fred:CPIAUCNS',
        note: 'US city average CPI for all urban consumers, all items, NOT seasonally ' +
              'adjusted (CPIAUCNS). Monthly observations stamped on the first of the ' +
              'month, left monthly on purpose — the engine interpolates to daily. NSA is ' +
              'the deliberate choice because we deflate raw observed price levels. ' +
              'Not monotonic: deflation happens, notably 1920-21, 1930-33 and 2008-09.' +
              (gaps.length
                  ? ` Months BLS never published, absent from this series entirely: ${gaps.join(', ')}. ` +
                    'Any interpolation spans them, so the implied monthly rate around a gap ' +
                    'is an average across more than one month.'
                  : ''),
        timestamps, closes,
    });

    if (obj.count <= 1200) throw new Error(`CPI: only ${obj.count} observations, expected >1200 — parse truncated`);
    for (let i = 0; i < closes.length; i++) {
        if (!(closes[i] > 0)) throw new Error(`CPI: non-positive index level at ${isoDate(timestamps[i])}: ${closes[i]}`);
    }

    return { obj };
}

// ── Main ─────────────────────────────────────────────────────────────

// Serialize fully, then write through a temp file and rename, so an
// interrupted run can never leave a half-written JSON file in data/.
// Same contract as writeRecord() in fetch-data.js — these files are read
// straight off disk by the static site, where a truncated JSON is a hard
// page error rather than a stale number.
async function writeJson(file, obj) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, file);
}

// ── No-regression gate ───────────────────────────────────────────────
// Same contract as readExisting()/regressionReason() in fetch-data.js.
// Load whatever is on disk today so the new build can be compared to it.
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
        const lastDate = old.lastDate || (ts.length ? isoDate(ts[ts.length - 1]) : '');
        if (!count) return null;
        return { count, lastDate };
    } catch (err) {
        console.log(`  ! ${id}: existing file is unreadable (${err.message}); no-shrink gate has no baseline`);
        return null;
    }
}

// Returns a reason string when the new object must NOT replace the old
// one, or null when the write is safe.
function regressionReason(obj, baseline) {
    if (!baseline) return null;
    if (obj.count < baseline.count * SHRINK_TOLERANCE) {
        return `row count collapsed: ${obj.count} rows is under ${Math.round(SHRINK_TOLERANCE * 100)}% ` +
               `of the ${baseline.count} already on disk (${baseline.count - obj.count} rows short)`;
    }
    if (baseline.lastDate && obj.lastDate < baseline.lastDate) {
        const days = Math.round((isoToTimestamp(baseline.lastDate) - isoToTimestamp(obj.lastDate)) / DAY);
        return `last date went backwards: ${obj.lastDate} is older than the ${baseline.lastDate} ` +
               `already on disk (by ${days} days)`;
    }
    return null;
}

async function main() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const catalog = await loadCatalog();
    console.log(`Catalog: ${catalog.size} entries from ${path.relative(process.cwd(), CATALOG)}`);

    const french = await fetchFrench();
    const dtb3   = await fetchFred('DTB3');
    const cpiRaw = await fetchFred('CPIAUCNS');

    console.log('\nBuilding series...');
    const usmkt = buildUSMKT(catalog, french);
    const rf    = buildRF(catalog, french, dtb3.rows);
    const cpi   = buildCPI(catalog, cpiRaw.rows);

    // Every assertion has now passed for all three files. Those assertions
    // only prove each file is internally coherent, though — a stalled
    // upstream serving last year's rows produces a perfectly coherent file
    // that happens to be a year out of date. Only a comparison against
    // what is already on disk can catch that.
    const built = [usmkt.obj, rf.obj, cpi.obj];

    const regressions = [];
    for (const obj of built) {
        const baseline = await readExisting(path.join(DATA_DIR, `${obj.id}.json`), obj.id);
        const reason   = regressionReason(obj, baseline);
        if (reason) regressions.push(`${obj.id}: ${reason}`);
    }
    // All or nothing. USMKT and RF are cut from the same French rows in one
    // pass, so writing the survivors would leave the set self-inconsistent
    // — worse than the stale-but-coherent files already on disk.
    if (regressions.length) {
        throw new Error(`REFUSED TO WRITE — the new build regresses against the files on disk:\n` +
                        regressions.map(r => `  !! ${r}`).join('\n') +
                        `\n  !! Wrote nothing; all three existing files kept. ` +
                        `Check the upstream before re-running.`);
    }

    // Only now write.
    for (const obj of built) {
        const out = path.join(DATA_DIR, `${obj.id}.json`);
        await writeJson(out, obj);
        const kb = (await fs.stat(out)).size / 1024;
        console.log(`✓ ${path.relative(process.cwd(), out)} — ${obj.count} pts, ` +
                    `${obj.firstDate} → ${obj.lastDate} (${kb.toFixed(0)} KB)`);
    }

    const uc = usmkt.obj.closes;
    const rc = extent(rf.obj.closes);
    const cc = extent(cpi.obj.closes);
    const cl = cpi.obj.closes;
    console.log('\nVerified numbers:');
    console.log(`  USMKT  index ${uc[0]} → ${uc[uc.length - 1].toFixed(2)} over ${usmkt.obj.count} sessions`);
    console.log(`  USMKT  1929 drawdown ${(usmkt.dd.drawdown * 100).toFixed(2)}% ` +
                `(peak ${usmkt.dd.peakDate} → trough ${usmkt.dd.troughDate})`);
    console.log(`  USMKT  long-run CAGR ${(usmkt.cagr * 100).toFixed(2)}%/yr`);
    console.log(`  RF     daily decimal ${rc.lo} → ${rc.hi} ` +
                `(≈${(rc.lo * TRADING_DAYS * 100).toFixed(2)}%–${(rc.hi * TRADING_DAYS * 100).toFixed(2)}% annualized), ` +
                `${rf.tail} days spliced from DTB3 after ${isoDate(rf.spliceAfter)}`);
    console.log(`  CPI    level ${cc.lo} → ${cc.hi}, latest ${cl[cl.length - 1]} at ${cpi.obj.lastDate}`);
}

main().catch(err => {
    console.error(`\n✗ Fatal: ${err.message}`);
    process.exit(1);
});
