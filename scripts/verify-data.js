#!/usr/bin/env node
// Validate every file in ../data against schema v1 and against
// data/catalog.json, and exit non-zero if anything is wrong.
//
// Run locally:
//   node scripts/verify-data.js
//   node scripts/verify-data.js --strict
//
// NOT YET WIRED INTO CI. As of this writing the only workflow is
// .github/workflows/refresh-data.yml, and it runs fetch-data.js and then
// commits data/ unconditionally — it never invokes this script, and there is
// no standalone PR check. Until a `node scripts/verify-data.js` step is added
// after the fetch (and before the commit), this gate only catches what
// somebody runs by hand.
//
// WHY this exists: "the fetch script exited 0" is not evidence that the
// data is good. The June 2026 outage is the proof — the nightly job kept
// running while Stooq started serving a JavaScript proof-of-work challenge
// and Yahoo started 429ing, and nobody noticed for weeks because nothing
// was checking the files on disk. A stalled upstream is worse than a dead
// one: it returns HTTP 200 with last month's rows forever. The only thing
// that catches that is a gate that reads what actually landed and asks
// whether it is shaped right and recent. Hence four families of check:
//
//   1. Shape       — schema v1, field by field, correctly typed.
//   2. Consistency — count/firstDate/lastDate must agree with the arrays
//                    they claim to describe; timestamps strictly ascending
//                    at midnight UTC; no NaN, null, or non-positive level.
//   3. Catalog     — no instrument silently without a file, no orphan file,
//                    no drift between the catalog's declared class/
//                    calendar/returns and the file's own.
//   4. Staleness   — the clock that actually catches a silent stall, plus
//                    the repeated-close check that catches the stall the
//                    clock cannot see: dates advancing, value frozen.
//
// Exit codes: 0 = every check that ran passed (warnings are allowed),
//             1 = at least one ✗.
//
// --strict promotes MISSING data files from ⚠ to ✗, derived ones included.
// Off by default because the catalog was just expanded and most of its
// entries have never been fetched; a permanently red check for known-absent
// symbols is a check everyone learns to ignore. Turn it on once the backfill
// has landed. Derived entries are listed separately because they are
// legitimately absent in a fresh clone — the macro workflow, not the fetch,
// produces them — but under --strict they fail exactly like the rest. They
// are not optional extras: data/USMKT.json is the century of market history
// the whole deep-history feature reads, and before this it could be deleted
// with --strict still green.
//
// Requires Node 18+. Zero external dependencies.

const fs   = require('fs/promises');
const path = require('path');

// ── Policy ──────────────────────────────────────────────────────────

const DATA_DIR      = path.join(__dirname, '..', 'data');
const CATALOG_FILE  = 'catalog.json';
// Written by this script into DATA_DIR, so it must be excluded from the scan
// alongside catalog.json — otherwise run N+1 validates run N's own output as
// if it were a price series and fails it on every field.
const MANIFEST_FILE = 'manifest.json';

const VALID_CLASS    = ['equity', 'etf', 'index', 'rate', 'deflator'];
const VALID_CALENDAR = ['sessions', 'continuous'];
const VALID_RETURNS  = ['total', 'price'];

// Classes whose closes are price/index levels. A zero or negative level is
// not a low reading, it is corrupt data. Rates are exempt: a policy rate
// can legitimately sit at zero.
const LEVEL_CLASSES = ['equity', 'etf', 'index', 'deflator'];

// A daily risk-free rate held as a decimal is ~0.0002 (5% a year over 252
// sessions). Anything at or above 1e-2 is a percent value that was never
// divided by 100 — which silently multiplies every excess return by a
// hundred. Cheap to check, invisible if we don't.
const RATE_MAX = 0.01;

// `returns` is meaningless for a rate or a deflator — schema v1 says omit
// it there — so it is required everywhere else.
const RETURNS_CLASSES = ['equity', 'etf', 'index'];

// Staleness budget in calendar days, measured from the last close to
// today. 7 covers a long weekend plus a market holiday.
const STALE_DAYS = 7;

