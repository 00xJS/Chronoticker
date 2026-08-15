#!/usr/bin/env node
// Golden replay harness.
//
//   node scripts/replay.mjs            check against tests/goldens.json
//   node scripts/replay.mjs --record   overwrite the goldens with current output
//   node scripts/replay.mjs --verbose  print every metric, not just failures
//
// Why this exists: index.html used to compute every risk metric on the raw
// dollar equity curve, so contributions were counted as investment
// performance. Fixing that changes real numbers, and without a recorded
// baseline there is no way to tell an intended fix from a regression. So
// the goldens carry a `changed` note on exactly the values that were
// expected to move, and everything else must stay byte-stable forever.
//
// The PROPERTY tests below are the more important half. A recorded number
// only proves the code still does what it did; a property proves it does
// the right thing. The load-bearing one is `contribution-invariance`: a
// deposit must not mechanically inflate CAGR, volatility, Sharpe or
// drawdown. That is the entire original bug class, and it fails loudly on
// the old implementation.
//
// Its counterpart, `unrebalanced-contributions-are-a-partial-rebalance`,
// asserts the opposite where the opposite is correct: contributions buy at
// target weights, so in a drifting unrebalanced basket they genuinely change
// the strategy and the time-weighted return SHOULD move. Both are pinned so
// that neither gets "fixed" into the other.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    toSeries, alignSeries, sliceAligned, simulate, metrics, xirr,
    baseRateSweep, duel, rfOnAxis, cpiOnAxis, deflate, annualizationFor, iso, projectOnAxis,
} from '../assets/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const GOLDENS = path.join(HERE, '..', 'tests', 'goldens.json');

const RECORD = process.argv.includes('--record');
const VERBOSE = process.argv.includes('--verbose');

const TOL = 1e-9;

// ── Data ────────────────────────────────────────────────────────────

const cache = new Map();
async function load(id) {
    if (cache.has(id)) return cache.get(id);
    const raw = JSON.parse(await fs.readFile(path.join(DATA, `${id}.json`), 'utf8'));
    const s = toSeries(raw);
    cache.set(id, s);
    return s;
}
async function have(id) {
    try { await fs.access(path.join(DATA, `${id}.json`)); return true; } catch { return false; }
}

/** Build an aligned block for a set of ids, sliced to the last `days`. */
async function block(ids, days) {
    const list = await Promise.all(ids.map(load));
    const aligned = alignSeries(list);
    if (days == null) return { aligned, list };
    const end = aligned.dates[aligned.dates.length - 1];
    return { aligned: sliceAligned(aligned, end - days * 86400000, end), list };
}

// ── Scenarios ───────────────────────────────────────────────────────

const round = (v, d = 10) =>
    (v == null || !Number.isFinite(v)) ? v : Number(v.toFixed(d));

function summarize(sim, m, extra = {}) {
    return {
        bars: m.bars,
        finalValue: round(sim.totals.finalValue, 6),
        contributed: round(sim.totals.contributed, 6),
        contributions: sim.totals.contributions,
        costsPaid: round(sim.totals.costsPaid, 6),
        feesPaid: round(sim.totals.feesPaid, 6),
        twrCagr: round(m.cagr),
        twrTotal: round(m.twr),
        maxDD: round(m.maxDD),
        vol: round(m.vol),
        sharpe: round(m.sharpe),
        sortino: round(m.sortino),
        best: round(m.best),
        worst: round(m.worst),
        irr: round(xirr(sim.flows)),
        ...extra,
    };
}

