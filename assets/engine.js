// Chronoticker engine — the shared simulation and measurement core.
//
// Imported by index.html in the browser and by scripts/replay.mjs in Node,
// so the numbers the site prints are the same numbers the goldens check.
// Zero dependencies, ES module, no DOM access.
//
// ── The one idea that makes the metrics honest ──────────────────────
//
// A portfolio you keep adding money to has two different returns, and
// conflating them is the defect this module exists to fix:
//
//   Time-weighted (TWR/CAGR)  — how good was the STRATEGY? A deposit is
//                               not a gain, and depositing during a crash
//                               must not make the drawdown look shallower.
//   Money-weighted (IRR)      — how did YOUR MONEY do? Timing of every
//                               contribution matters, by design.
//
// One honest qualification on the first of those. Contributions cannot
// MECHANICALLY inflate a time-weighted number here — that was the defect.
// But they are bought at the TARGET weights, so in a multi-asset portfolio
// that is drifting because you never rebalance, each contribution nudges it
// back toward target. That is a genuine change to the strategy, not an
// artifact, and the time-weighted return moves with it. Measured on a
// 40/30/30 basket over ten years, a $5,000 monthly contribution lowers the
// growth rate from 48.35% to 45.47% purely by holding the winner's weight
// down. The invariance is therefore exact for a single asset, and exact for
// a multi-asset basket rebalanced on the contribution cadence; elsewhere the
// difference is real economics and the UI says so.
//
// We get both by running the portfolio as a fund. Every dollar that
// enters buys units at that day's net asset value, so the fund gets
// bigger without its per-unit price moving. All risk metrics (vol,
// Sharpe, drawdown, best/worst day) read the per-unit NAV index; the
// money question is answered separately by an IRR over the actual cash
// flows. The previous implementation computed every risk metric on the
// raw dollar curve, which reported a 33.20% CAGR where the truth was
// 15.01% and a -27.7% drawdown where the truth was -49.3%.

// ── Constants ───────────────────────────────────────────────────────

/** Bars per year, per calendar. Drives every annualization. */
export const ANNUALIZATION = { sessions: 252, continuous: 365 };

const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;

// ── Data loading ────────────────────────────────────────────────────

/**
 * Normalize a schema-v1 data file into the shape the engine works with.
 * Timestamps arrive as unix seconds (midnight UTC) and become ms, because
 * that is what Date and Chart.js want.
 */
export function toSeries(file) {
    if (!file || file.schema !== 1) {
        throw new Error(`${file?.id || 'series'}: not schema v1 (got ${file?.schema})`);
    }
    return {
        id:       file.id,
        name:     file.name || file.id,
        cls:      file.class,
        calendar: file.calendar || 'sessions',
        returns:  file.returns || null,
        source:   file.source,
        updated:  file.updated,
        dates:    file.timestamps.map(t => t * 1000),
        values:   file.closes,
    };
}

/** Bars per year for a basket: continuous wins if anything in it trades daily. */
export function annualizationFor(seriesList) {
    return seriesList.some(s => s.calendar === 'continuous')
        ? ANNUALIZATION.continuous
        : ANNUALIZATION.sessions;
}

// ── Alignment ───────────────────────────────────────────────────────

/**
 * Put several series on one date axis.
 *
 * The axis is the union of every date, clamped to the range all of them
 * actually cover, with last-observation-carried-forward for any gap. For
 * a basket of US equities the union equals the intersection (they share a
 * session calendar), so this is a no-op there — it matters when an
 * instrument is missing an odd bar, and it is the only correct approach
 * once a 365-day-per-year instrument is in the basket.
 *
 * The LOCF seed is the subtle part: an instrument's value on the first
 * axis date is its last close AT OR BEFORE that date, not its first close
 * after it. Seeding forward instead produces a fabricated jump on bar 0.
 */