// Exemptions, stated out loud rather than hidden in the pass. Any id here
// gets its own budget and its own printed justification.
// Sizing note, measured rather than guessed: on 2026-08-14 the newest
// Ken French daily bar was 1926-07-01..2026-06-30, i.e. 45 days old, and
// July's data had not yet been published. Their cadence is monthly with a
// four-to-six week lag, so the true worst case just before a publication
// is around 65 days. A 45-day budget therefore false-alarms every month;
// 75 leaves headroom while still catching a genuine stall.
const STALE_EXEMPT = {
    USMKT: { days: 75, why: 'Ken French publishes the market factor monthly, four to six weeks in arrears' },
    RF:    { days: 45, why: 'Ken French monthly cadence, but spliced with FRED DTB3 which is daily' },
    CPI:   { days: 75, why: 'FRED publishes CPIAUCNS monthly, a few weeks in arrears' },
};

// The staleness clock above only reads the DATE axis, so it is blind to the
// nastier half of the stall this gate exists for: an upstream that keeps
// stamping today's date on last week's price. The only trace that leaves on
// disk is a tail of bit-identical closes.
//
// Applied to these classes ONLY, because they are the ones whose value
// genuinely moves every session. `rate` is excluded because the US risk-free
// rate was legitimately pinned near zero for years at a time (2009-2015) —
// data/RF.json currently holds a run of 5423 identical closes and every one
// of them is correct. `deflator` is excluded because CPI is published monthly
// and repeats by construction. Flagging either would be flagging the truth.
const FROZEN_CLASSES = ['equity', 'etf', 'index'];

// Measured on 2026-08-14 rather than guessed: across the 13 equity/etf/index
// files on disk the longest identical-close run ANYWHERE in a series is 3
// (AMZN), and the longest in the exempt CPI is 9. A threshold of 10 clears
// both, and no real feed for these classes prints the same close for a
// fortnight of sessions.
const FROZEN_RUN = 10;

// There is deliberately no "infer the budget from the source string" rule.
// Inferring cadence from a provider name fails closed the wrong way: a fetch
// that falls back from tiingo to stooq or yahoo — both daily publishers, and
// both of them the actual June 2026 outage — would silently hand itself six
// weeks of slack. Leniency comes from STALE_EXEMPT and nowhere else, so every
// widened budget is a named, reviewable line above.

const SECONDS_PER_DAY = 86400;

// Nothing in this dataset predates 1900 (the oldest series, CPI, starts
// 1913-01), and no close can be dated in the future. Both bounds earn their
// keep. A seconds/milliseconds unit mix-up leaves every timestamp divisible
// by 86400, so `t % 86400 === 0` waves it straight through; and a
// future-dated last close makes `age` negative, which reads as "fresh" and
// turns the staleness check — the whole point of this gate — into a no-op.
const MIN_TIMESTAMP = Date.UTC(1900, 0, 1) / 1000;

// How many offending array elements to name before saying "and N more".
const MAX_DETAIL = 3;

// ── Small helpers ───────────────────────────────────────────────────

function fmt(value) {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    return JSON.stringify(value);
}

function ymd(unixSeconds) {
    // toISOString() throws RangeError past ±8.64e15 ms, and a seconds/
    // milliseconds mix-up gets there easily — never let a bad value in a data
    // file take the whole run down.
    const d = new Date(unixSeconds * 1000);
    if (Number.isNaN(d.getTime())) return `out-of-range(${unixSeconds})`;
    return d.toISOString().slice(0, 10);
}

function todayUTC() {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
}

function isString(v) {
    return typeof v === 'string' && v.length > 0;
}