const SCENARIOS = [
    {
        id: 'G1-default-1y',
        note: 'The app default. No contributions, so every value here must be identical to the pre-fix implementation forever.',
        needs: ['AAPL', 'MSFT', 'NVDA', 'SPY'],
        async run() {
            const { aligned, list } = await block(['AAPL', 'MSFT', 'NVDA', 'SPY'], 366);
            const weights = { AAPL: 40, MSFT: 30, NVDA: 30 };
            const sim = simulate(aligned, { weights, initial: 10000 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return summarize(sim, m, { from: iso(aligned.dates[0]), to: iso(aligned.dates.at(-1)) });
        },
    },
    {
        id: 'G2-spy-10y-dca',
        note: 'THE FIX. Pre-fix this reported CAGR 33.20% and Sharpe 1.62 on a dollar curve fattened by deposits. True time-weighted values are ~15.01% and ~0.87.',
        changed: ['twrCagr', 'vol', 'sharpe', 'maxDD', 'contributed'],
        needs: ['SPY'],
        async run() {
            const { aligned, list } = await block(['SPY'], 3653);
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 10000, contribution: 500 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return summarize(sim, m);
        },
    },
    {
        id: 'G3-mag7-5y-quarterly',
        note: 'No contributions — must stay identical to the pre-fix implementation.',
        needs: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'],
        async run() {
            const ids = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'];
            const { aligned, list } = await block(ids, 1827);
            const weights = { AAPL: 16, MSFT: 14, NVDA: 14, GOOGL: 14, AMZN: 14, META: 14, TSLA: 14 };
            const sim = simulate(aligned, { weights, initial: 10000, rebalanceDays: 90 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return summarize(sim, m);
        },
    },
    {
        id: 'G4-guide-scenario-zero-initial',
        note: 'guide.html scenario 4 verbatim ("set initial to $0"). Pre-fix this printed CAGR 53,860.88% and NaN for volatility and best/worst day. The NAV index now starts at the first funding event.',
        changed: ['everything — this configuration used to produce NaN'],
        needs: ['SPY'],
        async run() {
            const { aligned, list } = await block(['SPY'], 1827);
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 0, contribution: 500 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return summarize(sim, m, { firstFundedIndex: sim.firstFundedIndex });
        },
    },
    {
        id: 'G5-costed-rebalance',
        note: 'Quarterly rebalancing with 10bps costs and a 20bps annual fee. Rebalance costs come out of the fund and must reduce the time-weighted return; purchase costs must not.',
        needs: ['AAPL', 'MSFT', 'NVDA'],
        async run() {
            const { aligned, list } = await block(['AAPL', 'MSFT', 'NVDA'], 1827);
            const weights = { AAPL: 34, MSFT: 33, NVDA: 33 };
            const sim = simulate(aligned, {
                weights, initial: 10000, rebalanceDays: 90, costBps: 10, feeBps: 20,
            });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return summarize(sim, m);
        },
    },
    {
        id: 'G6-real-vs-nominal',
        note: 'Same run measured in nominal and in constant final-year dollars. The gap is the inflation of the window.',
        needs: ['SPY', 'CPI'],
        async run() {
            const { aligned, list } = await block(['SPY'], 3653);
            const cpi = await load('CPI');
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 10000 });
            const ann = annualizationFor(list);
            const nominal = metrics(sim.nav, aligned.dates, { annualization: ann });
            const axis = cpiOnAxis({ dates: cpi.dates, values: cpi.values }, aligned.dates);
            const real = metrics(deflate(sim.nav, axis), aligned.dates, { annualization: ann });
            return {
                nominalCagr: round(nominal.cagr),
                realCagr: round(real.cagr),
                inflationDrag: round(nominal.cagr - real.cagr),
                cpiStart: round(axis[0], 4),
                cpiEnd: round(axis[axis.length - 1], 4),
            };
        },
    },
    {
        id: 'G7-sharpe-with-real-rf',
        note: 'Sharpe assuming cash yields nothing, versus Sharpe against actual T-bills. The first number is the flattering one and is what the app used to print.',
        needs: ['SPY', 'RF'],
        async run() {
            const { aligned, list } = await block(['SPY'], 3653);
            const rf = await load('RF');
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 10000 });
            const ann = annualizationFor(list);
            const zero = metrics(sim.nav, aligned.dates, { annualization: ann });
            const rfAxis = rfOnAxis({ dates: rf.dates, values: rf.values }, aligned.dates);
            const real = metrics(sim.nav, aligned.dates, { annualization: ann, rfDaily: rfAxis });
            return {
                sharpeAssumingZeroRf: round(zero.sharpe),
                sharpeVsTbills: round(real.sharpe),
                averageRfAnnual: round(real.rfAnnual),
            };
        },
    },
    {
        id: 'G8-base-rate-sweep',
        note: 'Mag 7 versus SPY over every 3-year window the data allows. With only 10 years baked, this rests on very few independent windows — the harness records that count so the thinness is never hidden.',
        changed: [
            'medianMargin, worstMargin, bestMargin — swept windows are now exactly `windowBars` bars ' +
            '(756) instead of windowBars+1 (757). The old convention put the user\'s own window one step ' +
            'beyond the swept range, so it could never be sampled; fixing that also shortened every ' +
            'window by one bar. count/wins/winRate/independentWindows are unchanged. medianMargin ' +
            'additionally moved because it now uses a true median rather than the upper-middle element.',
        ],
        needs: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'SPY'],
        async run() {
            const ids = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'SPY'];
            const { aligned, list } = await block(ids, null);
            const weights = { AAPL: 16, MSFT: 14, NVDA: 14, GOOGL: 14, AMZN: 14, META: 14, TSLA: 14 };
            const sweep = baseRateSweep(aligned, {
                weights, benchmark: 'SPY', windowBars: 756, stepBars: 21,
                annualization: annualizationFor(list),
            });
            return {
                count: sweep.count,
                wins: sweep.wins,
                winRate: round(sweep.winRate, 6),
                medianMargin: round(sweep.medianMargin),
                worstMargin: round(sweep.worstMargin),
                bestMargin: round(sweep.bestMargin),
                independentWindows: sweep.independentWindows,
            };
        },
    },
    {
        id: 'G9-duel',
        note: 'Lump sum versus twelve monthly instalments, same money, same window, idle cash earning real T-bills.',
        changed: [
            'doseIrr — the dose side recorded each tranche as the outflow while also crediting the ' +
            'investor the T-bill interest earned on capital that schedule said had not been paid in ' +
            'yet, which inflated the money-weighted return. Under this comparison\'s fairness ' +
            'contract the whole sum is committed on day one, so the outflow is now the full amount ' +
            'at bar 0. With a single outflow the money-weighted and time-weighted returns coincide, ' +
            'which is why doseIrr now equals doseCagr exactly.',
        ],
        needs: ['SPY', 'RF'],
        async run() {
            const { aligned, list } = await block(['SPY'], 1827);
            const rf = await load('RF');
            const rfAxis = rfOnAxis({ dates: rf.dates, values: rf.values }, aligned.dates);
            const d = duel(aligned, {
                weights: { SPY: 100 }, total: 120000, deployments: 12,
                annualization: annualizationFor(list), rfDaily: rfAxis,
            });
            return {
                lumpFinal: round(d.lump.final, 6),
                doseFinal: round(d.dose.final, 6),
                lumpCagr: round(d.lump.metrics.cagr),
                doseCagr: round(d.dose.metrics.cagr),
                lumpMaxDD: round(d.lump.metrics.maxDD),
                doseMaxDD: round(d.dose.metrics.maxDD),
                lumpIrr: round(d.lump.irr),
                doseIrr: round(d.dose.irr),
                cashEarnsRf: d.cashEarnsRf,
            };
        },
    },
    {
        id: 'G10-deep-history-usmkt',
        note: 'The whole point of the deep spine: a window containing 1929, 1973 and 2008. If this run ever stops showing an ~85% Depression drawdown, the upstream parse has broken.',
        needs: ['USMKT'],
        async run() {
            const { aligned, list } = await block(['USMKT'], null);
            const sim = simulate(aligned, { weights: { USMKT: 100 }, initial: 10000 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            return {
                from: iso(aligned.dates[0]),
                to: iso(aligned.dates.at(-1)),
                bars: m.bars,
                cagr: round(m.cagr),
                maxDD: round(m.maxDD),
                ddFrom: iso(m.ddFrom),
                ddTo: iso(m.ddTo),
                worst: round(m.worst),
                worstAt: iso(m.worstAt),
            };
        },
    },
];

// ── Property tests ──────────────────────────────────────────────────
// These do not depend on recorded values. They assert things that must be
// true of any correct implementation.

const PROPERTIES = [
    {
        id: 'contribution-invariance',
        why: 'THE regression test for the original defect. A deposit must not mechanically inflate a time-weighted metric. Exact where the portfolio composition is unaffected by the purchase: a single asset, and a multi-asset basket rebalanced on the contribution cadence. On the pre-fix code both cases fail on every metric.',
        needs: ['SPY', 'AAPL', 'MSFT', 'NVDA'],
        async run(assert) {
            const keys = ['cagr', 'vol', 'sharpe', 'maxDD', 'best', 'worst', 'twr'];

            const single = await block(['SPY'], 3653);
            const singleRuns = [0, 100, 500, 5000].map(c => metrics(
                simulate(single.aligned, { weights: { SPY: 100 }, initial: 10000, contribution: c }).nav,
                single.aligned.dates, { annualization: annualizationFor(single.list) }));
            for (const key of keys) for (let i = 1; i < singleRuns.length; i++) {
                assert(Math.abs(singleRuns[i][key] - singleRuns[0][key]) < 1e-12,
                    `single asset: ${key} moved with contribution size (${singleRuns[0][key]} vs ${singleRuns[i][key]})`);
            }

            // Multi-asset, rebalanced on the same cadence as the contribution:
            // composition is restored either way, so this must be exact too.
            const multi = await block(['AAPL', 'MSFT', 'NVDA'], 3653);
            const w = { AAPL: 40, MSFT: 30, NVDA: 30 };
            const multiRuns = [0, 500, 5000].map(c => metrics(
                simulate(multi.aligned, { weights: w, initial: 10000, contribution: c, contributionDays: 30, rebalanceDays: 30 }).nav,
                multi.aligned.dates, { annualization: annualizationFor(multi.list) }));
            for (const key of keys) for (let i = 1; i < multiRuns.length; i++) {
                assert(Math.abs(multiRuns[i][key] - multiRuns[0][key]) < 1e-10,
                    `rebalanced multi-asset: ${key} moved with contribution size (${multiRuns[0][key]} vs ${multiRuns[i][key]})`);
            }
        },
    },
    {
        id: 'unrebalanced-contributions-are-a-partial-rebalance',
        why: 'The counterpart to the above, asserted so nobody "fixes" it later. Contributions buy at TARGET weights, so feeding money into a drifting unrebalanced basket pulls it back toward target and genuinely changes the strategy. The time-weighted return SHOULD move here — the number is real economics, not leakage, and the UI is required to say so.',
        needs: ['AAPL', 'MSFT', 'NVDA'],
        async run(assert) {
            const { aligned, list } = await block(['AAPL', 'MSFT', 'NVDA'], 3653);
            const w = { AAPL: 40, MSFT: 30, NVDA: 30 };
            const ann = annualizationFor(list);
            const none = metrics(simulate(aligned, { weights: w, initial: 10000 }).nav, aligned.dates, { annualization: ann });
            const heavy = metrics(simulate(aligned, { weights: w, initial: 10000, contribution: 5000 }).nav, aligned.dates, { annualization: ann });
            assert(heavy.cagr < none.cagr,
                `expected contributions to drag the growth rate toward target weights, got ${heavy.cagr} vs ${none.cagr}`);
            assert(none.cagr - heavy.cagr > 0.005,
                `effect implausibly small (${none.cagr - heavy.cagr}) — check the purchase is still at target weights`);
        },
    },
    {
        id: 'zero-initial-is-finite',
        why: 'guide.html scenario 4. A $0 opening balance with contributions must produce finite metrics, not Infinity and NaN.',
        needs: ['SPY'],
        async run(assert) {
            const { aligned, list } = await block(['SPY'], 1827);
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 0, contribution: 500 });
            const m = metrics(sim.nav, aligned.dates, { annualization: annualizationFor(list) });
            for (const key of ['cagr', 'vol', 'sharpe', 'maxDD', 'best', 'worst']) {
                assert(Number.isFinite(m[key]), `${key} is ${m[key]}`);
            }
            assert(m.cagr > -1 && m.cagr < 5, `CAGR implausible: ${m.cagr}`);
        },
    },
    {
        id: 'single-asset-equals-price-return',
        why: 'A 100% one-asset buy-and-hold with no costs must return exactly the asset price return. Any deviation means the unit accounting leaks.',
        needs: ['SPY'],
        async run(assert) {
            const { aligned } = await block(['SPY'], 1827);
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 10000 });
            const p = aligned.prices.SPY;
            const expected = p[p.length - 1] / p[0] - 1;
            const m = metrics(sim.nav, aligned.dates, {});
            assert(Math.abs(m.twr - expected) < 1e-12, `${m.twr} vs ${expected}`);
        },
    },
    {
        id: 'xirr-known-values',
        why: 'Closed-form checks on the money-weighted solver.',
        needs: [],
        async run(assert) {
            const y = 365.25 * 86400000;
            const t0 = Date.UTC(2020, 0, 1);
            const r1 = xirr([{ t: t0, amount: -100 }, { t: t0 + y, amount: 110 }]);
            assert(Math.abs(r1 - 0.10) < 1e-6, `10% one-year: got ${r1}`);
            const r2 = xirr([{ t: t0, amount: -100 }, { t: t0 + 2 * y, amount: 121 }]);
            assert(Math.abs(r2 - 0.10) < 1e-6, `10% compounded two years: got ${r2}`);
            const r3 = xirr([{ t: t0, amount: -100 }, { t: t0 + y, amount: 100 }]);
            assert(Math.abs(r3) < 1e-6, `flat should be 0%: got ${r3}`);
            const r4 = xirr([{ t: t0, amount: -100 }, { t: t0 + y, amount: 50 }]);
            assert(Math.abs(r4 + 0.5) < 1e-6, `-50%: got ${r4}`);
        },
    },
    {
        id: 'irr-is-solved-to-rate-precision',
        why: 'With a single cash flow the money-weighted and time-weighted returns are the same number, so their gap measures the solver\'s accuracy directly. It used to converge on the size of the NPV, which made precision depend on how large the cash flows were; it now converges on the rate.',
        needs: ['SPY'],
        async run(assert) {
            const { aligned } = await block(['SPY'], 3653);
            const sim = simulate(aligned, { weights: { SPY: 100 }, initial: 10000 });
            const m = metrics(sim.nav, aligned.dates, { annualization: 252 });
            const irr = xirr(sim.flows);
            assert(irr != null, 'no IRR returned');
            assert(Math.abs(irr - m.cagr) < 1e-10, `gap ${Math.abs(irr - m.cagr)} between IRR and CAGR`);

            // Same portfolio scaled up a thousandfold must solve just as precisely.
            const big = simulate(aligned, { weights: { SPY: 100 }, initial: 10000000 });
            const bigIrr = xirr(big.flows);
            assert(Math.abs(bigIrr - m.cagr) < 1e-10, `scale changed precision: gap ${Math.abs(bigIrr - m.cagr)}`);
        },
    },
    {
        id: 'irr-survives-a-century-of-contributions',
        why: 'The deep-history preset with a monthly contribution is an ordinary thing to ask for, and it returned no money-weighted return at all: over a 100-year horizon the bracket endpoints overflow to +/-Infinity and their sum is NaN, which the solver read as "no root".',
        needs: ['USMKT'],
        async run(assert) {
            const { aligned } = await block(['USMKT'], null);
            const sim = simulate(aligned, { weights: { USMKT: 100 }, initial: 0, contribution: 500 });
            const irr = xirr(sim.flows);
            assert(irr != null, 'IRR came back null on a century-long contribution schedule');
            assert(Number.isFinite(irr) && irr > 0 && irr < 1, `implausible IRR: ${irr}`);
        },
    },
    {
        id: 'costs-only-hurt',
        why: 'Adding transaction costs and fees can never improve the final value or the time-weighted return.',
        needs: ['AAPL', 'MSFT', 'NVDA'],
        async run(assert) {
            const { aligned, list } = await block(['AAPL', 'MSFT', 'NVDA'], 1827);
            const weights = { AAPL: 34, MSFT: 33, NVDA: 33 };
            const ann = annualizationFor(list);
            const free = simulate(aligned, { weights, initial: 10000, rebalanceDays: 90 });
            const paid = simulate(aligned, { weights, initial: 10000, rebalanceDays: 90, costBps: 25, feeBps: 50 });
            assert(paid.totals.finalValue < free.totals.finalValue,
                `costed final ${paid.totals.finalValue} >= free ${free.totals.finalValue}`);
            const mf = metrics(free.nav, aligned.dates, { annualization: ann });
            const mp = metrics(paid.nav, aligned.dates, { annualization: ann });
            assert(mp.cagr < mf.cagr, `costed CAGR ${mp.cagr} >= free ${mf.cagr}`);
            assert(paid.totals.costsPaid > 0, 'no costs were charged');
        },
    },
    {
        id: 'rebalance-costs-hit-twr-purchase-costs-do-not',
        why: 'The modelling contract stated in engine.js. Purchase costs are borne by the purchaser and must leave the strategy return untouched; rebalance costs come out of the fund and must reduce it.',
        needs: ['AAPL', 'MSFT'],
        async run(assert) {
            const { aligned, list } = await block(['AAPL', 'MSFT'], 1827);
            const weights = { AAPL: 50, MSFT: 50 };
            const ann = annualizationFor(list);
            // Buy-and-hold with contributions: costs are all purchase costs.
            const a = metrics(simulate(aligned, { weights, initial: 10000, contribution: 500 }).nav,
                aligned.dates, { annualization: ann });
            const b = metrics(simulate(aligned, { weights, initial: 10000, contribution: 500, costBps: 50 }).nav,
                aligned.dates, { annualization: ann });
            assert(Math.abs(a.cagr - b.cagr) < 1e-12,
                `purchase costs moved TWR: ${a.cagr} vs ${b.cagr}`);
            // Now with rebalancing, the same cost must bite.
            const c = metrics(simulate(aligned, { weights, initial: 10000, rebalanceDays: 30 }).nav,
                aligned.dates, { annualization: ann });
            const d = metrics(simulate(aligned, { weights, initial: 10000, rebalanceDays: 30, costBps: 50 }).nav,
                aligned.dates, { annualization: ann });
            assert(d.cagr < c.cagr, `rebalance costs did not reduce TWR: ${d.cagr} vs ${c.cagr}`);
        },
    },
    {
        id: 'alignment-seeds-backwards',
        why: 'LOCF must seed from the last observation at or before the window start. Seeding forward fabricates a jump on bar 0 — this produced infinite wealth in an earlier prototype.',
        needs: ['SPY', 'AAPL'],
        async run(assert) {
            const spy = await load('SPY');
            const aapl = await load('AAPL');
            const a = alignSeries([spy, aapl]);
            for (const id of ['SPY', 'AAPL']) {
                assert(a.prices[id].every(v => Number.isFinite(v) && v > 0),
                    `${id} has a non-finite or non-positive aligned price`);
            }
            assert(a.dates.length > 0, 'empty axis');
            assert(a.dates.every((t, i) => i === 0 || t > a.dates[i - 1]), 'axis not strictly ascending');
        },
    },
    {
        id: 'weights-are-normalised',
        why: 'Weights summing to 200 must behave exactly like the same ratios summing to 100 — the UI enforces 100 but the engine must not depend on it.',
        needs: ['AAPL', 'MSFT'],
        async run(assert) {
            const { aligned } = await block(['AAPL', 'MSFT'], 1827);
            const a = simulate(aligned, { weights: { AAPL: 50, MSFT: 50 }, initial: 10000 });
            const b = simulate(aligned, { weights: { AAPL: 100, MSFT: 100 }, initial: 10000 });
            assert(Math.abs(a.totals.finalValue - b.totals.finalValue) < 1e-6,
                `${a.totals.finalValue} vs ${b.totals.finalValue}`);
        },
    },
    {
        id: 'sweep-measures-the-users-own-window',
        why: 'The base-rate strip sits directly under the "vs benchmark" tile and draws a conclusion from it. Those two panels must describe the SAME window. They did not: the sweep snapped to the nearest sampled start (up to 19 sessions away, and the user\'s own start was structurally out of range), so the app\'s default view printed +3.13%/yr and "fairly typical" under a tile reading -3.04%.',
        needs: ['AAPL', 'MSFT', 'NVDA', 'SPY'],
        async run(assert) {
            const ids = ['AAPL', 'MSFT', 'NVDA'];
            const weights = { AAPL: 40, MSFT: 30, NVDA: 30 };
            const list = await Promise.all(ids.map(load));
            const spy = await load('SPY');
            const full = alignSeries(list);
            const ann = annualizationFor(list);

            for (const days of [183, 366, 731, 1827]) {
                const end = full.dates[full.dates.length - 1];
                const win = sliceAligned(full, end - days * 86400000, end);

                // What the results panel shows.
                const pm = metrics(simulate(win, { weights, initial: 10000 }).nav, win.dates, { annualization: ann });
                const bproj = projectOnAxis(spy, win.dates);
                const bm = metrics(
                    simulate({ dates: win.dates, prices: { SPY: bproj.values } },
                        { weights: { SPY: 100 }, initial: 10000 }).nav,
                    win.dates, { annualization: ann });
                const tileMargin = pm.cagr - bm.cagr;

                // What the sweep claims about that same window.
                const proj = projectOnAxis(spy, full.dates);
                const block = { dates: full.dates, prices: { ...full.prices, SPY: proj.values } };
                const userStart = full.dates.indexOf(win.dates[0]);
                const sw = baseRateSweep(block, {
                    weights, benchmark: 'SPY', windowBars: win.dates.length,
                    annualization: ann, userStartIndex: userStart,
                });

                assert(sw.userMargin != null, `${days}d: sweep reported no user window at all`);
                assert(Math.abs(sw.userMargin - tileMargin) < 1e-12,
                    `${days}d: sweep says ${sw.userMargin} but the tile says ${tileMargin}`);
                assert(sw.userStartIndex === userStart,
                    `${days}d: sweep resolved start ${sw.userStartIndex}, user's is ${userStart}`);
            }
        },
    },
    {
        id: 'deep-history-contains-the-crashes',
        why: 'The deep spine exists so the tool has seen a bad decade. If these are absent the parse is wrong and every long-window claim is worthless.',
        needs: ['USMKT'],
        async run(assert) {
            const { aligned } = await block(['USMKT'], null);
            const sim = simulate(aligned, { weights: { USMKT: 100 }, initial: 10000 });
            const m = metrics(sim.nav, aligned.dates, { annualization: 252 });
            assert(m.maxDD < -0.80 && m.maxDD > -0.92,
                `Depression drawdown out of range: ${(m.maxDD * 100).toFixed(2)}%`);
            assert(new Date(m.ddTo).getUTCFullYear() === 1932,
                `deepest trough should be 1932, got ${iso(m.ddTo)}`);
            assert(m.cagr > 0.08 && m.cagr < 0.12,
                `long-run CAGR implausible: ${(m.cagr * 100).toFixed(2)}%`);
        },
    },
];