export function alignSeries(seriesList) {
    if (!seriesList.length) throw new Error('alignSeries: nothing to align');

    const start = Math.max(...seriesList.map(s => s.dates[0]));
    const end   = Math.min(...seriesList.map(s => s.dates[s.dates.length - 1]));
    if (!(start <= end)) {
        const late = seriesList.reduce((a, b) => (a.dates[0] > b.dates[0] ? a : b));
        const early = seriesList.reduce((a, b) =>
            (a.dates[a.dates.length - 1] < b.dates[b.dates.length - 1] ? a : b));
        throw new Error(
            `No overlapping dates: ${late.id} starts ${iso(late.dates[0])} but ` +
            `${early.id} ends ${iso(early.dates[early.dates.length - 1])}.`);
    }

    const axis = [...new Set(seriesList.flatMap(s => s.dates))]
        .filter(t => t >= start && t <= end)
        .sort((a, b) => a - b);

    const prices = {};
    for (const s of seriesList) {
        const out = new Array(axis.length);
        let i = 0, last = null;
        // Seed: the last observation at or before the axis start.
        while (i < s.dates.length && s.dates[i] <= axis[0]) last = s.values[i++];
        for (let k = 0; k < axis.length; k++) {
            while (i < s.dates.length && s.dates[i] <= axis[k]) last = s.values[i++];
            out[k] = last;
        }
        if (out[0] == null) throw new Error(`${s.id}: no observation at or before ${iso(axis[0])}`);
        prices[s.id] = out;
    }

    return {
        dates: axis,
        prices,
        // Which instrument is responsible for each end of the window — the
        // UI states this so a short window is never a mystery.
        limitedBy: {
            start: seriesList.filter(s => s.dates[0] === start).map(s => s.id),
            end:   seriesList.filter(s => s.dates[s.dates.length - 1] === end).map(s => s.id),
        },
    };
}

/**
 * Put ONE series onto an existing date axis, without letting it influence
 * that axis.
 *
 * This is how the benchmark gets drawn. Adding SPY to alignSeries would
 * silently truncate any window that starts before SPY existed — a 1970s
 * backtest would get clamped to 1993 with no explanation. Instead the
 * portfolio defines the axis and the benchmark is projected onto it,
 * returning null when it simply does not cover the window so the UI can
 * say why the comparison line is missing.
 */
export function projectOnAxis(series, dates) {
    if (series.dates[0] > dates[0]) return null;               // starts too late
    if (series.dates[series.dates.length - 1] < dates[0]) return null;  // ends too early
    const out = new Array(dates.length);
    let i = 0, last = null;
    while (i < series.dates.length && series.dates[i] <= dates[0]) last = series.values[i++];
    for (let k = 0; k < dates.length; k++) {
        while (i < series.dates.length && series.dates[i] <= dates[k]) last = series.values[i++];
        out[k] = last;
    }
    if (out[0] == null) return null;
    // If the benchmark ran out partway, say so rather than drawing a flat line.
    const coversTo = series.dates[series.dates.length - 1];
    return { values: out, partial: coversTo < dates[dates.length - 1], coversTo };
}

/** Slice an aligned block to a date range (ms), inclusive. */
export function sliceAligned(aligned, fromMs, toMs) {
    const lo = aligned.dates.findIndex(t => t >= (fromMs ?? -Infinity));
    let hi = aligned.dates.length - 1;
    if (toMs != null) while (hi >= 0 && aligned.dates[hi] > toMs) hi--;
    if (lo < 0 || hi < lo) throw new Error('Selected range contains no trading days.');
    const prices = {};
    for (const k of Object.keys(aligned.prices)) prices[k] = aligned.prices[k].slice(lo, hi + 1);
    return { ...aligned, dates: aligned.dates.slice(lo, hi + 1), prices };
}

// ── Simulation ──────────────────────────────────────────────────────

/**
 * Run a portfolio forward.
 *
 * @param aligned        output of alignSeries (already sliced to the window)
 * @param weights        { SYM: percent } summing to 100
 * @param initial        opening lump sum in dollars (may be 0)
 * @param contribution   dollars added every `contributionDays`
 * @param contributionDays  calendar days between contributions (7/14/30)
 * @param rebalanceDays  calendar days between rebalances, 0 = never
 * @param costBps        one-way transaction cost in basis points of notional traded
 * @param feeBps         annual portfolio fee in basis points, accrued daily
 *
 * Cost treatment, stated because it is a real modelling choice:
 *   - Costs on a purchase are borne by the purchaser: the net amount buys
 *     units, so a contribution never dilutes existing units and never
 *     moves the NAV. Purchase costs therefore show up in the money-
 *     weighted return and the final value, not in the strategy's CAGR.
 *   - Costs on a REBALANCE come out of the fund, because rebalancing is a
 *     decision the strategy made. Those do reduce NAV per unit, which is
 *     exactly what makes a costed comparison of rebalancing cadences mean
 *     something.
 *   - The annual fee accrues daily against the whole portfolio and always
 *     reduces NAV.
 */
