#!/usr/bin/env node
// Freeze a reference dataset for the golden scenarios.
//
//   node scripts/make-fixtures.mjs
//
// WHY THIS EXISTS
//
// Golden scenarios record exact numbers, and those numbers are computed over
// market data. Run them against data/ — which a nightly job exists to change —
// and they fail for reasons that have nothing to do with the code:
//
//   * Every scenario anchors its window to the newest bar, so one new trading
//     day slides the window and moves 8 of 10 scenarios.
//   * Adjusted closes are revised retroactively. A dividend restates the whole
//     history, so even a window pinned to absolute dates drifts.
//   * A backfill that deepens the history changes anything reading it all.
//
// That last one is what took the refresh workflow down on 2026-08-16: the
// 1990 backfill landed, the fetch and the data gate both passed, and then the
// goldens blocked the commit because the sweep now had 135 windows instead of
// 84. The data was fine. The harness was pointed at the wrong thing.
//
// So: scenarios read this frozen snapshot and answer "did the CODE change?".
// Property tests keep reading live data and answer "does this hold on whatever
// we actually have today?". Those are different questions and they need
// different inputs.
//
// Regenerate ONLY when deliberately re-baselining, and re-record the goldens
// in the same commit. Routine data refreshes must never touch this directory.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const OUT = path.join(HERE, '..', 'tests', 'fixtures');

const DAY = 86400;

// Trimmed to what the scenarios actually reach for, plus lead-in so the
// last-observation-carried-forward seed still has something to seed from.
const LEAD_IN_DAYS = 120;

const WANT = [
    // The eight instruments the scenarios trade, capped at the longest
    // window any of them uses (10 years).
    ...['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'SPY']
        .map(id => ({ id, keepDays: 3653 })),
    // G10 replays the whole century, so this one keeps everything.
    { id: 'USMKT', keepDays: null },
    // Needed only over the equity windows, so it does not need its 1926 tail.
    { id: 'RF', keepDays: 3653 + LEAD_IN_DAYS },
    // Small enough to keep whole, and deflation wants a long run-up.
    { id: 'CPI', keepDays: null },
];

function trim(file, keepDays) {
    if (keepDays == null) return file;
    const last = file.timestamps[file.timestamps.length - 1];
    const cutoff = last - (keepDays + LEAD_IN_DAYS) * DAY;
    let from = 0;
    while (from < file.timestamps.length && file.timestamps[from] < cutoff) from++;
    // Step back one so a window starting exactly at the cutoff still has a
    // prior observation to carry forward from.
    from = Math.max(0, from - 1);
    const timestamps = file.timestamps.slice(from);
    const closes = file.closes.slice(from);
    return {
        ...file,
        count: timestamps.length,
        firstDate: new Date(timestamps[0] * 1000).toISOString().slice(0, 10),
        lastDate: new Date(timestamps[timestamps.length - 1] * 1000).toISOString().slice(0, 10),
        timestamps,
        closes,
    };
}

async function main() {
    await fs.mkdir(OUT, { recursive: true });
    let total = 0;

    for (const { id, keepDays } of WANT) {
        const raw = JSON.parse(await fs.readFile(path.join(DATA, `${id}.json`), 'utf8'));
        if (raw.schema !== 1) throw new Error(`${id}: not schema v1`);
        const out = trim(raw, keepDays);
        out.fixture = {
            frozenAt: new Date().toISOString().slice(0, 10),
            why: 'Frozen reference data for golden scenarios. Never refreshed by the data workflows — see scripts/make-fixtures.mjs.',
        };
        const dest = path.join(OUT, `${id}.json`);
        await fs.writeFile(dest, JSON.stringify(out));
        const kb = (await fs.stat(dest)).size / 1024;
        total += kb;
        console.log(`✓ ${id.padEnd(6)} ${String(out.count).padStart(6)} pts  ${out.firstDate} → ${out.lastDate}  ${kb.toFixed(0)} KB`);
    }

    await fs.writeFile(path.join(OUT, 'README.md'),
        '# Frozen fixtures\n\n' +
        'Reference data for the golden scenarios in `scripts/replay.mjs`.\n\n' +
        '**Do not refresh these.** They are deliberately stale. Golden scenarios record exact\n' +
        'numbers, so they need input that never moves; the nightly data refresh exists to move\n' +
        '`data/`, and pointing the goldens at it made the refresh fail every trading day.\n\n' +
        'Property tests still run against live `data/` — they assert invariants rather than values.\n\n' +
        'Regenerate with `node scripts/make-fixtures.mjs` only when deliberately re-baselining,\n' +
        'and re-record the goldens in the same commit.\n');

    console.log(`\n${WANT.length} fixtures, ${total.toFixed(0)} KB total → ${path.relative(process.cwd(), OUT)}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