// ── Runner ──────────────────────────────────────────────────────────

function diff(a, b, prefix = '') {
    const out = [];
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
    for (const k of keys) {
        const x = a?.[k], y = b?.[k];
        if (typeof x === 'number' && typeof y === 'number') {
            if (Math.abs(x - y) > TOL) out.push(`${prefix}${k}: golden ${x} → now ${y}`);
        } else if (JSON.stringify(x) !== JSON.stringify(y)) {
            out.push(`${prefix}${k}: golden ${JSON.stringify(x)} → now ${JSON.stringify(y)}`);
        }
    }
    return out;
}

async function main() {
    let goldens = { scenarios: {} };
    try { goldens = JSON.parse(await fs.readFile(GOLDENS, 'utf8')); } catch { /* first run */ }

    const results = {};
    let failed = 0, skipped = 0, passed = 0;

    console.log('── Scenarios ' + '─'.repeat(52));
    for (const sc of SCENARIOS) {
        const missing = [];
        for (const n of sc.needs) if (!(await have(n))) missing.push(n);
        if (missing.length) {
            console.log(`  ○ ${sc.id.padEnd(34)} skipped — no data for ${missing.join(', ')}`);
            skipped++;
            continue;
        }
        let out;
        try {
            out = await sc.run();
        } catch (err) {
            console.log(`  ✗ ${sc.id.padEnd(34)} threw: ${err.message}`);
            failed++;
            continue;
        }
        results[sc.id] = out;

        if (RECORD || !goldens.scenarios?.[sc.id]) {
            console.log(`  ● ${sc.id.padEnd(34)} recorded`);
            if (VERBOSE) console.log('      ' + JSON.stringify(out));
            continue;
        }
        const d = diff(goldens.scenarios[sc.id].values, out, '      ');
        if (d.length) {
            console.log(`  ✗ ${sc.id.padEnd(34)} ${d.length} value(s) moved`);
            d.forEach(line => console.log(line));
            failed++;
        } else {
            console.log(`  ✓ ${sc.id.padEnd(34)} ${Object.keys(out).length} values stable`);
            if (VERBOSE) console.log('      ' + JSON.stringify(out));
            passed++;
        }
    }

    console.log('\n── Properties ' + '─'.repeat(51));
    for (const p of PROPERTIES) {
        const missing = [];
        for (const n of p.needs) if (!(await have(n))) missing.push(n);
        if (missing.length) {
            console.log(`  ○ ${p.id.padEnd(42)} skipped — no data for ${missing.join(', ')}`);
            skipped++;
            continue;
        }
        const failures = [];
        const assert = (cond, msg) => { if (!cond) failures.push(msg); };
        try {
            await p.run(assert);
        } catch (err) {
            failures.push(`threw: ${err.message}`);
        }
        if (failures.length) {
            console.log(`  ✗ ${p.id.padEnd(42)} ${failures.length} assertion(s) failed`);
            failures.forEach(f => console.log(`      ${f}`));
            failed++;
        } else {
            console.log(`  ✓ ${p.id.padEnd(42)} holds`);
            passed++;
        }
    }

    if (RECORD || Object.keys(goldens.scenarios || {}).length === 0) {
        const payload = {
            recorded: new Date().toISOString(),
            engine: 'assets/engine.js',
            note: 'Regenerate with `node scripts/replay.mjs --record`. A value moving here is either an intended fix (say which, in the commit message) or a regression. There is no third option.',
            scenarios: Object.fromEntries(SCENARIOS
                .filter(s => results[s.id])
                .map(s => [s.id, {
                    note: s.note,
                    ...(s.changed ? { changedByTheFix: s.changed } : {}),
                    values: results[s.id],
                }])),
        };
        await fs.mkdir(path.dirname(GOLDENS), { recursive: true });
        await fs.writeFile(GOLDENS, JSON.stringify(payload, null, 2) + '\n');
        console.log(`\nWrote ${path.relative(process.cwd(), GOLDENS)} (${Object.keys(payload.scenarios).length} scenarios).`);
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