export function simulate(aligned, {
    weights,
    initial = 0,
    contribution = 0,
    contributionDays = 30,
    rebalanceDays = 0,
    costBps = 0,
    feeBps = 0,
} = {}) {
    const syms = Object.keys(weights).filter(s => weights[s] > 0);
    if (!syms.length) throw new Error('simulate: no positive weights');
    for (const s of syms) if (!aligned.prices[s]) throw new Error(`simulate: no prices for ${s}`);

    const n = aligned.dates.length;
    const wsum = syms.reduce((a, s) => a + weights[s], 0);
    const w = {};
    syms.forEach(s => w[s] = weights[s] / wsum);

    const cost = costBps / 10000;
    const feeDaily = feeBps / 10000 / ANNUALIZATION.sessions;

    const units = {};
    syms.forEach(s => units[s] = 0);

    const nav      = new Array(n).fill(null);   // per-unit index; null before funding
    const equity   = new Array(n).fill(0);      // dollar value
    const basis    = new Array(n).fill(0);      // cumulative contributed (cost basis)
    const flows    = [];                        // for the IRR
    const purchases = [];                       // ledger rows

    let navUnits = 0;
    let contributed = 0;
    let costsPaid = 0;   // transaction costs, in dollars
    let feesPaid = 0;    // management fee drag, in dollars
    let lastContribution = 0, lastRebalance = 0;

    // Buy `amount` gross across the target weights at bar t. Returns the
    // net amount that actually entered the portfolio.
    const buy = (amount, t, kind) => {
        const fee = amount * cost;
        const net = amount - fee;
        costsPaid += fee;
        syms.forEach(s => units[s] += net * w[s] / aligned.prices[s][t]);
        contributed += amount;
        flows.push({ t: aligned.dates[t], amount: -amount });
        purchases.push({
            t: aligned.dates[t], kind, gross: amount, cost: fee, net,
            nav: navUnits > 0 ? nav[t] : 1,
        });
        return net;
    };

    for (let t = 0; t < n; t++) {
        // Accrue the annual fee before valuing, so day one is not free.
        if (feeDaily > 0 && t > 0) {
            let before = 0;
            syms.forEach(s => before += units[s] * aligned.prices[s][t]);
            feesPaid += before * feeDaily;
            syms.forEach(s => units[s] *= (1 - feeDaily));
        }

        let value = 0;
        syms.forEach(s => value += units[s] * aligned.prices[s][t]);
        if (navUnits > 0) nav[t] = value / navUnits;

        // ── Funding events ──
        const dueInitial = t === 0 && initial > 0;
        const dueContribution = contribution > 0 && t > 0 &&
            (aligned.dates[t] - aligned.dates[lastContribution]) / DAY_MS >= contributionDays;

        if (dueInitial || dueContribution) {
            const amount = dueInitial ? initial : contribution;
            if (navUnits === 0) {
                // First money in: this bar is where the index starts.
                nav[t] = 1;
                const net = buy(amount, t, dueInitial ? 'initial' : 'contribution');
                navUnits = net;
            } else {
                const net = buy(amount, t, dueInitial ? 'initial' : 'contribution');
                navUnits += net / nav[t];
            }
            if (dueContribution) lastContribution = t;
            // Revalue after the purchase so the equity curve shows the deposit.
            value = 0;
            syms.forEach(s => value += units[s] * aligned.prices[s][t]);
        }

        // ── Rebalance ──
        const dueRebalance = rebalanceDays > 0 && t > 0 && navUnits > 0 &&
            (aligned.dates[t] - aligned.dates[lastRebalance]) / DAY_MS >= rebalanceDays;

        if (dueRebalance) {
            let turnover = 0;
            syms.forEach(s => {
                const held = units[s] * aligned.prices[s][t];
                turnover += Math.abs(value * w[s] - held);
            });
            turnover /= 2;                       // each dollar sold buys a dollar
            const fee = turnover * cost * 2;     // charged on both legs
            costsPaid += fee;
            const after = value - fee;
            syms.forEach(s => units[s] = after * w[s] / aligned.prices[s][t]);
            value = after;
            lastRebalance = t;
        }

        equity[t] = value;
        basis[t] = contributed;
    }

    if (navUnits === 0) {
        throw new Error('No money was ever invested — set an initial amount or a contribution.');
    }

    // Final value closes the IRR cash-flow series.
    flows.push({ t: aligned.dates[n - 1], amount: equity[n - 1] });

    const perAsset = {};
    syms.forEach(s => {
        const startPrice = aligned.prices[s][firstFunded(nav)];
        const endPrice = aligned.prices[s][n - 1];
        const finalValue = units[s] * endPrice;
        perAsset[s] = {
            weight: weights[s],
            startPrice,
            endPrice,
            priceReturn: (endPrice - startPrice) / startPrice,
            finalValue,
            share: finalValue / equity[n - 1],
        };
    });

    return {
        dates: aligned.dates,
        nav, equity, basis, flows, purchases, perAsset,
        firstFundedIndex: firstFunded(nav),
        totals: {
            contributed,
            costsPaid,
            feesPaid,
            totalFriction: costsPaid + feesPaid,
            finalValue: equity[n - 1],
            profit: equity[n - 1] - contributed,
            contributions: purchases.length,
        },
    };
}

