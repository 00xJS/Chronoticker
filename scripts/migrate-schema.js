#!/usr/bin/env node
// One-shot, idempotent, in-place migration of the data/ files from the
// original ad-hoc shape to schema v1.
//
// Run:
//   node scripts/migrate-schema.js
//
// WHAT it does
//   Old shape (what scripts/fetch-data.js wrote through 2026-08):
//     { symbol, updated, source, rangeDays, timestamps, closes }
//   New shape (schema v1):
//     { schema, id, name, class, calendar, returns, currency, source,
//       updated, count, firstDate, lastDate, timestamps, closes }
//   `rangeDays` and `symbol` are dropped; everything else is either
//   carried over unchanged or derived from data/catalog.json and from
//   the arrays themselves.
//
// WHY migrate rather than re-fetch
//   Re-fetching would be the obvious alternative and it is the wrong
//   one. Tiingo's adjusted closes are re-stated every time a split or
//   dividend lands, so a fresh pull silently rewrites history: the whole
//   ten-year series shifts and every chart the site has ever rendered
//   changes underneath the reader. It also burns the free tier's request
//   budget and — as the June 2026 outage proved — puts the data files at
//   the mercy of whichever provider is currently answering. The bytes on
//   disk are already correct. The only thing wrong with them is the
//   envelope, so only the envelope is rewritten. `timestamps`, `closes`,
//   `updated` and `source` come out the far side with identical values,
//   and the script proves it by re-reading each file after writing and
//   comparing element by element.
//
// WHY the catalog is the source of the metadata
//   `name`, `class`, `calendar` and `returns` are editorial facts about
//   an instrument, not facts about a price series — they cannot be
//   recovered from the numbers. data/catalog.json already owns them for
//   the menu and for the fetch scripts, so it owns them here too. An id
//   with a data file and no catalog entry is a bug, and is reported as a
//   hard failure rather than guessed at.
//
// Safety properties
//   - Idempotent. A file that already declares `schema: 1` is left
//     untouched. Running this twice is a no-op.
//   - Lossless. Verified from disk, not from memory — and verified off
//     the temp file *before* the swap, so a failed proof cannot leave
//     the rejected result sitting where the original used to be.
//   - Never leaves a partial file. The full object is built and
//     validated in memory, serialised, written to a sibling temp file,
//     read back and re-checked, and only then renamed over the original
//     — an atomic swap on POSIX.
//   - Fails loudly. Any validation failure aborts that file (the
//     original is left exactly as it was) and the process exits 1.
//
// Requires Node 18+. Zero external dependencies.

const fs   = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG  = path.join(DATA_DIR, 'catalog.json');

const SCHEMA_VERSION = 1;
const SECONDS_PER_DAY = 86400;

// Files in data/ that are not instrument series and must not be mistaken
// for orphans. catalog.json is the registry; manifest.json is written by
// scripts/verify-data.js on every CI run and read by index.html to build
// its menu. Both are legitimate, neither has a catalog entry.
const NON_SERIES_FILES = new Set(['catalog.json', 'manifest.json']);

// Nothing in the catalog carries a currency today because everything in
// it is US-listed and priced in dollars. Honour an explicit `currency`
// if one ever appears; otherwise assume USD.
const DEFAULT_CURRENCY = 'USD';

// The v1 key order, fixed so every file on disk reads the same way.
// `returns` is spliced in only where it means something.
const V1_KEYS = [
    'schema', 'id', 'name', 'class', 'calendar', 'returns', 'currency',
    'source', 'updated', 'count', 'firstDate', 'lastDate',
    'timestamps', 'closes',
];

// Classes that describe a level, not an investable return stream. A
// risk-free rate or a price index has no dividends to reinvest, so
// `returns` is omitted rather than filled in with a lie.
const NO_RETURNS_CLASSES = new Set(['rate', 'deflator']);

// Every other class holds a level — a price, an index, a CPI print — and
// a level of zero or less is corrupt, not a low reading. Same split
// scripts/verify-data.js and scripts/fetch-data.js already enforce; only
// a `rate` may legitimately sit at zero (RF is 0.0 for 9795 ZIRP
// sessions). Anything unrecognised gets the strict rule.
const ZERO_ALLOWED_CLASSES = new Set(['rate']);