function pluralize(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Print a long list of ids as wrapped, indented columns.
function columns(ids, perLine = 10, indent = '  ') {
    const width = ids.reduce((w, id) => Math.max(w, id.length), 0);
    const lines = [];
    for (let i = 0; i < ids.length; i += perLine) {
        lines.push(indent + ids.slice(i, i + perLine).map(id => id.padEnd(width)).join(' ').trimEnd());
    }
    return lines;
}

// ── Catalog ─────────────────────────────────────────────────────────

// catalog.json holds two arrays: `instruments` (tradables, with class/
// calendar/returns) and `series` (RF, CPI — described by `kind` because
// they are not tradable). Both produce one data file each, so flatten them
// into one keyed registry and let `kind` stand in for `class`.
function readCatalog(catalog) {
    const problems = [];
    const entries  = new Map();

    if (catalog.schema !== 1) {
        problems.push(`catalog.json: schema expected 1, got ${fmt(catalog.schema)}`);
    }

    const sections = [
        ['instruments', catalog.instruments],
        ['series',      catalog.series],
    ];

    for (const [section, list] of sections) {
        if (!Array.isArray(list)) {
            problems.push(`catalog.json: \`${section}\` is missing or not an array`);
            continue;
        }
        for (const raw of list) {
            if (!isString(raw && raw.id)) {
                problems.push(`catalog.json: an entry in \`${section}\` has no string \`id\``);
                continue;
            }
            if (entries.has(raw.id)) {
                problems.push(`catalog.json: duplicate id "${raw.id}"`);
                continue;
            }
            entries.set(raw.id, {
                id:       raw.id,
                name:     raw.name,
                section,
                class:    raw.class || raw.kind || null,
                calendar: raw.calendar || null,
                returns:  raw.returns  || null,
                source:   raw.source   || null,
                derived:  raw.derived === true,
            });
        }
    }

    return { entries, problems };
}

// ── Per-file validation ─────────────────────────────────────────────

// Returns a row for the table plus every problem found. Never throws on
// bad content — a malformed file is a finding, not a crash.
function verifyFile(fileName, json, entry, today) {
    const fails = [];
    const warns = [];

    const base = path.basename(fileName, '.json');
    const row  = { file: fileName, id: base, class: '—', count: '—', first: '—', last: '—', age: '—' };

    // `null`, `[]`, `"x"` and `3` are all valid JSON documents, so JSON.parse
    // hands them back happily. Every check below assumes an object; reading
    // `.schema` off `null` throws, and one such file would abort the run
    // before the table prints, hiding every other file's findings.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        fails.push(`body: expected a JSON object, got ${Array.isArray(json) ? 'an array' : fmt(json)}`);
        return { row, fails, warns };
    }

    // -- schema + scalar fields
    if (json.schema !== 1) {
        fails.push(`schema: expected 1, got ${fmt(json.schema)}`);
    }

    for (const field of ['id', 'name', 'class', 'calendar', 'currency', 'source', 'updated']) {
        if (!isString(json[field])) fails.push(`${field}: expected a non-empty string, got ${fmt(json[field])}`);
    }
    if (isString(json.updated) && !Number.isFinite(Date.parse(json.updated))) {
        fails.push(`updated: not a parseable timestamp (${fmt(json.updated)})`);
    }
    // The table is keyed on the filename, not the declared id — the file is
    // what CI has to fix, and a file whose id disagrees with its name would
    // otherwise print under a row that does not exist on disk.
    if (isString(json.id) && json.id !== base) {
        fails.push(`id: "${json.id}" does not match the filename (${fileName})`);
    }

    const cls = isString(json.class) ? json.class : null;
    if (cls) {
        row.class = cls;
        if (!VALID_CLASS.includes(cls)) fails.push(`class: "${cls}" is not one of ${VALID_CLASS.join(' | ')}`);
    }
    if (isString(json.calendar) && !VALID_CALENDAR.includes(json.calendar)) {
        fails.push(`calendar: "${json.calendar}" is not one of ${VALID_CALENDAR.join(' | ')}`);
    }
    if (cls && RETURNS_CLASSES.includes(cls)) {
        if (!isString(json.returns)) {
            fails.push(`returns: required for class ${cls}, got ${fmt(json.returns)}`);
        } else if (!VALID_RETURNS.includes(json.returns)) {
            fails.push(`returns: "${json.returns}" is not one of ${VALID_RETURNS.join(' | ')}`);
        }
    } else if (cls && json.returns !== undefined) {
        warns.push(`returns: schema v1 omits it for class ${cls}, found ${fmt(json.returns)}`);
    }

    // -- the two parallel arrays
    const ts = json.timestamps;
    const cl = json.closes;
    const tsOk = Array.isArray(ts);
    const clOk = Array.isArray(cl);
    if (!tsOk) fails.push(`timestamps: expected an array, got ${fmt(ts)}`);
    if (!clOk) fails.push(`closes: expected an array, got ${fmt(cl)}`);

    if (tsOk && clOk) {
        row.count = String(ts.length);

        if (ts.length !== cl.length) {
            fails.push(`length mismatch: timestamps ${ts.length} vs closes ${cl.length}`);
        }
        if (!Number.isInteger(json.count)) {
            fails.push(`count: expected an integer, got ${fmt(json.count)}`);
        } else if (json.count !== ts.length) {
            fails.push(`count: declares ${json.count}, arrays hold ${ts.length}`);
        }
        if (ts.length === 0) fails.push('timestamps: empty series');

        // -- timestamps: integer, midnight UTC, strictly ascending
        const notInt    = [];
        const notMidnit = [];
        const notAsc    = [];
        const outOfRange = [];
        const maxTimestamp = today + SECONDS_PER_DAY;
        for (let i = 0; i < ts.length; i++) {
            const t = ts[i];
            if (typeof t !== 'number' || !Number.isInteger(t)) {
                notInt.push(`[${i}]=${fmt(t)}`);
                continue;
            }
            if (t < MIN_TIMESTAMP || t > maxTimestamp) {
                outOfRange.push(`[${i}]=${t} (${ymd(t)})`);
            } else if (t % SECONDS_PER_DAY !== 0) {
                notMidnit.push(`[${i}]=${t} (${ymd(t)}T${new Date(t * 1000).toISOString().slice(11, 19)}Z)`);
            }
            if (i > 0 && typeof ts[i - 1] === 'number' && t <= ts[i - 1]) {
                notAsc.push(`[${i}]=${t}${t === ts[i - 1] ? ' duplicate of' : ' <'} [${i - 1}]=${ts[i - 1]}`);
            }
        }
        if (notInt.length)    fails.push(`timestamps: ${pluralize(notInt.length, 'non-integer value')} — ${summarise(notInt)}`);
        if (outOfRange.length) {
            fails.push(`timestamps: ${pluralize(outOfRange.length, 'value')} outside 1900-01-01..${ymd(maxTimestamp)} ` +
                       `— a future date reads as "fresh" and a seconds/ms mix-up still divides by 86400, so neither ` +
                       `the staleness nor the midnight check would catch it — ${summarise(outOfRange)}`);
        }
        if (notMidnit.length) fails.push(`timestamps: ${pluralize(notMidnit.length, 'value')} not midnight UTC (t % 86400 !== 0) — ${summarise(notMidnit)}`);
        if (notAsc.length)    fails.push(`timestamps: not strictly ascending at ${pluralize(notAsc.length, 'point')} — ${summarise(notAsc)}`);

        // -- closes: finite, and positive where a level is meant
        const notFinite = [];
        const notPos    = [];
        const rateHigh  = [];
        // An unrecognised class falls into the level branch rather than out of
        // both branches — otherwise a single typo in `class` silently switches
        // off every value check underneath it, and the corruption goes
        // unreported the moment somebody fixes the typo.
        const wantsLevel = cls ? LEVEL_CLASSES.includes(cls) || !VALID_CLASS.includes(cls) : true;
        for (let i = 0; i < cl.length; i++) {
            const c = cl[i];
            if (typeof c !== 'number' || !Number.isFinite(c)) {
                notFinite.push(`[${i}]=${fmt(c)}`);
                continue;
            }
            if (wantsLevel) {
                if (c <= 0) notPos.push(`[${i}]=${c}`);
            } else if (cls === 'rate') {
                if (c < 0) notPos.push(`[${i}]=${c}`);
                else if (c >= RATE_MAX) rateHigh.push(`[${i}]=${c}`);
            }
        }
        if (notFinite.length) fails.push(`closes: ${pluralize(notFinite.length, 'non-finite value')} (null/NaN/string) — ${summarise(notFinite)}`);
        if (notPos.length) {
            fails.push(cls === 'rate'
                ? `closes: ${pluralize(notPos.length, 'negative rate')} — ${summarise(notPos)}`
                : `closes: ${pluralize(notPos.length, 'value')} <= 0, invalid for class ${cls || '?'} — ${summarise(notPos)}`);
        }
        if (rateHigh.length) {
            fails.push(`closes: ${pluralize(rateHigh.length, 'rate')} >= ${RATE_MAX} — a daily rate as a decimal is ~0.0002, so this looks like percent/decimal mix-up — ${summarise(rateHigh)}`);
        }

        // -- firstDate / lastDate must describe the arrays
        if (ts.length && Number.isInteger(ts[0]) && Number.isInteger(ts[ts.length - 1])) {
            const first = ymd(ts[0]);
            const last  = ymd(ts[ts.length - 1]);
            row.first = first;
            row.last  = last;
            if (json.firstDate !== first) fails.push(`firstDate: declares ${fmt(json.firstDate)}, first timestamp is ${first}`);
            if (json.lastDate  !== last)  fails.push(`lastDate: declares ${fmt(json.lastDate)}, last timestamp is ${last}`);

            // -- staleness
            const rule = STALE_EXEMPT[row.id] || { days: STALE_DAYS, why: null };
            const age = Math.round((today - ts[ts.length - 1]) / SECONDS_PER_DAY);
            row.age = `${age}d`;
            row.staleRule = rule;
            if (age > rule.days) {
                fails.push(`stale: last close ${last} is ${age} days old, budget is ${rule.days}${rule.why ? ` (${rule.why})` : ''}`);
            }
        }

        // -- frozen: the same check for the same threat, read off the VALUE
        // axis instead of the date axis. Only the tail matters — a repeat in
        // the middle of a long series is history, a repeat at the end is the
        // feed that stopped moving while the clock above kept saying "fresh".
        const lastClose = cl[cl.length - 1];
        if (cls && FROZEN_CLASSES.includes(cls) && Number.isFinite(lastClose)) {
            let run = 1;
            while (run < cl.length && cl[cl.length - 1 - run] === lastClose) run++;
            if (run >= FROZEN_RUN) {
                // Date the run only when the axis is worth reading — a length
                // mismatch or a non-integer timestamp is already its own ✗.
                const from = ts.length === cl.length && Number.isInteger(ts[cl.length - run])
                    ? ` starting ${ymd(ts[cl.length - run])}` : '';
                fails.push(`frozen: the last ${run} closes are bit-identical at ${lastClose}${from} — the dates ` +
                           `advance but the value does not, which is an upstream re-serving a cached row; ` +
                           `class ${cls} is expected to move every session (threshold ${FROZEN_RUN})`);
            }
        }
    }

    // -- catalog agreement
    if (entry) {
        // `source` is in this list on purpose. A fetch that quietly falls back
        // to a different provider is the outage this gate was written for, and
        // the file's own `source` string is the only trace it leaves on disk.
        for (const field of ['class', 'calendar', 'returns', 'source']) {
            const declared = entry[field];
            if (declared && json[field] !== undefined && json[field] !== declared) {
                fails.push(`${field}: catalog says "${declared}", file says ${fmt(json[field])}`);
            }
        }
    }

    return { row, fails, warns };
}