function firstFunded(nav) {
    for (let i = 0; i < nav.length; i++) if (nav[i] != null) return i;
    return 0;
}

// ── Metrics ─────────────────────────────────────────────────────────

/**
 * Risk and return metrics, computed on the per-unit NAV index so that
 * contributions cannot touch them.
 *
 * @param rfDaily  optional array of simple daily risk-free rates aligned
 *                 to `dates`. Supplied → Sharpe and Sortino are excess-
 *                 return based. Omitted → they assume cash yields zero,
 *                 which flatters every result and is why this parameter
 *                 exists.
 */
export function metrics(nav, dates, { annualization = 252, rfDaily = null } = {}) {
    const i0 = firstFunded(nav);
    const navs = nav.slice(i0).filter(v => v != null);
    const ds = dates.slice(i0);
    if (navs.length < 2) {
        return { insufficient: true, bars: navs.length };
    }

    const first = navs[0], last = navs[navs.length - 1];
    const years = (ds[ds.length - 1] - ds[0]) / YEAR_MS;

    const twr = last / first - 1;
    const cagr = years > 0 ? Math.pow(last / first, 1 / years) - 1 : 0;

    // Drawdown, with the dates so the UI can say when it happened.
    let peak = navs[0], peakAt = 0, maxDD = 0, ddPeakAt = 0, ddTroughAt = 0;
    for (let i = 0; i < navs.length; i++) {
        if (navs[i] > peak) { peak = navs[i]; peakAt = i; }
        const dd = navs[i] / peak - 1;
        if (dd < maxDD) { maxDD = dd; ddPeakAt = peakAt; ddTroughAt = i; }
    }

    const rets = [];
    for (let i = 1; i < navs.length; i++) rets.push(navs[i] / navs[i - 1] - 1);

    const rf = [];
    if (rfDaily) for (let i = 1; i < navs.length; i++) rf.push(rfDaily[i0 + i] ?? 0);
    const excess = rets.map((r, i) => r - (rf[i] ?? 0));

    const mean = avg(rets);
    const vol = stdev(rets, mean) * Math.sqrt(annualization);

    const exMean = avg(excess);
    const exSd = stdev(excess, exMean);
    const sharpe = exSd > 0 ? (exMean * annualization) / (exSd * Math.sqrt(annualization)) : 0;

    // Sortino: only downside deviation of excess returns is penalised.
    const down = excess.filter(r => r < 0);
    const downSd = down.length ? Math.sqrt(down.reduce((s, r) => s + r * r, 0) / excess.length) : 0;
    const sortino = downSd > 0 ? (exMean * annualization) / (downSd * Math.sqrt(annualization)) : 0;

    // Single pass, not Math.max(...rets): the century-long series has 26,273
    // daily returns and spreading an array that size into a call is close to
    // the engine's argument limit — it would throw on a longer history rather
    // than degrade, and it scans the array four times to find two values.
    let best = -Infinity, worst = Infinity, bestAt = 0, worstAt = 0;
    for (let i = 0; i < rets.length; i++) {
        if (rets[i] > best) { best = rets[i]; bestAt = i; }
        if (rets[i] < worst) { worst = rets[i]; worstAt = i; }
    }

    return {
        insufficient: false,
        bars: navs.length,
        years,
        twr, cagr, maxDD, vol, sharpe, sortino,
        ddFrom: ds[ddPeakAt], ddTo: ds[ddTroughAt],
        best, worst,
        bestAt: ds[bestAt + 1],
        worstAt: ds[worstAt + 1],
        rfUsed: !!rfDaily,
        rfAnnual: rfDaily ? avg(rf) * annualization : 0,
    };
}

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);

// ── Money-weighted return ───────────────────────────────────────────