// Plausible calendar bounds for a daily observation, as epoch SECONDS.
// `t % 86400 === 0` alone does not mean "midnight UTC": a millisecond
// epoch is also a multiple of 86400 (1785456000000 % 86400 === 0), so a
// source that switched to milliseconds would sail through that check and
// land on disk with firstDate "+048552-10". Anything outside 1800..2200
// is not a date this project can hold.
const MIN_TIMESTAMP = Date.UTC(1800, 0, 1) / 1000;   // -5364662400
const MAX_TIMESTAMP = Date.UTC(2200, 0, 1) / 1000;   //  7258118400

function fail(message) {
    throw new Error(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

async function readJson(file) {
    let text;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch (err) {
        fail(`cannot read ${path.basename(file)}: ${err.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        fail(`${path.basename(file)} is not valid JSON: ${err.message}`);
    }
}

async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

function isoDay(t) {
    return new Date(t * 1000).toISOString().slice(0, 10);
}

// ── Validation ──────────────────────────────────────────────────────
// Everything the frontend assumes about a series, asserted here so a
// bad file can never reach it.
function validateSeries(id, timestamps, closes, cls) {
    assert(Array.isArray(timestamps), `${id}: timestamps is not an array`);
    assert(Array.isArray(closes),     `${id}: closes is not an array`);
    assert(timestamps.length > 0,     `${id}: timestamps is empty`);
    assert(timestamps.length === closes.length,
        `${id}: length mismatch — ${timestamps.length} timestamps vs ${closes.length} closes`);

    // A rate may be exactly zero; a price, an index level or a CPI print
    // may not. Unknown class falls back to the strict rule.
    const wantsLevel = !ZERO_ALLOWED_CLASSES.has(cls);

    for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        assert(Number.isFinite(t), `${id}: timestamps[${i}] is not a finite number (${t})`);
        assert(Number.isInteger(t), `${id}: timestamps[${i}] is not an integer (${t})`);
        // Range first: it makes every Date() below safe to construct, and
        // it is the only thing that catches a millisecond epoch, which is
        // a multiple of 86400 just like the seconds value it came from.
        assert(t >= MIN_TIMESTAMP && t < MAX_TIMESTAMP,
            `${id}: timestamps[${i}] = ${t} is outside 1800-01-01..2200-01-01 ` +
            `(${MIN_TIMESTAMP}..${MAX_TIMESTAMP}) — milliseconds instead of seconds?`);
        assert(t % SECONDS_PER_DAY === 0,
            `${id}: timestamps[${i}] = ${t} is not midnight UTC (${new Date(t * 1000).toISOString()})`);
        assert(i === 0 || t > timestamps[i - 1],
            `${id}: timestamps not strictly ascending at index ${i} (${timestamps[i - 1]} → ${t})`);
        assert(Number.isFinite(closes[i]), `${id}: closes[${i}] is not a finite number (${closes[i]})`);
        assert(wantsLevel ? closes[i] > 0 : closes[i] >= 0,
            `${id}: closes[${i}] = ${closes[i]} is not ${wantsLevel ? 'positive' : 'non-negative'} ` +
            `(class ${cls || 'unknown'})`);
    }
}

function validateV1(id, doc) {
    assert(doc.schema === SCHEMA_VERSION, `${id}: schema is ${doc.schema}, expected ${SCHEMA_VERSION}`);
    assert(doc.id === id,                 `${id}: id field says "${doc.id}"`);
    for (const key of ['name', 'class', 'calendar', 'currency', 'source', 'updated']) {
        assert(typeof doc[key] === 'string' && doc[key].length > 0,
            `${id}: ${key} is missing or not a non-empty string`);
    }
    assert(doc.count === doc.timestamps.length,
        `${id}: count ${doc.count} does not match ${doc.timestamps.length} points`);
    assert(doc.firstDate === isoDay(doc.timestamps[0]),
        `${id}: firstDate ${doc.firstDate} does not match first timestamp`);
    assert(doc.lastDate === isoDay(doc.timestamps[doc.timestamps.length - 1]),
        `${id}: lastDate ${doc.lastDate} does not match last timestamp`);
    if (NO_RETURNS_CLASSES.has(doc.class)) {
        assert(!('returns' in doc), `${id}: class "${doc.class}" must not carry a returns field`);
    } else {
        assert(doc.returns === 'total' || doc.returns === 'price',
            `${id}: returns is "${doc.returns}", expected "total" or "price"`);
    }
}

// ── Build ───────────────────────────────────────────────────────────
function buildV1(entry, old) {
    const timestamps = old.timestamps;
    const closes     = old.closes;

    const doc = {
        schema:   SCHEMA_VERSION,
        id:       entry.id,
        name:     entry.name,
        class:    entry.class,
        calendar: entry.calendar,
    };
    if (!NO_RETURNS_CLASSES.has(entry.class)) doc.returns = entry.returns;
    doc.currency  = entry.currency || DEFAULT_CURRENCY;
    // Preserved verbatim: these describe the fetch that produced the
    // numbers, and this script does not produce numbers.
    doc.source    = old.source;
    doc.updated   = old.updated;
    doc.count     = timestamps.length;
    doc.firstDate = isoDay(timestamps[0]);
    doc.lastDate  = isoDay(timestamps[timestamps.length - 1]);
    doc.timestamps = timestamps;
    doc.closes     = closes;

    return doc;
}

// ── Write ───────────────────────────────────────────────────────────
// Serialise into a sibling temp file, prove the temp file is right by
// reading it back off the disk, and only then swap it in. Verifying
// before the rename rather than after is what makes "the original is
// left exactly as it was" true for *every* failure: a readback assertion
// that fires after the rename would already have replaced the file it
// was complaining about, and the next run would then wave the result
// through as "already v1" and exit 0.
async function writeAtomicVerified(file, text, verify) {
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        await fs.writeFile(tmp, text);
        await verify(tmp);
        await fs.rename(tmp, file);
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
}

// The lossless proof. Reads back what actually landed on disk and
// compares it to the arrays that went in, element by element.
function assertIdentical(id, label, before, after) {
    assert(after.length === before.length,
        `${id}: ${label} length changed — ${before.length} in, ${after.length} out`);
    for (let i = 0; i < before.length; i++) {
        assert(Object.is(before[i], after[i]),
            `${id}: ${label}[${i}] changed — ${before[i]} in, ${after[i]} out`);
    }
}

async function migrateOne(entry, file) {
    const old = await readJson(file);

    // Already v1 — the idempotency gate. Validate it anyway so a
    // half-written file from a crashed run cannot hide behind its
    // schema field, but do not touch the bytes.
    if (old.schema === SCHEMA_VERSION) {
        validateSeries(entry.id, old.timestamps, old.closes, old.class);
        validateV1(entry.id, old);
        return { action: 'skipped', doc: old, oldCount: old.timestamps.length };
    }

    assert(old.schema === undefined,
        `${entry.id}: unknown schema version ${JSON.stringify(old.schema)} — refusing to touch it`);
    assert(old.symbol === entry.id,
        `${entry.id}: old file's symbol field says "${old.symbol}"`);
    assert(typeof old.source === 'string' && old.source,   `${entry.id}: old file has no source`);
    assert(typeof old.updated === 'string' && old.updated, `${entry.id}: old file has no updated timestamp`);

    const beforeTimestamps = old.timestamps;
    const beforeCloses     = old.closes;
    validateSeries(entry.id, beforeTimestamps, beforeCloses, entry.class);

    const doc = buildV1(entry, old);
    validateSeries(entry.id, doc.timestamps, doc.closes, doc.class);
    validateV1(entry.id, doc);

    const keys = Object.keys(doc);
    const expected = V1_KEYS.filter(k => k in doc);
    assert(keys.join(',') === expected.join(','),
        `${entry.id}: key order is ${keys.join(',')}, expected ${expected.join(',')}`);

    // Verify from disk, not from memory — proves the serialise/parse
    // round trip did not perturb a single float. Runs against the temp
    // file, before it is swapped in, so a failure here leaves the
    // original untouched instead of leaving a rejected file in place.
    let written;
    await writeAtomicVerified(file, JSON.stringify(doc), async (tmp) => {
        written = await readJson(tmp);
        validateV1(entry.id, written);
        assertIdentical(entry.id, 'timestamps', beforeTimestamps, written.timestamps);
        assertIdentical(entry.id, 'closes',     beforeCloses,     written.closes);
        assert(written.updated === old.updated, `${entry.id}: updated changed`);
        assert(written.source  === old.source,  `${entry.id}: source changed`);
        assert(!('rangeDays' in written), `${entry.id}: rangeDays survived the migration`);
        assert(!('symbol'    in written), `${entry.id}: symbol survived the migration`);
    });

    return { action: 'migrated', doc: written, oldCount: beforeTimestamps.length };
}

async function main() {
    const catalog = await readJson(CATALOG);
    assert(Array.isArray(catalog.instruments), 'catalog.json: instruments is not an array');

    const instruments = catalog.instruments;
    const series      = Array.isArray(catalog.series) ? catalog.series : [];

    // fetch-macro.js writes these in v1 already — the derived index and
    // every macro series. They are listed, not migrated.
    const derived = instruments.filter(i => i.derived);
    const skipIds = new Set([...derived, ...series].map(x => x.id));

    console.log(`Catalog: ${instruments.length} instruments, ${series.length} series`);

    const migratable = instruments.filter(i => !skipIds.has(i.id));

    let migrated = 0, skipped = 0, absent = 0;
    const absentIds = [];
    const errors = [];

    // "Produced in v1 already" is a claim about bytes on disk, and this
    // script is the wrong place to take it on trust: if fetch-macro.js
    // ever leaves one of these in the old shape, skipping it silently is
    // exactly the outcome this script exists to prevent. Not migrated,
    // but still checked.
    const notMigrated = [];
    const skipErrors  = [];
    for (const id of skipIds) {
        const file = path.join(DATA_DIR, `${id}.json`);
        if (!await exists(file)) {
            notMigrated.push(`${id} (no file)`);
            continue;
        }
        try {
            const doc = await readJson(file);
            assert(doc.schema === SCHEMA_VERSION,
                `${id}: skipped as already-v1, but the file on disk declares ` +
                `schema ${JSON.stringify(doc.schema)} — fetch-macro.js must rewrite it`);
            validateSeries(id, doc.timestamps, doc.closes, doc.class);
            validateV1(id, doc);
            notMigrated.push(`${id} (v1, ${doc.count} pts)`);
        } catch (err) {
            notMigrated.push(`${id} (FAILED)`);
            skipErrors.push(err.message);
            errors.push(err.message);
        }
    }
    console.log(`Produced in v1 already, not migrated: ${notMigrated.join(', ') || '(none)'}`);
    skipErrors.forEach(m => console.log(`✗ ${m}`));
    console.log();

    for (const entry of migratable) {
        const file = path.join(DATA_DIR, `${entry.id}.json`);
        if (!await exists(file)) {
            absentIds.push(entry.id);
            absent++;
            continue;
        }
        try {
            const { action, doc, oldCount } = await migrateOne(entry, file);
            const mark  = action === 'migrated' ? '✓' : '·';
            const verb  = action === 'migrated' ? 'migrated' : 'already v1';
            const shape = `${doc.class}/${doc.calendar}${doc.returns ? '/' + doc.returns : ''}`;
            console.log(
                `${mark} ${entry.id.padEnd(6)} ${verb.padEnd(11)} ` +
                `${String(oldCount).padStart(5)} → ${String(doc.count).padStart(5)} pts   ` +
                `${doc.firstDate} → ${doc.lastDate}   ${shape}`
            );
            if (action === 'migrated') migrated++; else skipped++;
        } catch (err) {
            // Every assertion message is already prefixed with the id.
            console.log(`✗ ${err.message}`);
            errors.push(err.message);
        }
    }

    if (absentIds.length) {
        console.log(`\nNo data file yet (${absent}, nothing to migrate): ${absentIds.join(', ')}`);
    }

    // A data file with no catalog entry has no name, class or calendar
    // and therefore cannot be migrated. Silently leaving it in the old
    // shape is exactly the failure this script exists to prevent, so
    // say so and exit non-zero.
    const known = new Set([...instruments, ...series].map(x => x.id));
    const orphans = (await fs.readdir(DATA_DIR))
        .filter(f => f.endsWith('.json') && !NON_SERIES_FILES.has(f))
        .map(f => f.slice(0, -'.json'.length))
        .filter(id => !known.has(id));
    if (orphans.length) {
        console.error(`\n✗ Data files with no catalog entry: ${orphans.join(', ')}`);
        errors.push(`orphan data files: ${orphans.join(', ')}`);
    }

    console.log(`\n${migrated} migrated, ${skipped} already v1, ${absent} absent, ${errors.length} failed.`);

    if (errors.length) {
        console.error('\nErrors:');
        errors.forEach(e => console.error(`  ${e}`));
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
});