function summarise(items) {
    const head = items.slice(0, MAX_DETAIL).join(', ');
    return items.length > MAX_DETAIL ? `${head}, and ${items.length - MAX_DETAIL} more` : head;
}

// ── Output ──────────────────────────────────────────────────────────

function printTable(results) {
    const headers = ['id', 'class', 'count', 'first', 'last', 'age', 'status'];
    const rows = results.map(r => [
        r.row.id,
        r.row.class,
        r.row.count,
        r.row.first,
        r.row.last,
        r.row.age,
        r.fails.length ? `✗ ${r.fails.length === 1 ? r.fails[0].split(':')[0] : `${r.fails.length} problems`}`
            : r.warns.length ? `⚠ ${r.warns[0].split(':')[0]}`
            : '✓',
    ]);

    const width = headers.map((h, i) => rows.reduce((w, row) => Math.max(w, row[i].length), h.length));
    const align = [0, 0, 1, 0, 0, 1, 0]; // 1 = right

    const line = cells => cells
        .map((c, i) => (align[i] ? c.padStart(width[i]) : c.padEnd(width[i])))
        .join('  ')
        .trimEnd();

    console.log(line(headers));
    console.log(width.map(w => '─'.repeat(w)).join('  '));
    for (const row of rows) console.log(line(row));
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
    const args   = process.argv.slice(2);
    const strict = args.includes('--strict');
    const unknown = args.filter(a => a !== '--strict');
    if (unknown.length) {
        console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: node scripts/verify-data.js [--strict]`);
        process.exit(1);
    }

    const today = todayUTC();

    // -- catalog
    let catalogJson;
    try {
        catalogJson = JSON.parse(await fs.readFile(path.join(DATA_DIR, CATALOG_FILE), 'utf8'));
    } catch (err) {
        console.error(`✗ cannot read data/${CATALOG_FILE}: ${err.message}`);
        process.exit(1);
    }
    const { entries: catalog, problems: catalogProblems } = readCatalog(catalogJson);

    // -- data files
    const files = (await fs.readdir(DATA_DIR))
        .filter(f => f.endsWith('.json') && f !== CATALOG_FILE && f !== MANIFEST_FILE)
        .sort();

    console.log(`Chronoticker data gate — ${pluralize(files.length, 'data file')}, ` +
                `${catalog.size} catalog entries, today ${ymd(today)} (UTC)\n`);

    const results = [];
    for (const file of files) {
        const id = path.basename(file, '.json');
        let json;
        try {
            json = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
        } catch (err) {
            results.push({ row: { file, id, class: '—', count: '—', first: '—', last: '—', age: '—' },
                           fails: [`unreadable: ${err.message}`], warns: [] });
            continue;
        }
        const result = verifyFile(file, json, catalog.get(id) || null, today);
        if (!catalog.has(id)) result.warns.push(`orphan: no entry with id "${id}" in ${CATALOG_FILE}`);
        results.push(result);
    }

    if (results.length) printTable(results);
    else console.log('(no data files found)');

    // -- details behind the status column
    const failed = results.filter(r => r.fails.length);
    const warned = results.filter(r => !r.fails.length && r.warns.length);

    if (catalogProblems.length) {
        console.log(`\nCatalog problems (${catalogProblems.length}):`);
        for (const p of catalogProblems) console.log(`  ✗ ${p}`);
    }
    if (failed.length) {
        console.log(`\nFailures (${failed.length} ${failed.length === 1 ? 'file' : 'files'}):`);
        for (const r of failed) {
            console.log(`  ${r.row.file}`);
            for (const f of r.fails) console.log(`    ✗ ${f}`);
            for (const w of r.warns) console.log(`    ⚠ ${w}`);
        }
    }
    if (warned.length) {
        console.log(`\nWarnings (${warned.length} ${warned.length === 1 ? 'file' : 'files'}):`);
        for (const r of warned) {
            console.log(`  ${r.row.file}`);
            for (const w of r.warns) console.log(`    ⚠ ${w}`);
        }
    }

    // -- catalog coverage, kept in its own clearly separated section
    const present = new Set(results.map(r => path.basename(r.row.file, '.json')));
    const missing = [];
    const derivedMissing = [];
    for (const entry of catalog.values()) {
        if (present.has(entry.id)) continue;
        (entry.derived ? derivedMissing : missing).push(entry.id);
    }

    if (missing.length) {
        console.log(`\nMissing data files (${missing.length}) — in ${CATALOG_FILE}, never fetched:`);
        for (const l of columns(missing)) console.log(l);
        console.log(strict
            ? '  ✗ --strict: missing files fail the run.'
            : '  ⚠ warning only. Re-run with --strict once the backfill has landed.');
    }
    // Kept in its own section because the reason they are absent is different
    // — the macro workflow produces these, not the fetch, so a fresh clone has
    // none of them — but "different reason" is not "acceptable". Under
    // --strict a missing derived file fails exactly like a missing fetched
    // one; this list is a heading, not an exemption.
    if (derivedMissing.length) {
        console.log(`\nMissing derived data files (${derivedMissing.length}) — in ${CATALOG_FILE}, produced by the macro workflow:`);
        for (const l of columns(derivedMissing)) console.log(l);
        console.log(strict
            ? '  ✗ --strict: missing derived files fail the run too.'
            : '  ⚠ warning only. Absent until the macro workflow has run at least once.');
    }

    // -- manifest: what the front end may offer in its menu.
    // index.html reads this instead of probing all ~45 catalogue entries on
    // first paint. It is written here rather than in a fetch script because
    // this is the only step that sees the whole data directory at once, and
    // it runs after every fetch in CI. It is regenerated even on a failing
    // run so it never describes a state that no longer exists.
    const manifestPath = path.join(DATA_DIR, MANIFEST_FILE);
    const manifest = {
        generated: new Date().toISOString(),
        note: 'Written by scripts/verify-data.js. Lists the instruments that have a data file, so the app does not have to probe for them. Safe to delete — the app falls back to probing.',
        // Staleness must NOT remove an instrument here. A stale file is still a
        // complete, renderable series; dropping it turns a recoverable upstream
        // stall into user-visible data loss, and because refresh-data.yml
        // commits data/ wholesale the amputated menu would then be pushed. On a
        // 20-day stall the old predicate (`!r.fails.length`) collapsed `present`
        // from 15 instruments to ["CPI","RF","USMKT"]. Structural failures do
        // still drop out — the app cannot render those.
        //
        // `frozen:` rides along with `stale:` for the same reason: it is the
        // same recoverable upstream problem seen from the value axis, and the
        // series it flags is complete and renders fine. It is a page for the
        // operator, not a reason to take the instrument off the menu.
        present: results.filter(r => r.fails.every(f => f.startsWith('stale:') || f.startsWith('frozen:'))).map(r => r.row.id).sort(),
        missing: missing.slice().sort(),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nWrote data/manifest.json — ${manifest.present.length} instrument(s) offered to the app.`);

    // -- staleness policy, said out loud
    console.log(`\nStaleness policy: ${STALE_DAYS} days for every file. The budget is never widened by ` +
                `inference from \`source\` — only by an explicit exemption below:`);
    for (const [id, rule] of Object.entries(STALE_EXEMPT)) {
        const applied = results.find(r => r.row.id === id && r.row.staleRule);
        console.log(`  ${id.padEnd(6)} ${String(rule.days).padStart(3)}d  ${rule.why}${applied ? '' : '  (no data file yet)'}`);
    }

    // -- summary. Every ✗ is named, so the exit code never needs decoding.
    const passed  = results.length - failed.length - warned.length;
    const orphans = results.filter(r => r.warns.some(w => w.startsWith('orphan'))).length;

    const reasons = [];
    // An empty data/ is the loudest possible version of the failure this gate
    // exists to catch, and without this line it printed "✓ PASS — every check
    // green" with exit 0, because zero files means zero ✗. Missing files are
    // only a ⚠ by default, so nothing else covers it.
    if (!results.length)        reasons.push(`no data files in data/ at all — the fetch produced nothing`);
    if (failed.length)          reasons.push(`${failed.length} of ${pluralize(results.length, 'data file')} failed validation`);
    if (catalogProblems.length) reasons.push(pluralize(catalogProblems.length, 'catalog problem'));
    if (strict && missing.length) reasons.push(`${pluralize(missing.length, 'missing data file')} (--strict)`);
    if (strict && derivedMissing.length) reasons.push(`${pluralize(derivedMissing.length, 'missing derived data file')} (--strict)`);

    console.log(`\nfiles: ${passed} ✓, ${warned.length} ⚠, ${failed.length} ✗ of ${results.length}  |  ` +
                `catalog: ${[...present].filter(id => catalog.has(id)).length} of ${catalog.size} present, ` +
                `${missing.length} missing${strict ? ' ✗' : ' ⚠'}, ` +
                // Counted apart from `missing` so the one number never hides
                // the other: 30 unfetched ETFs reading as ⚠ must not bury a
                // deleted USMKT.json in the same total.
                (derivedMissing.length ? `${derivedMissing.length} derived missing${strict ? ' ✗' : ' ⚠'}, ` : '') +
                `${orphans} orphan ⚠`);
    console.log(reasons.length ? `✗ FAIL — ${reasons.join('; ')}.` : '✓ PASS — every check green.');

    if (reasons.length) process.exit(1);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