/**
 * Annualized internal rate of return over dated cash flows.
 *
 * Bisection rather than Newton: it cannot diverge, and a backtester that
 * silently returns NaN for an awkward contribution schedule is worse than
 * one that is a few microseconds slower. Returns null when no sign change
 * exists (e.g. everything was lost).
 */
export function xirr(flows, { lo = -0.9999, hi = 100, tol = 1e-12, maxIter = 200 } = {}) {
    if (flows.length < 2) return null;
    const t0 = flows[0].t;
    const npv = rate => flows.reduce((s, f) =>
        s + f.amount / Math.pow(1 + rate, (f.t - t0) / YEAR_MS), 0);

    // Find a bracket by scanning, rather than assuming the extremes give one.
    //
    // Over a long horizon the extremes are unusable: at rate ≈ -1 the discount
    // factor for a 100-year flow underflows to zero, so positive flows divide
    // to +Infinity and negative ones to -Infinity, and their sum is NaN. A
    // century-long run with monthly contributions — the deep-history preset
    // with a contribution, i.e. an ordinary thing to ask for — therefore
    // reported no money-weighted return at all. Walking a ladder of candidate
    // rates and taking the first adjacent pair with finite opposite signs
    // works for both that case and the ordinary ones.
    const ladder = [lo, -0.999, -0.99, -0.9, -0.75, -0.5, -0.25, -0.1, 0,
                    0.1, 0.25, 0.5, 1, 2, 5, 10, 25, hi];
    let a = null, b = null, fa = 0, fb = 0;
    let prevRate = null, prevNpv = null;
    for (const rate of ladder) {
        const v = npv(rate);
        if (!Number.isFinite(v)) { prevRate = null; prevNpv = null; continue; }
        if (v === 0) return rate;
        if (prevNpv !== null && Math.sign(v) !== Math.sign(prevNpv)) {
            a = prevRate; fa = prevNpv; b = rate; fb = v;
            break;
        }
        prevRate = rate; prevNpv = v;
    }
    if (a === null) return null;     // no sign change anywhere on the ladder
    const sa = Math.sign(fa);

    // Converge on the RATE, not on the size of the NPV. An NPV tolerance
    // means the answer's precision depends on how big the cash flows are —
    // the same portfolio scaled up by 1000x would resolve to a coarser rate.
    // Bisection needs only ~50 halvings to pin the rate to 1e-12 from any
    // starting bracket, so this costs nothing and makes the result stable.
    for (let i = 0; i < maxIter; i++) {
        const mid = (a + b) / 2;
        const fm = npv(mid);
        if (Number.isNaN(fm)) return null;
        if (fm === 0 || (b - a) / 2 < tol) return mid;
        if (Math.sign(fm) === sa) a = mid; else b = mid;
    }
    return (a + b) / 2;
}

// ── Inflation ───────────────────────────────────────────────────────

/**
 * Interpolate a monthly CPI series onto a daily date axis.
 * Linear between observations; flat before the first and after the last,
 * because inventing inflation beyond the published data would be a lie
 * the user could not see.
 */
export function cpiOnAxis(cpi, dates) {
    const out = new Array(dates.length);
    let i = 0;
    for (let k = 0; k < dates.length; k++) {
        while (i < cpi.dates.length - 2 && cpi.dates[i + 1] <= dates[k]) i++;
        const t0 = cpi.dates[i], t1 = cpi.dates[i + 1];
        const v0 = cpi.values[i], v1 = cpi.values[i + 1];
        if (dates[k] <= t0 || t1 == null) out[k] = v0;
        else if (dates[k] >= t1) out[k] = v1;
        else out[k] = v0 + (v1 - v0) * (dates[k] - t0) / (t1 - t0);
    }
    return out;
}

/**
 * Restate a NAV index in constant purchasing power.
 *
 * `base` is the CPI level to express everything in. It defaults to the last
 * value on the axis, but a caller labelling its output "today's dollars"
 * must pass TODAY's CPI — otherwise a window ending in 1932 is restated in
 * 1932 dollars while the UI claims 2026, which on the shipped Depression
 * preset is a 24x misstatement.
 */
export function deflate(nav, cpiAxis, base = cpiAxis[cpiAxis.length - 1]) {
    return nav.map((v, i) => (v == null ? null : v * base / cpiAxis[i]));
}

/**
 * Convert a nominal daily risk-free series into a real one, given the CPI
 * on the same axis.
 *
 * Needed because measuring a portfolio in real terms while charging it a
 * nominal risk-free rate subtracts inflation twice: once from the returns,
 * once again inside the excess. On the shipped data that flipped the sign
 * of Sharpe on several windows.
 *
 * Exact Fisher relation per bar, not the additive approximation:
 *   1 + r_real = (1 + r_nom) / (1 + inflation)
 */
export function realRfOnAxis(rfDaily, cpiAxis) {
    const out = new Array(rfDaily.length);
    out[0] = rfDaily[0] ?? 0;
    for (let i = 1; i < rfDaily.length; i++) {
        const infl = cpiAxis[i] / cpiAxis[i - 1] - 1;
        out[i] = (1 + (rfDaily[i] ?? 0)) / (1 + infl) - 1;
    }
    return out;
}

/**
 * Restate dated cash flows in the purchasing power of the final date.
 *
 * Without this, a real-terms run compares a final value in today's dollars
 * against contributions counted at face value — so $10,000 invested in 1926
 * is treated as $10,000 of today's money rather than roughly $176,000 of it.
 * That understates what you gave up and overstates the profit, and the error
 * grows with the length of the window. It is the difference between "8% a
 * year through the 1970s" and "lost money in real terms".
 */
export function deflateFlows(flows, dates, cpiAxis, base = cpiAxis[cpiAxis.length - 1]) {
    const idx = new Map(dates.map((t, i) => [t, i]));
    return flows.map(f => {
        const i = idx.get(f.t);
        const c = i == null ? base : cpiAxis[i];
        return { t: f.t, amount: f.amount * base / c };
    });
}

/** Daily risk-free rates on an axis, from a schema-v1 RF series. */
export function rfOnAxis(rf, dates) {
    const out = new Array(dates.length).fill(0);
    let i = 0, last = 0;
    while (i < rf.dates.length && rf.dates[i] <= dates[0]) last = rf.values[i++];
    for (let k = 0; k < dates.length; k++) {
        while (i < rf.dates.length && rf.dates[i] <= dates[k]) last = rf.values[i++];
        out[k] = last;
    }
    return out;
}

// ── Base rates ──────────────────────────────────────────────────────

/**
 * The antidote to the single-window backtest.
 *
 * One run tells you what happened from one arbitrary start date. This
 * replays the identical configuration from every start date the data
 * allows and reports how often it actually won. A configuration that beat
 * the benchmark in 9 of 10 windows is evidence; one that beat it in the
 * window you happened to pick is an anecdote.
 *
 * Both sides are simulated with the same contribution schedule and costs,
 * and compared on time-weighted return, so the comparison is about the
 * allocation and nothing else.
 */
export function baseRateSweep(aligned, {
    weights, benchmark, windowBars, stepBars = 21,
    rebalanceDays = 0, costBps = 0, feeBps = 0,
    annualization = 252, userStartIndex = null, maxWindows = 400,
} = {}) {
    const n = aligned.dates.length;
    if (windowBars >= n) {
        return { windows: [], wins: 0, winRate: null, tooShort: true, needBars: windowBars, haveBars: n };
    }

    // `windowBars` is a COUNT OF BARS, and a window starting at s therefore
    // occupies s .. s + windowBars - 1. This used to slice one bar too many
    // and cap starts at n - windowBars - 1, which put the user's own window
    // (which starts at n - windowBars) permanently one step beyond the swept
    // range — so it could never be sampled, for any range, ever.
    const lastStart = n - windowBars;
    const step = Math.max(stepBars, Math.ceil((lastStart + 1) / maxWindows));

    // One code path for every window, so the user's window and the sampled
    // ones cannot diverge in length or method.
    const evalWindow = (s) => {
        if (s < 0 || s > lastStart) return null;
        const slice = { dates: aligned.dates.slice(s, s + windowBars), prices: {} };
        for (const k of Object.keys(aligned.prices)) {
            slice.prices[k] = aligned.prices[k].slice(s, s + windowBars);
        }
        let port, bench;
        try {
            port = simulate(slice, { weights, initial: 10000, rebalanceDays, costBps, feeBps });
            bench = simulate(slice, { weights: { [benchmark]: 100 }, initial: 10000, costBps, feeBps });
        } catch {
            return null;
        }
        const pm = metrics(port.nav, slice.dates, { annualization });
        const bm = metrics(bench.nav, slice.dates, { annualization });
        if (pm.insufficient || bm.insufficient) return null;
        return {
            startIndex: s,
            from: slice.dates[0],
            to: slice.dates[slice.dates.length - 1],
            portfolio: pm.cagr,
            benchmark: bm.cagr,
            margin: pm.cagr - bm.cagr,
            portfolioDD: pm.maxDD,
            benchmarkDD: bm.maxDD,
            win: pm.cagr > bm.cagr,
        };
    };

    const windows = [];
    for (let s = 0; s <= lastStart; s += step) {
        const w = evalWindow(s);
        if (w) windows.push(w);
    }

    // The user's own window, MEASURED — not the nearest sampled one.
    //
    // This previously snapped to whichever grid point was closest and
    // reported its margin as the user's. Because the grid is `step` bars
    // apart and the user's start was out of range entirely, it always
    // resolved to a window up to 19 sessions away. On the app's default view
    // that printed +3.13%/yr and "your window was fairly typical" directly
    // under a tile reading -3.04% — a sign flip and an inverted verdict in
    // the one feature whose whole job is telling you whether you got lucky.
    // If the window cannot be evaluated, both fields stay null and the UI
    // says nothing rather than inventing a verdict.
    const userWindow = userStartIndex != null ? evalWindow(userStartIndex) : null;

    // Splice the user's window into the sampled set unless the grid already
    // landed on it. It is a legitimate window of this length like any other,
    // and without it the strip has no bar to outline as "yours".
    if (userWindow && !windows.some(w => w.startIndex === userWindow.startIndex)) {
        const at = windows.findIndex(w => w.startIndex > userWindow.startIndex);
        windows.splice(at < 0 ? windows.length : at, 0, userWindow);
    }

    const wins = windows.filter(w => w.win).length;
    const margins = windows.map(w => w.margin).sort((a, b) => a - b);

    const userMargin = userWindow ? userWindow.margin : null;
    const userPercentile = (userWindow && margins.length)
        ? margins.filter(m => m <= userMargin).length / margins.length
        : null;

    return {
        windows, wins, count: windows.length,
        winRate: windows.length ? wins / windows.length : null,
        medianMargin: median(margins),
        worstMargin: margins[0] ?? null,
        bestMargin: margins[margins.length - 1] ?? null,
        userPercentile, userMargin,
        userStartIndex: userWindow ? userWindow.startIndex : null,
        tooShort: false,
        independentWindows: Math.floor(n / windowBars),
    };
}

// ── Lump sum vs. dose ───────────────────────────────────────────────

/**
 * Same portfolio, same total money, same window: invest it all on day one,
 * or spread it over N monthly instalments.
 *
 * Fairness contract: both start with the full amount counted as wealth, so
 * the drawdowns are comparable and the cash cushion is visible rather than
 * hidden. Uninvested cash earns the risk-free rate when one is supplied —
 * assuming idle cash earns nothing is a thumb on the scale for lump sum,
 * and we now have real T-bill data, so there is no excuse for it.
 */
export function duel(aligned, {
    weights, total, deployments = 12, deploymentDays = 30,
    rebalanceDays = 0, costBps = 0, feeBps = 0,
    annualization = 252, rfDaily = null,
} = {}) {
    const n = aligned.dates.length;

    const lump = simulate(aligned, { weights, initial: total, rebalanceDays, costBps, feeBps });

    // Dose: hold cash, deploy a tranche every `deploymentDays`.
    const tranche = total / deployments;
    const syms = Object.keys(weights).filter(s => weights[s] > 0);
    const wsum = syms.reduce((a, s) => a + weights[s], 0);
    const w = {}; syms.forEach(s => w[s] = weights[s] / wsum);

    const units = {}; syms.forEach(s => units[s] = 0);
    const cost = costBps / 10000;
    const feeDaily = feeBps / 10000 / ANNUALIZATION.sessions;

    let cash = total, deployed = 0, costsPaid = 0;
    let lastDeploy = 0, lastReb = 0;
    const wealth = new Array(n), invested = new Array(n);
    const navUnits = total, nav = new Array(n);   // wealth-based NAV, starts at 1
    // The dose side's cash-flow schedule, for its money-weighted return.
    //
    // The whole sum is committed on day one under this comparison's fairness
    // contract — the undeployed part sits in T-bills and is counted as the
    // investor's wealth throughout. So the outflow is the full amount at bar
    // 0, not a tranche at each deployment. Recording tranches as the outflows
    // (as this did) while also handing the investor the interest earned on
    // money the schedule said they had not yet paid in inflated the dose IRR
    // — it credited a return on capital it claimed was never contributed.
    const flows = [{ t: aligned.dates[0], amount: -total }];
    const tranches = [];                          // deployment ledger

    for (let t = 0; t < n; t++) {
        if (feeDaily > 0 && t > 0) syms.forEach(s => units[s] *= (1 - feeDaily));
        if (rfDaily && t > 0 && cash > 0) cash *= (1 + (rfDaily[t] ?? 0));

        let held = 0; syms.forEach(s => held += units[s] * aligned.prices[s][t]);

        const due = t === 0 || ((aligned.dates[t] - aligned.dates[lastDeploy]) / DAY_MS >= deploymentDays);
        if (due && deployed < deployments && cash > 0) {
            const amount = Math.min(tranche, cash);
            const fee = amount * cost;
            costsPaid += fee;
            const net = amount - fee;
            syms.forEach(s => units[s] += net * w[s] / aligned.prices[s][t]);
            cash -= amount;
            deployed++;
            lastDeploy = t;
            tranches.push({ t: aligned.dates[t], gross: amount, cost: fee, net });
            held = 0; syms.forEach(s => held += units[s] * aligned.prices[s][t]);
        }

        if (rebalanceDays > 0 && t > 0 && held > 0 &&
            (aligned.dates[t] - aligned.dates[lastReb]) / DAY_MS >= rebalanceDays) {
            let turnover = 0;
            syms.forEach(s => turnover += Math.abs(held * w[s] - units[s] * aligned.prices[s][t]));
            turnover /= 2;
            const fee = turnover * cost * 2;
            costsPaid += fee;
            const after = held - fee;
            syms.forEach(s => units[s] = after * w[s] / aligned.prices[s][t]);
            held = after;
            lastReb = t;
        }

        wealth[t] = held + cash;
        invested[t] = total - cash;
        nav[t] = wealth[t] / navUnits;
    }

    const lumpM = metrics(lump.nav, aligned.dates, { annualization, rfDaily });
    const doseM = metrics(nav, aligned.dates, { annualization, rfDaily });

    flows.push({ t: aligned.dates[n - 1], amount: wealth[n - 1] });

    return {
        lump: {
            // `flows` is exposed so a caller measuring in real terms can
            // restate them and recompute the IRR. Without it the money-weighted
            // row stays nominal while the rest of the table is deflated.
            wealth: lump.equity, nav: lump.nav, metrics: lumpM, flows: lump.flows,
            final: lump.equity[n - 1], irr: xirr(lump.flows), costs: lump.totals.costsPaid,
        },
        dose: {
            wealth, invested, nav, metrics: doseM, tranches, flows,
            final: wealth[n - 1], irr: xirr(flows), costs: costsPaid,
            deployed, fullyInvestedAt: deployed >= deployments ? lastDeploy : null,
            cashLeft: cash,
        },
        neverFullyInvested: deployed < deployments,
        cashEarnsRf: !!rfDaily,
    };
}

// ── Selection-bias disclosure ───────────────────────────────────────

/**
 * Measure the menu's own bias rather than only warning about it in prose.
 *
 * If the instruments in a group beat the benchmark almost unanimously over
 * the whole sample, that is not a discovery about markets — it is a fact
 * about how the list was assembled. Printing the number next to the result
 * is the difference between disclosing a bias and demonstrating it.
 */
export function groupBias(seriesById, ids, benchmarkId) {
    const bench = seriesById[benchmarkId];
    if (!bench) return null;
    const rows = [];
    for (const id of ids) {
        const s = seriesById[id];
        if (!s || s.dates.length < 2) continue;
        try {
            const a = alignSeries([s, bench]);
            const n = a.dates.length;
            if (n < 2) continue;
            const yrs = (a.dates[n - 1] - a.dates[0]) / YEAR_MS;
            const sc = Math.pow(a.prices[id][n - 1] / a.prices[id][0], 1 / yrs) - 1;
            const bc = Math.pow(a.prices[benchmarkId][n - 1] / a.prices[benchmarkId][0], 1 / yrs) - 1;
            rows.push({ id, cagr: sc, benchmark: bc, beat: sc > bc, years: yrs });
        } catch { /* no overlap — skip */ }
    }
    if (!rows.length) return null;
    const beat = rows.filter(r => r.beat).length;
    return {
        count: rows.length,
        beat,
        median: median(rows.map(r => r.cagr)),
        benchmark: rows[0].benchmark,
        rows,
    };
}

/** True median: the midpoint of the two central values when n is even. */
export function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Utilities ───────────────────────────────────────────────────────

export function iso(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD string as midnight UTC (never local time). */
export function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
