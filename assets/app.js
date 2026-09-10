// Chronoticker controller — the page's only stateful module.
//
// Owns the DOM: reads the control rail, drives assets/engine.js, and paints
// the results stage. The maths lives in engine.js and is shared with
// scripts/replay.mjs, so the numbers the page prints are the numbers the
// goldens check. The drawing lives in chart.js and weights.js. Nothing here
// computes a return, and nothing there touches a control.
//
// Two rules survive every rewrite of this file:
//   1. A number and its label are derived from the same variable, so a
//      "today's dollars" chip can never sit above nominal figures.
//   2. Anything that cannot be computed honestly prints an em-dash or a
//      notice, never a confident NaN.

import {
    toSeries, alignSeries, sliceAligned, projectOnAxis, simulate, metrics, xirr,
    baseRateSweep, duel, rfOnAxis, cpiOnAxis, deflate, deflateFlows, realRfOnAxis,
    annualizationFor, groupBias, iso, parseISO,
} from './engine.js';
import { deckChartTheme, renderGrowthChart, renderDuelChart, destroy as destroyChart } from './chart.js';
import { colorAt, renderWeightBar, normalise } from './weights.js';

// ── State ───────────────────────────────────────────────────────────

let CATALOG = null;
const SERIES = new Map();      // id → series | null (null = confirmed absent)
let AVAILABLE = [];            // catalog instruments that actually have a file
let growthChart = null, duelChart = null;
let lastRun = null;            // for CSV export
let growthSource = null;       // enough to redraw the chart when a tool toggles
let mode = 'backtest';
let linkWarning = null;        // set by readURL, reported after the first run

let running = false;           // a run is in flight
let pendingRun = false;        // a change arrived mid-run
let runTimer = null;           // the live-mode debounce
let hasRun = false;            // at least one run has succeeded this session
let liveNote = null;           // why live mode switched itself off

// Chart lens state. The markup ships the defaults (Log off, Drawdown on) and
// is the source of truth for them — initialising our own would let the
// buttons and the chart disagree on first paint.
let chartLog = false, chartDD = true;
let preBrush = null;           // the range the user chose before drag-zooming

const $ = id => document.getElementById(id);
const allocsEl = $('allocs');
const stageEl = document.querySelector('.stage');

// Windows are anchored to the newest bar in the data, never to the wall
// clock. If the nightly refresh stalls, a "5 years" window must stay five
// years long rather than quietly shrinking as the data ages.
const RANGE_DAYS = {
    '6mo': 183, '1y': 366, '2y': 731, '5y': 1827,
    '10y': 3653, '20y': 7305, '30y': 10958, 'max': null,
};

const REGIMES = {
    dotcom:      { from: '2000-03-24', to: '2002-10-09', label: 'the dot-com bust' },
    gfc:         { from: '2007-10-09', to: '2009-03-09', label: 'the 2008 crisis' },
    lostdecade:  { from: '2000-01-01', to: '2009-12-31', label: 'the lost decade' },
    covid:       { from: '2020-02-19', to: '2020-03-23', label: 'the COVID crash' },
    bear2022:    { from: '2022-01-03', to: '2022-10-12', label: 'the 2022 bear market' },
    stagflation: { from: '1973-01-01', to: '1974-12-31', label: 'the 1973–74 stagflation' },
    depression:  { from: '1929-09-03', to: '1932-07-08', label: 'the Great Depression' },
};

const ALLOC_PRESETS = {
    mag7:       [['AAPL', 16], ['MSFT', 14], ['NVDA', 14], ['GOOGL', 14], ['AMZN', 14], ['META', 14], ['TSLA', 14]],
    '6040':     [['SPY', 60], ['AGG', 40]],
    allweather: [['SPY', 30], ['TLT', 40], ['IEF', 15], ['GLD', 7], ['DBC', 8]],
    global:     [['VTI', 50], ['VEA', 30], ['AGG', 20]],
    index:      [['SPY', 100]],
    century:    [['USMKT', 100]],
};

// A run slower than this makes live mode feel broken rather than live. The
// base-rate sweep over a century of daily data is what usually crosses it.
const LIVE_BUDGET_MS = 900;
const LIVE_DEBOUNCE_MS = 350;

// ── Formatting ──────────────────────────────────────────────────────

const usd = v => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdc = v => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const pct = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%';
const signed = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function tile(label, value, sub, dir, extra) {
    const cls = dir === 'up' ? ' up' : dir === 'down' ? ' down' : '';
    return `<div class="stat${extra ? ' ' + extra : ''}">
        <div class="stat-label">${label}</div>
        <div class="stat-value${cls}">${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
}

function heroStat(label, value, sub, dir) {
    const cls = dir === 'up' ? ' up' : dir === 'down' ? ' down' : '';
    return `<div class="hero-stat">
        <span class="k">${label}</span>
        <span class="v${cls}">${value}</span>
        <span class="s">${sub}</span>
    </div>`;
}

function setStatus(kind, msg) {
    $('status').className = 'data-status ' + (kind || '');
    $('status').textContent = msg;
}

// ── Number transitions ──────────────────────────────────────────────
//
// Re-running with one control nudged changes numbers that are already on
// screen. Counting them up from the old value shows WHICH ones moved, which
// is the whole point of a live rail. Only numerics tween: a headline that
// reads "All at once" must never be interpolated into gibberish.

const NUM_MEMORY = new Map();
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function parseNumeric(text) {
    const m = /^([+-]?)([^0-9]*)([0-9][0-9,]*(?:\.[0-9]+)?)(.*)$/.exec(String(text).trim());
    if (!m) return null;
    const [, sign, prefix, digits, suffix] = m;
    const value = Number(digits.replace(/,/g, '')) * (sign === '-' ? -1 : 1);
    if (!Number.isFinite(value)) return null;
    const dot = digits.indexOf('.');
    return {
        value, prefix, suffix,
        decimals: dot < 0 ? 0 : digits.length - dot - 1,
        grouped: digits.includes(','),
        explicitPlus: sign === '+',
    };
}

function formatLike(v, shape) {
    const body = Math.abs(v).toLocaleString('en-US', {
        minimumFractionDigits: shape.decimals,
        maximumFractionDigits: shape.decimals,
        useGrouping: shape.grouped,
    });
    const sign = v < 0 ? '-' : (shape.explicitPlus ? '+' : '');
    return sign + shape.prefix + body + shape.suffix;
}

function tweenNumber(el, fromText, toText) {
    const a = parseNumeric(fromText), b = parseNumeric(toText);
    // Different units mean different quantities — snap rather than pretend
    // one turned into the other.
    if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix) return;
    const t0 = performance.now(), dur = 420;
    const step = now => {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = p < 1 ? formatLike(a.value + (b.value - a.value) * eased, b) : toText;
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function animateValues(host) {
    const nodes = host.querySelectorAll('.hero-value, .hero-stat .v, .stat-value');
    const still = prefersReducedMotion();
    for (const el of nodes) {
        const labelEl = el.closest('.hero-stat')?.querySelector('.k')
            || el.closest('.stat')?.querySelector('.stat-label');
        const key = `${host.id}|${labelEl ? labelEl.textContent : 'headline'}`;
        const to = el.textContent;
        const from = NUM_MEMORY.get(key);
        NUM_MEMORY.set(key, to);
        if (still || from == null || from === to) continue;
        tweenNumber(el, from, to);
    }
}

// ── Loading ─────────────────────────────────────────────────────────

async function loadCatalog() {
    const res = await fetch('data/catalog.json');
    if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`);
    CATALOG = await res.json();
    return CATALOG;
}

async function loadSeries(id) {
    if (SERIES.has(id)) return SERIES.get(id);
    let out = null;
    try {
        const res = await fetch(`data/${encodeURIComponent(id)}.json`);
        if (res.ok) out = toSeries(await res.json());
    } catch { /* treated as absent */ }
    SERIES.set(id, out);
    return out;
}

/**
 * Which catalog instruments actually have a data file behind them.
 *
 * data/manifest.json is written by scripts/verify-data.js on every CI run,
 * so the normal path costs one small request. Probing all 41 instruments
 * instead would mean ~30 console 404s on first paint while the catalogue
 * is still ahead of the backfill, so the manifest is worth having — but it
 * is only an optimisation, and a missing or stale one falls back to
 * probing rather than hiding an instrument that is actually there.
 */
async function availableInstruments() {
    try {
        const res = await fetch('data/manifest.json');
        if (res.ok) {
            const m = await res.json();
            const present = new Set(m.present || []);
            if (present.size) return CATALOG.instruments.filter(i => present.has(i.id));
        }
    } catch { /* fall through to probing */ }
    const found = await Promise.all(CATALOG.instruments.map(async i => (await loadSeries(i.id)) ? i : null));
    return found.filter(Boolean);
}

const catalogEntry = id => CATALOG.instruments.find(i => i.id === id) || null;
const benchmarkId = () => (CATALOG.instruments.find(i => i.benchmark) || { id: 'SPY' }).id;
const isAvailable = sym => AVAILABLE.some(i => i.id === sym);

// ── Allocation rows + weight bar ────────────────────────────────────

function makeRow(sym, weight) {
    const row = document.createElement('div');
    row.className = 'alloc-row';

    // The row is a four-column grid: swatch | instrument | weight | remove.
    // The swatch is what ties this holding to its band in the weight bar and
    // its line in the per-holding table — all three colour by the same index.
    const swatch = document.createElement('span');
    swatch.className = 'swatch';

    const select = document.createElement('select');
    for (const g of CATALOG.groups) {
        const inGroup = AVAILABLE.filter(i => i.group === g.id);
        if (!inGroup.length) continue;
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const i of inGroup) {
            const opt = document.createElement('option');
            opt.value = i.id;
            opt.textContent = `${i.name} (${i.id})`;
            if (i.id === sym) opt.selected = true;
            og.appendChild(opt);
        }
        select.appendChild(og);
    }
    select.setAttribute('aria-label', 'Holding');
    select.addEventListener('change', () => { nameRowControls(row); refreshAlloc(); });

    const input = document.createElement('input');
    input.type = 'number';
    input.min = 0; input.max = 100; input.step = 1;
    input.value = weight;
    input.addEventListener('input', () => refreshAlloc());

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
        // A zero-row UI has no add-affordance in context, and every run then
        // errors with "Add at least one holding."
        if (allocsEl.children.length <= 1) return;
        // The button is removing the row it lives in, so hand focus to the next
        // row's remove button, or to Add holding when the last one goes.
        const rows = rowEls();
        const next = rows[rows.indexOf(row) + 1] || rows[rows.indexOf(row) - 1];
        rehomeFocus(row, () => (next ? next.querySelector('.remove') : $('addAsset')));
        row.remove();
        refreshAlloc();
        scheduleRun();
    });

    row.append(swatch, select, input, remove);
    allocsEl.appendChild(row);
    nameRowControls(row);
    return row;
}

/**
 * Every allocation row carries the same three controls, so a generic label
 * ("Weight in percent", "Remove holding") repeated down the rail leaves a
 * screen-reader user with a list of identical controls and no way to tell
 * which holding each one acts on. Naming them after the selected symbol makes
 * each one addressable; re-run on change because the symbol can change.
 */
function nameRowControls(row) {
    const sym = row.querySelector('select').value || 'this holding';
    row.querySelector('input').setAttribute('aria-label', `${sym} weight, percent`);
    const rm = row.querySelector('.remove');
    rm.setAttribute('aria-label', `Remove ${sym}`);
    rm.title = `Remove ${sym}`;
}

const rowEls = () => [...allocsEl.querySelectorAll('.alloc-row')];
// Clamped at zero, and deliberately so: readAllocations() drops anything not
// above zero before the engine sees it, while the total chip summed the raw
// values. A typed -50 alongside a 150 therefore painted a green "100%" over a
// basket the run gated at 150 and refused — silently, because the refusal
// message lives next to the bar and the bar thought it was balanced. One
// clamp keeps the chip, the hint and the gate reading the same number.
const rowWeight = r => Math.max(0, parseFloat(r.querySelector('input').value) || 0);

function readAllocations() {
    const map = new Map();
    for (const r of rowEls()) {
        const sym = r.querySelector('select').value;
        map.set(sym, (map.get(sym) || 0) + rowWeight(r));
    }
    return [...map.entries()].filter(([, w]) => w > 0).map(([sym, weight]) => ({ sym, weight }));
}

/** Holding colour, keyed by the first row that holds the symbol. */
function colorBySymbol() {
    const out = {};
    rowEls().forEach((r, i) => {
        const sym = r.querySelector('select').value;
        if (!(sym in out)) out[sym] = colorAt(i);
    });
    return out;
}

/**
 * Move focus somewhere deliberate BEFORE the thing holding it disappears.
 *
 * Hiding or removing the element a keyboard user is standing on drops focus to
 * <body>, silently teleporting them to the top of the document with nothing
 * announced. The worst case is the weight-recovery path: blockOnWeights()
 * focuses "Even it out" on purpose, and evening out then destroys that button.
 *
 * Pass the subtree about to go away and where to land instead.
 */
function rehomeFocus(subtree, fallback) {
    if (!subtree || !subtree.contains(document.activeElement)) return;
    const el = typeof fallback === 'function' ? fallback() : fallback;
    if (!el) { document.activeElement.blur(); return; }
    // Landing spots are often headings or status text rather than controls.
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    try { el.focus({ preventScroll: true }); } catch { /* focus is a nicety */ }
}

function totalWeight() {
    return rowEls().reduce((s, r) => s + rowWeight(r), 0);
}

function fmtWeight(w) {
    return Math.abs(w - Math.round(w)) < 0.05 ? w.toFixed(0) : w.toFixed(1);
}

function updateTotalChip(total) {
    const el = $('allocTotal');
    el.textContent = `${fmtWeight(total)}%`;
    // The 0.5 tolerance is the one run() validates against — they must stay
    // in step or the chip goes green on a run that then refuses.
    el.className = 'alloc-total ' + (Math.abs(total - 100) < 0.5 ? 'ok' : 'bad');
}

function updateWeightHint(total) {
    const hint = $('weightHint');
    if (Math.abs(total - 100) < 0.5) {
        rehomeFocus(hint, () => $('run'));
        hint.className = 'weight-hint';
        hint.innerHTML = '';
        return;
    }
    // The complaint and its cure belong beside the bar that caused them. The
    // status line is at the other end of the page and describes the run, not
    // the form.
    hint.className = 'weight-hint bad';
    hint.innerHTML = `<span>They add up to ${fmtWeight(total)}%.</span>` +
        `<button type="button">Even it out</button>`;
    hint.querySelector('button').addEventListener('click', () => {
        evenOutToHundred();
        scheduleRun();
    });
}

function evenSplit(n) {
    // Integer weights that always total exactly 100 — no 33.33% noise.
    const base = Math.floor(100 / n);
    const remainder = 100 - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

function evenOutToHundred() {
    const rows = rowEls();
    if (!rows.length) return;
    const ws = rows.map(rowWeight);
    const sum = ws.reduce((s, w) => s + w, 0);
    // normalise() scales by the existing total, which is undefined when the
    // total is zero. A blank allocation gets an even split instead.
    const next = sum > 0 ? normalise(ws) : evenSplit(rows.length);
    rows.forEach((r, i) => r.querySelector('input').value = next[i]);
    refreshAlloc();
}

function renderBar() {
    const rows = rowEls();
    const segments = rows.map(r => ({
        sym: r.querySelector('select').value,
        weight: rowWeight(r),
    }));
    renderWeightBar($('weightBar'), segments, {
        onResize(next) {
            next.forEach((w, i) => { if (rows[i]) rows[i].querySelector('input').value = w; });
            // Repaint the chip and the hint but never the bar itself:
            // re-rendering mid-drag would destroy the handle holding the
            // pointer capture and the drag would die halfway across the bar.
            refreshAlloc(false);
            // Debounced, so the re-run lands once the drag has stopped rather
            // than on every pixel of it.
            scheduleRun();
        },
        // Optional in the module contract: when it is there the re-run lands
        // the moment the drag ends instead of waiting out the debounce, and
        // when it is not the debounce above still covers it.
        onCommit() { scheduleRun(0); },
    });
}

function refreshAlloc(rebuildBar = true) {
    // One index, three consumers: the row swatch, the band in the weight bar
    // and the swatch in the per-holding table must all name the same colour
    // for the same holding.
    rowEls().forEach((r, i) => r.querySelector('.swatch').style.setProperty('--c', colorAt(i)));
    const total = totalWeight();
    updateTotalChip(total);
    updateWeightHint(total);
    if (rebuildBar) renderBar();
}

/**
 * Returns the ids that had to be dropped for want of data, so the caller can
 * say so. A preset that quietly loads two of its three holdings is worse than
 * one that refuses: the weights no longer total 100 and the reason is
 * invisible. This matters while the catalogue is ahead of the backfill.
 */
function setAllocations(pairs) {
    allocsEl.innerHTML = '';
    const usable = pairs.filter(([sym]) => isAvailable(sym));
    const dropped = pairs.filter(([sym]) => !isAvailable(sym)).map(([sym]) => sym);
    // Substituting a fallback when NOTHING requested is available keeps the
    // rail usable, but it is a different portfolio than the one asked for. It
    // has to be reported, or a link naming only unknown symbols backtests
    // something else entirely and calls it a success.
    const substituted = !usable.length;
    if (substituted) makeRow(AVAILABLE[0]?.id || 'SPY', 100);
    else usable.forEach(([sym, w]) => makeRow(sym, w));
    refreshAlloc();
    dropped.substituted = substituted;
    return dropped;
}

/**
 * A preset card advertises "7 holdings" in static markup. If the backfill has
 * not reached those symbols the card would silently load a short allocation,
 * so a wholly unavailable preset is disabled outright and a partial one keeps
 * the old dropped-symbol warning plus a tooltip.
 */
function markPresetAvailability() {
    for (const el of document.querySelectorAll('[data-preset]')) {
        const pairs = ALLOC_PRESETS[el.dataset.preset] || [];
        const missing = pairs.filter(([sym]) => !isAvailable(sym)).map(([sym]) => sym);
        if (!missing.length) { el.disabled = false; el.removeAttribute('title'); continue; }
        if (missing.length === pairs.length) {
            el.disabled = true;
            // deck.css has no disabled state for a preset card, so the
            // controller supplies the minimum one: a card that cannot load
            // anything must not look identical to one that can.
            el.style.opacity = '0.4';
            el.style.cursor = 'not-allowed';
            el.title = `${missing.join(', ')} have not been fetched yet.`;
        } else {
            el.title = `${missing.join(', ')} not fetched yet — this would load short of 100%.`;
        }
    }
}

// ── URL state ───────────────────────────────────────────────────────

// Never let a blank or malformed control reach the engine as NaN: every
// comparison against NaN is false, so a NaN cadence produces a run that
// quietly contributes nothing and still renders a confident result.
const intOr = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
const numOr = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt; };

function currentConfig() {
    return {
        mode,
        alloc: readAllocations(),
        initial: parseFloat($('initial').value) || 0,
        contribution: parseFloat($('contribution').value) || 0,
        cadence: intOr($('cadence').value, 30),
        total: parseFloat($('duelTotal').value) || 0,
        deployments: intOr($('deployments').value, 12),
        range: $('lookback').value,
        from: $('fromDate').value || null,
        to: $('toDate').value || null,
        rebalance: intOr($('rebalance').value, 0),
        costBps: numOr($('costBps').value, 0),
        feeBps: numOr($('feeBps').value, 0),
        measure: $('measure').value,
    };
}

function writeURL(cfg) {
    const p = new URLSearchParams();
    p.set('alloc', cfg.alloc.map(a => `${a.sym}:${a.weight}`).join(','));
    p.set('range', cfg.range);
    if (cfg.from) p.set('from', cfg.from);
    if (cfg.to) p.set('to', cfg.to);
    if (cfg.mode === 'duel') {
        p.set('mode', 'duel');
        p.set('total', cfg.total);
        p.set('deploy', cfg.deployments);
    } else {
        if (cfg.initial) p.set('init', cfg.initial);
        if (cfg.contribution) { p.set('contrib', cfg.contribution); p.set('cad', cfg.cadence); }
    }
    if (cfg.rebalance) p.set('reb', cfg.rebalance);
    if (cfg.costBps) p.set('cost', cfg.costBps);
    if (cfg.feeBps) p.set('fee', cfg.feeBps);
    if (cfg.measure === 'real') p.set('real', '1');
    // The chart lens is part of what a shared link shows, so it travels too.
    // Live mode is a preference of the person at the keyboard, not a property
    // of the run, so it deliberately does not.
    if (chartLog) p.set('log', '1');
    if (!chartDD) p.set('dd', '0');
    // replaceState, never pushState: every run would otherwise add a history
    // entry and the back button would walk through parameter tweaks.
    history.replaceState(null, '', `${location.pathname}?${p}`);
}

function readURL() {
    const p = new URLSearchParams(location.search);
    // "Has any parameter at all" is not the same question as "is one of our
    // links". A tracking parameter — ?utm_source=…, ?fbclid=…, ?ref=… — passed
    // that test, then carried no `alloc`, so the default allocation was skipped
    // AND the front door was hidden: an empty workbench that refuses to run,
    // reached by an ordinary shared link. writeURL always emits `alloc`, so
    // that is the honest signal.
    if (!p.has('alloc')) return false;

    if (p.get('mode') === 'duel') setMode('duel');
    const alloc = (p.get('alloc') || '').split(',').filter(Boolean).map(s => {
        const [sym, w] = s.split(':');
        return [sym, parseFloat(w) || 0];
    });
    // A link naming a symbol with no data fails the 100% check, which says so
    // next to the bar. But a link where NOTHING resolves gets a substituted
    // fallback holding that would otherwise run clean under someone else's
    // link — so that case has to be named outright.
    const urlDropped = alloc.length ? setAllocations(alloc) : [];
    const allocNote = urlDropped.substituted
        ? `none of the holdings in that link (${urlDropped.join(', ')}) have data here, so the allocation was replaced`
        : urlDropped.length
            ? `the link's ${urlDropped.join(', ')} ${urlDropped.length === 1 ? 'has' : 'have'} no data yet, so ${urlDropped.length === 1 ? 'it was' : 'they were'} left out`
            : null;

    // A <select> silently accepts an unknown value by going to selectedIndex
    // -1, whose .value is ''. That became NaN in currentConfig and then a
    // simulation that never contributed a dollar while still rendering a
    // confident result. Reject anything not actually in the list and keep the
    // default instead.
    const rejected = [];
    const set = (id, key, dflt) => {
        const el = $(id);
        const apply = v => {
            if (el.tagName === 'SELECT') {
                if (![...el.options].some(o => o.value === String(v))) { rejected.push(`${key}=${v}`); return; }
            } else if (el.type === 'number' && v !== '' && !Number.isFinite(Number(v))) {
                rejected.push(`${key}=${v}`); return;
            }
            el.value = v;
        };
        if (p.has(key)) apply(p.get(key));
        else if (dflt != null) apply(dflt);
    };
    // writeURL omits `init` when it is 0, so without this conditional default
    // a contribution-only link would inherit the markup's 10000 and reproduce
    // a completely different run than the one that was shared.
    set('initial', 'init', p.has('contrib') ? 0 : null);
    set('contribution', 'contrib');
    set('cadence', 'cad');
    set('duelTotal', 'total');
    set('deployments', 'deploy');
    set('lookback', 'range');
    set('fromDate', 'from');
    set('toDate', 'to');
    set('rebalance', 'reb');
    set('costBps', 'cost');
    set('feeBps', 'fee');
    $('measure').value = p.get('real') === '1' ? 'real' : 'nominal';
    if (p.has('log')) chartLog = p.get('log') === '1';
    if (p.has('dd')) chartDD = p.get('dd') !== '0';
    syncChartTools();
    syncRangeFields();
    // Surfaced after the run completes, because run() sets the status last
    // and would otherwise bury it. Flushed by boot() too, for the case where
    // the run never reaches finishStatus — a bad link is exactly the link
    // whose run is most likely to fail, and the warning explaining why must
    // not wait for a success that never comes.
    const notes = [];
    if (allocNote) notes.push(allocNote);
    if (rejected.length) notes.push(`ignored unrecognised link settings (${rejected.join(', ')}), using defaults for those`);
    linkWarning = notes.length ? notes.join('; ') : null;
    return true;
}

// ── Mode, fields and stage visibility ───────────────────────────────

function setMode(next) {
    mode = next;
    const duelMode = next === 'duel';
    $('modeBacktest').setAttribute('aria-selected', String(!duelMode));
    $('modeDuel').setAttribute('aria-selected', String(duelMode));
    // The markup claims role=tablist but ships no roving tabindex, so the
    // controller supplies one rather than leaving the role overpromising.
    $('modeBacktest').tabIndex = duelMode ? -1 : 0;
    $('modeDuel').tabIndex = duelMode ? 0 : -1;

    $('fieldInitial').hidden = duelMode;
    $('fieldContribution').hidden = duelMode;
    $('fieldCadence').hidden = duelMode;
    $('fieldTotal').hidden = !duelMode;
    $('fieldDeployments').hidden = !duelMode;
    $('backtestResults').hidden = duelMode;
    $('duelResults').hidden = !duelMode;

    // Chart.js sizes badly against a display:none canvas, and a stale chart
    // under a fresh heading is worse than no chart.
    destroyChart(growthChart); growthChart = null;
    destroyChart(duelChart); duelChart = null;

    // The two result blocks share one container, so a mode switch must hide
    // it or the new mode shows the old mode's numbers under its own heading.
    hideResults();
}

function syncRangeFields() {
    const custom = $('lookback').value === 'custom';
    $('fieldFrom').hidden = !custom;
    $('fieldTo').hidden = !custom;
}

function syncChartTools() {
    $('chartScale').setAttribute('aria-pressed', String(chartLog));
    $('chartDD').setAttribute('aria-pressed', String(chartDD));
    $('chartReset').hidden = !preBrush;
}

function revealResults() {
    $('results').hidden = false;
    $('stageEmpty').hidden = true;
    // A preset card pressed by keyboard is inside the subtree about to vanish;
    // send the user to the status line, which is about to say what happened.
    rehomeFocus($('launchpad'), () => $('status'));
    $('launchpad').hidden = true;
}

/**
 * The stage shows either results or the placeholder, never both and never
 * neither. The launchpad comes back with the placeholder whenever nothing is
 * queued to replace it — switching modes with Live off is the only way to get
 * there — because the front door is the most useful thing to offer an empty
 * stage. With Live on a run is already scheduled, so it would only flicker.
 */
function hideResults() {
    const willRerun = hasRun && $('autoRun').checked;
    $('results').hidden = true;
    $('stageEmpty').hidden = false;
    if (!willRerun) $('launchpad').hidden = false;
    if (willRerun) scheduleRun();
}

// ── Duel-side hosts the markup does not carry ───────────────────────
//
// #coverage and #assumptions live inside #backtestResults, which is hidden
// wholesale in duel mode. Writing the window description and the assumption
// chips — including the load-bearing "today's dollars" one — into a hidden
// subtree loses them silently, so duel mode gets its own copies. The notice
// host is the same story: without it a duel over the Magnificent 7 never
// shows the selection-bias warning that a backtest of it does.

function injectDuelHosts() {
    const duelResults = $('duelResults');
    const coverage = document.createElement('div');
    coverage.className = 'coverage';
    coverage.id = 'duelCoverage';
    const assumptions = document.createElement('div');
    assumptions.className = 'assumptions';
    assumptions.id = 'duelAssumptions';
    duelResults.prepend(coverage, assumptions);

    const notices = document.createElement('div');
    notices.id = 'duelNoticeHost';
    $('duelStory').after(notices);
}

const coverageHost = () => mode === 'duel' ? $('duelCoverage') : $('coverage');
const assumptionsHost = () => mode === 'duel' ? $('duelAssumptions') : $('assumptions');

// ── The run ─────────────────────────────────────────────────────────

function scheduleRun(delay = LIVE_DEBOUNCE_MS) {
    if (!hasRun || !$('autoRun').checked) return;
    clearTimeout(runTimer);
    runTimer = setTimeout(() => { runTimer = null; run(); }, delay);
}

/**
 * Weights are wrong: say so where the weights are — and in the status line.
 *
 * Pointing at the hint alone was a silent refusal whenever the hint disagreed
 * with the gate, and it left the live region still asserting the previous
 * run's "Done · N trading days" over numbers that no longer match the rail.
 * The status line is the one thing a screen reader is listening to, so it
 * always gets the reason.
 */
function blockOnWeights(explicit) {
    refreshAlloc();
    const total = readAllocations().reduce((s, a) => s + a.weight, 0);
    setStatus('error', `The weights add up to ${fmtWeight(total)}%. They need to total 100%.`);
    if (!explicit) return;
    const fix = $('weightHint').querySelector('button');
    $('weightBar').scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (fix) fix.focus();
}

async function run(opts = {}) {
    if (running) { pendingRun = true; return; }
    clearTimeout(runTimer); runTimer = null;

    const cfg = currentConfig();
    const runBtn = $('run');

    // All four validations return BEFORE the button is disabled: an early
    // return inside the disabled window would leave Run dead, because the
    // finally block only covers the try.
    if (!rowEls().length) return setStatus('error', 'Add at least one holding.');
    const total = cfg.alloc.reduce((s, a) => s + a.weight, 0);
    if (Math.abs(total - 100) > 0.5) return blockOnWeights(opts.explicit);
    if (mode === 'backtest' && cfg.initial <= 0 && cfg.contribution <= 0) {
        return setStatus('error', 'Set a starting amount, a regular contribution, or both.');
    }
    // Written as !(x > 0) so a NaN total is caught too.
    if (mode === 'duel' && !(cfg.total > 0)) {
        return setStatus('error', 'Set a total amount to invest.');
    }

    running = true;
    runBtn.disabled = true;
    runBtn.classList.add('busy');
    stageEl.classList.add('busy');
    setStatus('', 'Loading prices…');
    const started = performance.now();

    try {
        // Load only the portfolio's own instruments. The benchmark is
        // projected on afterwards so it can never truncate the window.
        const ids = cfg.alloc.map(a => a.sym);
        const list = await Promise.all(ids.map(loadSeries));
        const missing = ids.filter((id, i) => !list[i]);
        if (missing.length) {
            throw new Error(`No price data for ${missing.join(', ')}. ` +
                `Those symbols are in the catalogue but have not been fetched yet — ` +
                `run the "Refresh stock data" action.`);
        }

        let aligned = alignSeries(list);
        const dataFrom = aligned.dates[0], dataTo = aligned.dates[aligned.dates.length - 1];

        // ── Window ──
        let wantFrom = null, wantTo = null;
        const clamped = [];
        if (cfg.range === 'custom') {
            wantFrom = parseISO(cfg.from);
            wantTo = parseISO(cfg.to);
        } else if (RANGE_DAYS[cfg.range] != null) {
            wantFrom = dataTo - RANGE_DAYS[cfg.range] * 86400000;
        }
        if (wantFrom != null && wantFrom < dataFrom) { clamped.push('start'); wantFrom = dataFrom; }
        if (wantTo != null && wantTo > dataTo) { clamped.push('end'); wantTo = dataTo; }
        aligned = sliceAligned(aligned, wantFrom, wantTo);
        if (aligned.dates.length < 3) throw new Error('That window contains almost no trading days — widen it.');

        const ann = annualizationFor(list);

        // ── Macro overlays ──
        const rfSeries = await loadSeries('RF');
        const cpiSeries = await loadSeries('CPI');
        const rfNominal = rfSeries ? rfOnAxis({ dates: rfSeries.dates, values: rfSeries.values }, aligned.dates) : null;
        const cpiAxis = cpiSeries ? cpiOnAxis({ dates: cpiSeries.dates, values: cpiSeries.values }, aligned.dates) : null;
        // Real mode degrades to nominal when CPI is missing, and the
        // assumption chip reads this same flag, so the label can never claim
        // a restatement that did not happen.
        const real = cfg.measure === 'real' && !!cpiAxis;

        // "Today's dollars" has to mean TODAY, not the last day of the window.
        // For a window ending in 1932 those differ by a factor of about 24.
        const cpiToday = cpiSeries ? cpiSeries.values[cpiSeries.values.length - 1] : null;
        const cpiBase = real ? cpiToday : (cpiAxis ? cpiAxis[cpiAxis.length - 1] : null);

        // Measuring returns in real terms while charging a nominal cash rate
        // subtracts inflation twice. Deflate the risk-free series too.
        const rfDaily = (real && rfNominal) ? realRfOnAxis(rfNominal, cpiAxis) : rfNominal;

        // ── Benchmark, only if it actually covers the window ──
        // A benchmark is only meaningful if it is something OTHER than what
        // is being measured. Comparing a holding to itself produced a
        // "0 of 398 windows beat USMKT" verdict off a distribution of exact
        // zeroes, which is worse than showing nothing.
        const benchId = benchmarkId();
        let bench = null, benchNote = null;
        const pickBenchmark = async (id, note) => {
            if (ids.includes(id)) return false;
            const s = await loadSeries(id);
            const proj = s ? projectOnAxis(s, aligned.dates) : null;
            if (!proj) return false;
            bench = { id, prices: proj.values, partial: proj.partial };
            if (note) benchNote = note;
            return true;
        };

        if (ids.length === 1 && ids[0] === benchId) {
            benchNote = 'This is the benchmark, so there is nothing to compare it against.';
        } else if (!(await pickBenchmark(benchId))) {
            // Two different reasons reach here and they need different notes.
            // Blaming date coverage when the real cause is that the benchmark
            // is one of the holdings prints a falsehood about SPY's history on
            // a shipped preset — 60/40 holds SPY, whose data starts in 1993.
            const reachedBack = await pickBenchmark('USMKT', ids.includes(benchId)
                ? `${benchId} is one of your holdings, so the comparison line is the total US market instead.`
                : `${benchId} does not go back to ${iso(aligned.dates[0])}, so the comparison line is the total US market instead.`);
            if (!reachedBack) {
                benchNote = ids.includes('USMKT') && ids.length === 1
                    ? 'This is the broadest market index available, so there is nothing to compare it against.'
                    : 'No benchmark covers this window, so there is nothing to compare against.';
            }
        }

        const ctx = { cfg, aligned, list, ann, rfDaily, cpiAxis, cpiBase, real, bench, benchNote, clamped, dataFrom, dataTo, ids };

        // Revealed BEFORE the renderers run, not after. Chart.js measures its
        // canvas at construction, and a canvas inside a [hidden] container
        // measures 0x0 — so on the very first run the chart was built at zero
        // width and spent its one entry animation on something invisible. The
        // heavy work that can still throw is already done by here; the catch
        // below puts the placeholder back if this first run does fail.
        revealResults();

        // The skeleton covers loading and alignment, which are done by now. It
        // has to come off BEFORE the renderers paint, because the shimmer makes
        // .stat-value transparent — leaving it on meant every count-up tween
        // played invisibly behind it. The button keeps its spinner until the
        // run genuinely ends.
        stageEl.classList.remove('busy');

        if (mode === 'duel') await runDuel(ctx);
        else await runBacktest(ctx);

        writeURL(cfg);
        hasRun = true;
        finishStatus(list, aligned, performance.now() - started);
    } catch (err) {
        console.error(err);
        setStatus('error', err.message);
        // Never leave a half-painted stage standing in for a result. If no run
        // has ever succeeded there is nothing behind this one to fall back to,
        // so restore the placeholder rather than showing empty scaffolding.
        if (!hasRun) hideResults();
    } finally {
        running = false;
        runBtn.disabled = false;
        runBtn.classList.remove('busy');
        stageEl.classList.remove('busy');
        if (pendingRun) { pendingRun = false; setTimeout(() => run(), 0); }
    }
}

/**
 * One status line, composed once.
 *
 * The old page called reportFreshness last and let it overwrite whatever the
 * renderers had just written, which destroyed the link warning from the same
 * run. Every clause is collected here instead, so a stale feed and a mangled
 * share link can both be reported.
 */
function finishStatus(list, aligned, elapsed) {
    const clauses = [];
    let kind = 'ok';

    const stale = staleInstruments(list);
    if (stale.length) {
        kind = 'warn';
        clauses.push(`but the prices for ${stale.join(', ')} are behind. The nightly refresh may be failing.`);
    }
    // Reported once and then dropped: it describes the link that opened the
    // page, and repeating it on every live re-run would keep complaining
    // about settings the user has since changed by hand.
    if (linkWarning) { kind = 'warn'; clauses.push(linkWarning); linkWarning = null; }

    // A live rail that stutters is worse than one that waits for a click, and
    // the base-rate sweep over a century of daily bars is genuinely slow.
    if (elapsed > LIVE_BUDGET_MS && $('autoRun').checked) {
        $('autoRun').checked = false;
        liveNote = `that run took ${(elapsed / 1000).toFixed(1)}s, so Live updates are off — press Run when you are ready.`;
    }
    if (liveNote) { kind = 'warn'; clauses.push(liveNote); liveNote = null; }

    // The first clause continues the sentence after the em dash; any that
    // follow are sentences of their own.
    const tail = clauses.length
        ? ` — ${clauses[0]}${clauses.slice(1).map(c => ' ' + c[0].toUpperCase() + c.slice(1)).join('')}`
        : '';
    setStatus(kind, `Done · ${aligned.dates.length.toLocaleString()} trading days${tail}`);
}

/**
 * Instruments whose upstream publishes monthly are EXPECTED to lag by four to
 * six weeks. Warning about them would train the user to ignore the warning,
 * which is how the June 2026 outage went unnoticed for eight weeks. Budgets
 * here match scripts/verify-data.js deliberately.
 */
function staleInstruments(list) {
    const now = Date.now();
    const budget = id => (id === 'USMKT' || id === 'CPI') ? 75 : (id === 'RF' ? 45 : 7);
    // The macro series are loaded separately from the portfolio's holdings, so
    // they never appeared in `list` and their generous budgets were dead code.
    // A stalled Ken French / FRED refresh is exactly the silent failure this
    // reporting exists to catch, so they are checked alongside the prices.
    const macro = ['RF', 'CPI'].map(id => SERIES.get(id)).filter(s => s && s.dates && s.dates.length);
    const seen = new Set(list.map(s => s.id));
    return [...list, ...macro.filter(s => !seen.has(s.id))]
        .filter(s => (now - s.dates[s.dates.length - 1]) / 86400000 > budget(s.id))
        .map(s => `${s.id} (${iso(s.dates[s.dates.length - 1])})`);
}

// ── Backtest ────────────────────────────────────────────────────────

async function runBacktest(ctx) {
    const { cfg, aligned, ann, rfDaily, cpiAxis, cpiBase, real, bench, benchNote, clamped, ids } = ctx;

    const weights = {};
    cfg.alloc.forEach(a => weights[a.sym] = a.weight);

    const opts = {
        weights,
        initial: cfg.initial,
        contribution: cfg.contribution,
        contributionDays: cfg.cadence,
        rebalanceDays: cfg.rebalance,
        costBps: cfg.costBps,
        feeBps: cfg.feeBps,
    };
    const sim = simulate(aligned, opts);

    const navForMetrics = real ? deflate(sim.nav, cpiAxis, cpiBase) : sim.nav;
    const m = metrics(navForMetrics, aligned.dates, { annualization: ann, rfDaily });
    if (m.insufficient) {
        throw new Error(`The money was only invested for ${plural(m.bars, 'trading day')} in this window, ` +
            `which is not enough to measure. Widen the window or start contributing earlier.`);
    }

    // In real terms the final value is already in today's dollars (the CPI
    // base is today's price level), but the contributions are not — each one
    // has to be inflated forward from the day it was actually made.
    const flows = real ? deflateFlows(sim.flows, aligned.dates, cpiAxis, cpiBase) : sim.flows;
    const irr = xirr(flows);
    const contributed = real
        ? flows.filter(f => f.amount < 0).reduce((s, f) => s - f.amount, 0)
        : sim.totals.contributed;
    // The final value needs restating too. The base is TODAY's price level,
    // not the window's last day, so a window ending in 1932 is scaled by a
    // factor of ~24 — leaving it nominal would put "you put in" in 2026
    // dollars beside a final value in 1932 dollars.
    const toToday = v => real ? v * cpiBase / cpiAxis[cpiAxis.length - 1] : v;
    const finalValue = toToday(sim.totals.finalValue);
    const profit = finalValue - contributed;

    // Benchmark run: identical cash-flow schedule, so only the allocation differs.
    let bm = null, benchSim = null;
    if (bench) {
        const benchAligned = { dates: aligned.dates, prices: { [bench.id]: bench.prices } };
        benchSim = simulate(benchAligned, { ...opts, weights: { [bench.id]: 100 } });
        const bnav = real ? deflate(benchSim.nav, cpiAxis, cpiBase) : benchSim.nav;
        bm = metrics(bnav, aligned.dates, { annualization: ann, rfDaily });
        if (bm.insufficient) bm = null;
    }

    renderCoverage(ctx, bench, benchNote, clamped);
    renderAssumptions(cfg, m, real);

    // ── Hero: the money questions, one headline and three supports ──
    const t = sim.totals;
    const vsBench = bm ? m.cagr - bm.cagr : null;
    const side = [
        heroStat('Profit', usd(profit), real ? 'real, after costs' : 'after costs', profit >= 0 ? 'up' : 'down'),
        heroStat('Your return', pct(irr), real ? 'money-weighted, real' : 'money-weighted (IRR)', (irr ?? 0) >= 0 ? 'up' : 'down'),
        // The hero has exactly three slots. Without a benchmark the growth
        // rate takes the third rather than leaving a ragged row.
        bm
            ? heroStat(`vs ${bench.id}`, signed(vsBench), `${bench.id} did ${pct(bm.cagr)}`, vsBench >= 0 ? 'up' : 'down')
            : heroStat('Growth rate', pct(m.cagr), 'per year, time-weighted', m.cagr >= 0 ? 'up' : 'down'),
    ];
    $('hero').innerHTML = `
        <div>
            <div class="hero-label">Final value · ${real ? "today's dollars" : 'nominal dollars'}</div>
            <div class="hero-value">${usd(finalValue)}</div>
            <div class="hero-sub">You put in <b>${usd(contributed)}</b> across
                <b>${plural(t.contributions, 'purchase')}</b>${real ? ', restated in today\'s dollars' : ''}.</div>
        </div>
        <div class="hero-side">${side.join('')}</div>`;
    animateValues($('hero'));

    // ── Strategy tiles ──
    $('statsStrategy').innerHTML =
        tile('Growth rate', pct(m.cagr), 'per year, time-weighted', m.cagr >= 0 ? 'up' : 'down', 'primary') +
        (bm ? tile(`vs ${bench.id}`, signed(vsBench), `${bench.id} did ${pct(bm.cagr)}`, vsBench >= 0 ? 'up' : 'down') : '') +
        tile('Worst fall', pct(m.maxDD), `${iso(m.ddFrom)} → ${iso(m.ddTo)}`, 'down') +
        tile('Volatility', pct(m.vol), 'annualised') +
        tile('Sharpe', m.sharpe.toFixed(2),
            // Reads what the engine actually consumed, not merely whether an
            // RF file was fetched.
            m.rfUsed ? `vs T-bills at ${pct(m.rfAnnual, 1)}` : 'assuming cash pays 0%',
            m.sharpe >= 1 ? 'up' : (m.sharpe < 0 ? 'down' : null)) +
        tile('Best day', signed(m.best), iso(m.bestAt), 'up') +
        tile('Worst day', signed(m.worst), iso(m.worstAt), 'down') +
        (t.totalFriction > 0
            ? tile('Paid in friction', usd(toToday(t.totalFriction)),
                `${usdc(toToday(t.costsPaid))} trading + ${usdc(toToday(t.feesPaid))} fees`, 'down')
            : '');
    animateValues($('statsStrategy'));

    // ── Chart ──
    // Wealth deflates with the price level at each bar. The CONTRIBUTED line
    // does not: it is a running sum of dollars paid on many different dates,
    // so it is rebuilt here, purchase by purchase, and each one is inflated
    // forward from its own bar.
    let realBasis = null;
    if (real) {
        realBasis = new Array(aligned.dates.length).fill(0);
        const byDate = new Map(aligned.dates.map((d, i) => [d, i]));
        let running = 0, p = 0;
        const ps = sim.purchases;
        for (let i = 0; i < aligned.dates.length; i++) {
            while (p < ps.length && byDate.get(ps[p].t) === i) {
                running += ps[p].gross * cpiBase / cpiAxis[i];
                p++;
            }
            realBasis[i] = running;
        }
    }
    buildGrowthSource(aligned.dates, sim, benchSim, bench, cfg, real, cpiAxis, cpiBase, realBasis, m);
    drawGrowth();

    await renderSweep(ctx, weights);
    await renderNotices(ctx, ids, $('noticeHost'), true);
    renderBreakdown(sim, real, toToday);
    renderLedger(sim);

    lastRun = { dates: aligned.dates, sim, benchSim, bench, cfg, real, cpiAxis, cpiBase, realBasis };
}

function renderCoverage(ctx, bench, benchNote, clamped) {
    const { aligned, list, cfg } = ctx;
    const from = iso(aligned.dates[0]), to = iso(aligned.dates[aligned.dates.length - 1]);
    const years = ((aligned.dates[aligned.dates.length - 1] - aligned.dates[0]) / (365.25 * 86400000)).toFixed(1);

    const bits = [`<b>${from}</b> → <b>${to}</b> · <span class="mono">${aligned.dates.length.toLocaleString()}</span> trading days (${years} years).`];

    // Name the instrument responsible for the window's start — a short
    // window should never be a mystery. Suppressed for custom ranges, which
    // the user chose deliberately, and when every instrument is a limiter,
    // where "removing it would unlock more" would be false advice.
    //
    // Also suppressed unless the window actually begins at the basket's
    // earliest shared bar. sliceAligned() spreads the pre-slice block, so
    // `limitedBy` still describes the FULL overlap after slicing — which made
    // a plain "1 year" run on AAPL/MSFT/NVDA announce that the window started
    // where NVDA does. NVDA's history starts in 1999; the window started in
    // 2025 because the user asked for one year.
    const startLimiters = aligned.limitedBy?.start || [];
    const pinnedToDataStart = ctx.dataFrom != null && aligned.dates[0] === ctx.dataFrom;
    if (startLimiters.length && cfg.range !== 'custom' && pinnedToDataStart) {
        const others = list.filter(s => !startLimiters.includes(s.id));
        if (others.length) {
            bits.push(`The window starts where <b>${startLimiters.join(', ')}</b> does — that is the shortest history in this basket. Removing it would unlock more.`);
        }
    }
    if (clamped.includes('start')) {
        bits.push(cfg.range === 'custom'
            ? `Your start date is earlier than the data goes, so it was moved to ${from}.`
            : `The data does not reach back a full ${$('lookback').selectedOptions[0].textContent.toLowerCase()}, so this window is as long as the data allows.`);
    }
    if (clamped.includes('end')) bits.push(`Your end date is later than the data goes, so it was moved to ${to}.`);

    // Honest labelling of price-return instruments mixed with total-return.
    const priceOnly = list.filter(s => s.returns === 'price');
    if (priceOnly.length) {
        bits.push(`<b>${priceOnly.map(s => s.id).join(', ')}</b> pay no dividends, so their numbers are price-only while the rest include reinvested income.`);
    }
    // Independent, not an else-if: the two facts stack. The USMKT fallback
    // sets benchNote AND is the series most likely to be partial — its upstream
    // publishes monthly, so it runs weeks behind the window end. Chaining them
    // suppressed the caveat in exactly the case that needed it.
    if (benchNote) bits.push(benchNote);
    if (bench?.partial) bits.push(`The ${bench.id} comparison line stops before the end of the window.`);

    coverageHost().innerHTML = bits.join(' ');
}

function renderAssumptions(cfg, m, real) {
    const chips = [];
    chips.push(`<span class="assumption ${real ? 'on' : 'off'}">${real ? "today's dollars" : 'nominal dollars'}</span>`);
    chips.push(`<span class="assumption ${cfg.costBps ? 'on' : 'warn'}">${cfg.costBps ? `${cfg.costBps} bps trading cost` : 'no trading costs'}</span>`);
    chips.push(`<span class="assumption ${cfg.feeBps ? 'on' : 'warn'}">${cfg.feeBps ? `${(cfg.feeBps / 100).toFixed(2)}% annual fee` : 'no fees'}</span>`);
    chips.push(`<span class="assumption ${m.rfUsed ? 'on' : 'warn'}">${m.rfUsed ? 'Sharpe vs real T-bills' : 'Sharpe assumes 0% cash'}</span>`);
    chips.push('<span class="assumption warn">no taxes</span>');
    chips.push('<span class="assumption warn">trades at the close</span>');
    chips.push(`<span class="assumption ${cfg.rebalance ? 'on' : 'off'}">${cfg.rebalance ? `rebalanced every ${cfg.rebalance}d` : 'never rebalanced'}</span>`);
    assumptionsHost().innerHTML = chips.join('');
}

async function renderSweep(ctx, weights) {
    const { aligned, list, ann, cfg, bench } = ctx;
    const host = $('sweepHost');

    // The section label above this host is static markup and cannot be
    // hidden, so every path writes something.
    if (!bench) {
        host.innerHTML = `<div class="notice info"><h3 class="head">Not available</h3>
            There is no benchmark covering this window, so there is nothing to compute a win rate against.</div>`;
        return;
    }

    // Sweep over the FULL history of the basket, not the chosen window,
    // using the chosen window's length. That is the whole point: how did
    // this allocation do starting from every other date?
    const full = alignSeries(list);
    const benchSeries = await loadSeries(bench.id);
    const proj = benchSeries ? projectOnAxis(benchSeries, full.dates) : null;
    if (!proj) {
        host.innerHTML = `<div class="notice info"><h3 class="head">Not available</h3>
            ${bench.id} does not cover the full history of this basket.</div>`;
        return;
    }
    const sweepBlock = { dates: full.dates, prices: { ...full.prices, [bench.id]: proj.values } };
    const windowBars = aligned.dates.length;
    const userStart = full.dates.indexOf(aligned.dates[0]);

    const sweep = baseRateSweep(sweepBlock, {
        weights, benchmark: bench.id, windowBars,
        rebalanceDays: cfg.rebalance, costBps: cfg.costBps, feeBps: cfg.feeBps,
        annualization: ann, userStartIndex: userStart >= 0 ? userStart : null,
    });

    if (sweep.tooShort || !sweep.count) {
        host.innerHTML = `<div class="notice"><h3 class="head">Only one window exists</h3>
            This basket has <b>${full.dates.length.toLocaleString()}</b> trading days of history and you asked for a
            <b>${windowBars.toLocaleString()}</b>-day window, so there is no second window to compare against.
            <strong>The result above is a single observation.</strong> Shorten the window or pick instruments with longer histories.</div>`;
        return;
    }

    const verdict = sweep.userPercentile == null ? ''
        : sweep.userPercentile > 0.8 ? 'Your window was one of the better ones.'
        : sweep.userPercentile < 0.2 ? 'Your window was one of the worse ones.'
        : 'Your window was fairly typical.';

    // The 1e-9 floor prevents a division by zero when every margin is
    // identical; the 4px floor keeps a zero-margin window visible.
    const maxAbs = Math.max(...sweep.windows.map(w => Math.abs(w.margin)), 1e-9);
    const bars = sweep.windows.map(w => {
        const h = Math.max(4, Math.round(Math.abs(w.margin) / maxAbs * 34));
        // Match by index, not by margin: two unrelated windows can share a
        // margin, and float equality would outline both.
        const you = sweep.userStartIndex != null && w.startIndex === sweep.userStartIndex ? ' you' : '';
        return `<div class="bar${w.win ? '' : ' lose'}${you}" style="height:${h}px"
            title="${iso(w.from)} → ${iso(w.to)}: ${signed(w.margin)}/yr vs ${bench.id}"></div>`;
    }).join('');

    const thin = sweep.independentWindows < 4;
    host.innerHTML = `
    <div class="sweep">
        <div class="sweep-head">
            <span class="big">${sweep.wins} of ${sweep.count}</span>
            <span class="cap">windows of this length beat ${bench.id}</span>
            <span class="cap" style="margin-left:auto">${pct(sweep.winRate, 0)} win rate</span>
        </div>
        <div class="sweep-bars">${bars}</div>
        <div class="sweep-foot">
            <span><b>Median edge</b> ${signed(sweep.medianMargin)}/yr</span>
            <span><b>Worst</b> ${signed(sweep.worstMargin)}/yr</span>
            <span><b>Best</b> ${signed(sweep.bestMargin)}/yr</span>
            ${verdict ? `<span><b>${verdict}</b></span>` : ''}
        </div>
    </div>
    ${thin ? `<div class="notice"><h3 class="head">Read this before believing the number above</h3>
        Those ${sweep.count} windows overlap heavily. This basket only contains
        <strong>${sweep.independentWindows} genuinely independent</strong> window${sweep.independentWindows === 1 ? '' : 's'}
        of this length, so the win rate is far less meaningful than it looks. Longer histories —
        the index and bond funds go back to the 1990s, and the total US market to 1926 — give a real base rate.</div>` : ''}`;
}

async function renderNotices(ctx, ids, host, includeDrift) {
    const out = [];

    // Selection bias, measured rather than merely asserted.
    const biasedGroups = [...new Set(ids.map(id => catalogEntry(id)?.group).filter(g =>
        CATALOG.groups.find(x => x.id === g)?.warn === 'selection'))];

    for (const g of biasedGroups) {
        const groupIds = CATALOG.instruments.filter(i => i.group === g).map(i => i.id);
        const loaded = {};
        for (const id of groupIds) { const s = await loadSeries(id); if (s) loaded[id] = s; }
        const b = await loadSeries(benchmarkId());
        if (!b) continue;
        loaded[benchmarkId()] = b;
        const bias = groupBias(loaded, groupIds, benchmarkId());
        if (!bias) continue;
        const label = CATALOG.groups.find(x => x.id === g)?.label || g;
        out.push(`<div class="notice"><h3 class="head">This menu is rigged in your favour</h3>
            <strong>${bias.beat} of ${bias.count}</strong> instruments in “${label}” beat ${benchmarkId()} over their full
            shared history — the median did <strong>${pct(bias.median)}</strong> a year against the benchmark's
            <strong>${pct(bias.benchmark)}</strong>. They are on the menu because they are famous today, which is
            selection on the outcome. A portfolio built from this group was always going to look good, and that
            says nothing about your allocation.</div>`);
    }

    // Contributions buy at the target weights, so feeding money into a basket
    // you never rebalance quietly pulls it back toward target. That is a real
    // effect on the growth rate — several percentage points a year on a
    // concentrated basket — and it is invisible unless the page says it.
    if (includeDrift && ids.length > 1 && ctx.cfg.contribution > 0 && !ctx.cfg.rebalance) {
        out.push(`<div class="notice info"><h3 class="head">Your contributions are quietly rebalancing you</h3>
            You are adding money at your target weights but never rebalancing. Each contribution
            therefore buys proportionally more of whatever has lagged, which pulls the portfolio back
            toward target — <strong>a bigger contribution is a stronger pull</strong>, and it changes
            the growth rate above, not just the final value. Set a rebalance cadence to separate the
            two effects, or set contributions to zero to see the allocation drift on its own.</div>`);
    }

    // Written on every path, empty included: a previous run's notice attached
    // to fresh numbers is stale evidence.
    host.innerHTML = out.join('');
}

function renderBreakdown(sim, real, toToday) {
    const rows = Object.entries(sim.perAsset).sort((a, b) => b[1].finalValue - a[1].finalValue);
    const best = rows.reduce((a, b) => (b[1].priceReturn > a[1].priceReturn ? b : a));
    const colors = colorBySymbol();

    const weightSum = rows.reduce((s, [, a]) => s + a.weight, 0);
    const valueSum = rows.reduce((s, [, a]) => s + toToday(a.finalValue), 0);
    const shareSum = rows.reduce((s, [, a]) => s + a.share, 0);

    $('breakdownHost').innerHTML = `
    <table class="breakdown">
        <thead><tr>
            <th>Holding</th><th class="num">Weight</th><th class="num">Start</th><th class="num">End</th>
            <th class="num">Price return</th><th class="num">Value at end</th><th class="num">Share of portfolio</th>
        </tr></thead>
        <tbody>${rows.map(([sym, a]) => `
            <tr>
                <td><span class="swatch" style="--c:${colors[sym] || colorAt(0)}"></span>${sym}${sym === best[0] ? ' <span class="best-badge">best</span>' : ''}</td>
                <td class="num">${a.weight.toFixed(0)}%</td>
                <td class="num">${usdc(a.startPrice)}</td>
                <td class="num">${usdc(a.endPrice)}</td>
                <td class="num ${a.priceReturn >= 0 ? 'up' : 'down'}">${signed(a.priceReturn)}</td>
                <td class="num">${usd(toToday(a.finalValue))}</td>
                <td class="num">${pct(a.share, 1)}</td>
            </tr>`).join('')}
            ${rows.length > 1 ? `<tr class="totals">
                <td>Total</td>
                <td class="num">${weightSum.toFixed(0)}%</td>
                <td class="num"></td>
                <td class="num"></td>
                <td class="num"></td>
                <td class="num">${usd(valueSum)}</td>
                <td class="num">${pct(shareSum, 1)}</td>
            </tr>` : ''}
        </tbody>
    </table>
    <p class="breakdown-note">
        Price return is what the holding itself did over the window. It is deliberately not a
        per-holding profit figure: with rebalancing or contributions, how much money each holding
        actually made depends on when the money arrived, which is a portfolio-level question answered
        by the returns above.${real ? ' Start and end prices are the prices as traded on the day; only the value column is restated in today\'s dollars.' : ''}
    </p>`;
}

function renderLedger(sim) {
    // A one-row "Every purchase (1)" table is noise for a lump sum, and the
    // host is cleared explicitly so a previous run's ledger cannot linger.
    if (sim.purchases.length < 2) { $('ledgerHost').innerHTML = ''; return; }
    const rows = [...sim.purchases].reverse().slice(0, 520);
    $('ledgerHost').innerHTML = `
    <details class="ledger">
        <summary>Every purchase (${sim.purchases.length})</summary>
        <div class="ledger-scroll">
            <table class="breakdown">
                <thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th class="num">Cost</th><th class="num">Invested</th></tr></thead>
                <tbody>${rows.map(p => `
                    <tr>
                        <td>${iso(p.t)}</td>
                        <td>${p.kind === 'initial' ? 'Opening' : 'Contribution'}</td>
                        <td class="num">${usdc(p.gross)}</td>
                        <td class="num">${p.cost ? usdc(p.cost) : '—'}</td>
                        <td class="num">${usdc(p.net)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
        ${sim.purchases.length > 520 ? `<p class="breakdown-note">Showing the most recent 520 of ${sim.purchases.length}.</p>` : ''}
    </details>`;
}

// ── Duel ────────────────────────────────────────────────────────────

async function runDuel(ctx) {
    const { cfg, aligned, ann, rfDaily, cpiAxis, cpiBase, real, bench, clamped, ids } = ctx;
    const weights = {};
    cfg.alloc.forEach(a => weights[a.sym] = a.weight);

    const d = duel(aligned, {
        weights, total: cfg.total, deployments: cfg.deployments,
        deploymentDays: 30, rebalanceDays: cfg.rebalance,
        costBps: cfg.costBps, feeBps: cfg.feeBps,
        annualization: ann, rfDaily,
    });

    // Real mode has to reach the duel too, or the assumption chip says
    // "today's dollars" over a table of nominal ones. Inflation hits both
    // sides identically so the winner never changes — but the magnitudes
    // do, and a label that does not match its number is the exact failure
    // this rebuild exists to remove.
    // The scalars have to travel with the series. Restating wealth but leaving
    // the stake, the friction and the uninvested cash nominal printed
    // "Both start with $120,000" directly above a deflated final value of
    // $470,014 — on a 1929 window that reads as a 4x gain on a run that
    // actually lost 80%, and "ended $301,084 ahead" of a $120,000 stake is
    // impossible on its face. Anything the renderers print in dollars gets
    // deflated here or the label stops matching the number.
    let duelTotal = cfg.total;
    if (real) {
        const toReal = arr => arr.map((v, i) => v * cpiBase / cpiAxis[i]);
        for (const side of [d.lump, d.dose]) {
            side.wealth = toReal(side.wealth);
            side.nav = deflate(side.nav, cpiAxis, cpiBase);
            side.metrics = metrics(side.nav, aligned.dates, { annualization: ann, rfDaily });
            side.final = side.wealth[side.wealth.length - 1];
            side.irr = xirr(deflateFlows(side.flows, aligned.dates, cpiAxis, cpiBase));
            // Costs accrue across the window; the wealth series they were paid
            // out of is restated at the window end, so they follow it there.
            side.costs = side.costs * cpiBase / cpiAxis[cpiAxis.length - 1];
        }
        d.dose.invested = toReal(d.dose.invested);
        // The stake is committed on the FIRST bar, so it inflates forward from
        // there — not from the window end like the closing balances.
        duelTotal = cfg.total * cpiBase / cpiAxis[0];
        if (d.dose.cashLeft) d.dose.cashLeft = d.dose.cashLeft * cpiBase / cpiAxis[cpiAxis.length - 1];
    }

    if (d.lump.metrics.insufficient || d.dose.metrics.insufficient) {
        throw new Error('This window is too short to compare the two approaches — widen it.');
    }

    renderCoverage(ctx, bench, null, clamped);
    renderAssumptions(cfg, d.lump.metrics, real);

    // maxDD is negative-or-zero, so >= picks the SHALLOWER fall. Flipping it
    // to the intuitive "smaller loss" inverts the verdict.
    const moneyWinner = d.lump.final >= d.dose.final ? 'lump' : 'dose';
    const riskWinner = d.lump.metrics.maxDD >= d.dose.metrics.maxDD ? 'lump' : 'dose';
    const gap = Math.abs(d.lump.final - d.dose.final);

    $('duelStats').innerHTML =
        tile('All at once', usd(d.lump.final), 'invested on day one', moneyWinner === 'lump' ? 'up' : null) +
        tile('Spread out', usd(d.dose.final), `${cfg.deployments} monthly instalments`, moneyWinner === 'dose' ? 'up' : null) +
        tile('Difference', usd(gap), `${moneyWinner === 'lump' ? 'all at once' : 'spreading out'} ended ahead`) +
        tile('Smoother ride', riskWinner === 'lump' ? 'All at once' : 'Spread out',
            `${pct(Math.max(d.lump.metrics.maxDD, d.dose.metrics.maxDD))} vs ${pct(Math.min(d.lump.metrics.maxDD, d.dose.metrics.maxDD))} worst fall`);
    animateValues($('duelStats'));

    const row = (label, lens, a, b, better) => `<tr>
            <td>${label}<div class="lens">${lens}</div></td>
            <td class="${better === 'a' ? 'win' : ''}">${a}</td>
            <td class="${better === 'b' ? 'win' : ''}">${b}</td>
        </tr>`;
    // Float noise would otherwise crown a winner by 1e-15 of a percent — a
    // visually confident verdict on nothing.
    const cmp = (a, b, higherIsBetter = true) =>
        Math.abs(a - b) < 1e-12 ? null : ((a > b) === higherIsBetter ? 'a' : 'b');

    $('duelTable').innerHTML = `
    <thead><tr><th>Measure</th><th>All at once</th><th>Spread out</th></tr></thead>
    <tbody>
        ${row('Final value', 'money', usd(d.lump.final), usd(d.dose.final), cmp(d.lump.final, d.dose.final))}
        ${/* No separate money-weighted row: both sides commit the whole sum on
              day one under this comparison's fairness contract, so with a single
              cash flow the money-weighted and time-weighted returns are the same
              number. Printing it twice under two names would imply a distinction
              that does not exist here. */''}
        ${row('Growth rate', 'per year', pct(d.lump.metrics.cagr), pct(d.dose.metrics.cagr), cmp(d.lump.metrics.cagr, d.dose.metrics.cagr))}
        ${row('Worst fall', 'risk', pct(d.lump.metrics.maxDD), pct(d.dose.metrics.maxDD), cmp(d.lump.metrics.maxDD, d.dose.metrics.maxDD))}
        ${row('Volatility', 'risk', pct(d.lump.metrics.vol), pct(d.dose.metrics.vol), cmp(d.lump.metrics.vol, d.dose.metrics.vol, false))}
        ${row('Sharpe', 'risk-adjusted', d.lump.metrics.sharpe.toFixed(2), d.dose.metrics.sharpe.toFixed(2), cmp(d.lump.metrics.sharpe, d.dose.metrics.sharpe))}
        ${row('Worst day', 'risk', signed(d.lump.metrics.worst), signed(d.dose.metrics.worst), cmp(d.lump.metrics.worst, d.dose.metrics.worst))}
        ${row('Paid in friction', 'cost', usdc(d.lump.costs), usdc(d.dose.costs), cmp(d.lump.costs, d.dose.costs, false))}
    </tbody>`;

    // ── Narrative, generated from the data rather than asserted ──
    const p = aligned.prices;
    const firstDate = iso(aligned.dates[0]);
    // Double guard: ?? covers a duel that never finished deploying, Math.min
    // covers an index past the axis. Either would put NaN in the story.
    const deployEnd = Math.min(aligned.dates.length - 1, d.dose.fullyInvestedAt ?? aligned.dates.length - 1);
    let riseDuringDeploy = 0;
    for (const [sym, w] of Object.entries(weights)) {
        riseDuringDeploy += (w / 100) * (p[sym][deployEnd] / p[sym][0] - 1);
    }
    const story = [];
    story.push(`Both start with <span class="num">${usd(duelTotal)}</span> on <span class="num">${firstDate}</span>. Investing it all immediately means the whole amount is exposed from day one. Spreading it over ${cfg.deployments} months means the rest sits in cash${d.cashEarnsRf ? ', earning the actual Treasury-bill rate of the day' : ', earning nothing'}, and gets invested a slice at a time.`);
    if (riseDuringDeploy > 0.005) {
        story.push(`The market <strong>rose ${pct(riseDuringDeploy)}</strong> while the money was still being deployed, so every later instalment bought at a higher price than day one. That is why investing all at once usually wins: the market goes up more often than it goes down, and cash on the sidelines misses it.`);
    } else if (riseDuringDeploy < -0.005) {
        story.push(`The market <strong>fell ${pct(Math.abs(riseDuringDeploy))}</strong> while the money was still being deployed, so the later instalments bought cheaper than day one. That is the scenario where spreading out pays.`);
    } else {
        story.push('The market was <strong>roughly flat</strong> during the deployment period, so neither approach got much of an entry-price advantage.');
    }
    story.push(`The counterweight is on the risk side: the worst fall was <span class="num">${pct(d.lump.metrics.maxDD)}</span> investing all at once versus <span class="num">${pct(d.dose.metrics.maxDD)}</span> spreading out. <strong>Spreading out buys a calmer ride, and usually pays for it in returns.</strong>`);
    if (d.neverFullyInvested) {
        story.push(`Note: ${cfg.deployments} instalments do not fit inside this window — <span class="num">${usd(d.dose.cashLeft)}</span> was never invested. Use a longer window or fewer instalments.`);
    }
    story.push('<span style="color:var(--faint)">Assumes no taxes, trades at the closing price, and that you would actually have gone through with it.</span>');
    $('duelStory').innerHTML = story.map(s => `<p>${s}</p>`).join('');

    await renderNotices(ctx, ids, $('duelNoticeHost'), false);

    drawDuelChart(aligned.dates, d);
    await renderDuelSweep(ctx, weights);

    lastRun = { dates: aligned.dates, duel: d, cfg, real, cpiAxis, cpiBase };
}

async function renderDuelSweep(ctx, weights) {
    const { list, ann, cfg, aligned } = ctx;
    const host = $('duelSweepHost');
    const full = alignSeries(list);
    const windowBars = aligned.dates.length;
    if (windowBars >= full.dates.length) {
        host.innerHTML = `<div class="notice"><h3 class="head">Only one window exists</h3>
            There is not enough history to replay this comparison from other start dates.</div>`;
        return;
    }

    // The replay has to make the same cash assumption the paragraph above it
    // states. Running the sweep without a risk-free rate handicaps the
    // spread-out side in every window and biases the win rate toward
    // investing all at once — by over $3,000 on a five-percent window.
    const rfSeries = await loadSeries('RF');
    const rfFull = rfSeries
        ? rfOnAxis({ dates: rfSeries.dates, values: rfSeries.values }, full.dates)
        : null;

    const step = Math.max(21, Math.ceil((full.dates.length - windowBars) / 200));
    let wins = 0, count = 0, marginSum = 0;
    const bars = [];
    for (let s = 0; s + windowBars < full.dates.length; s += step) {
        const slice = { dates: full.dates.slice(s, s + windowBars + 1), prices: {} };
        for (const k of Object.keys(full.prices)) slice.prices[k] = full.prices[k].slice(s, s + windowBars + 1);
        let r;
        try {
            r = duel(slice, {
                weights, total: cfg.total, deployments: cfg.deployments,
                rebalanceDays: cfg.rebalance, costBps: cfg.costBps, feeBps: cfg.feeBps,
                annualization: ann,
                rfDaily: rfFull ? rfFull.slice(s, s + windowBars + 1) : null,
            });
        } catch { continue; }   // one degenerate slice must not blank the strip
        const margin = r.lump.final / r.dose.final - 1;
        const lumpWins = r.lump.final > r.dose.final;
        if (lumpWins) wins++;
        count++; marginSum += margin;
        bars.push({ margin, lumpWins, from: slice.dates[0], to: slice.dates[slice.dates.length - 1] });
    }
    if (!count) { host.innerHTML = ''; return; }

    const maxAbs = Math.max(...bars.map(b => Math.abs(b.margin)), 1e-9);
    host.innerHTML = `
    <div class="sweep">
        <div class="sweep-head">
            <span class="big">${pct(wins / count, 0)}</span>
            <span class="cap">of ${count} windows, investing all at once ended ahead</span>
        </div>
        <div class="sweep-bars">${bars.map(b => `
            <div class="bar${b.lumpWins ? '' : ' lose'}" style="height:${Math.max(4, Math.round(Math.abs(b.margin) / maxAbs * 34))}px"
                title="${iso(b.from)} → ${iso(b.to)}: all-at-once ${signed(b.margin)} vs spread out"></div>`).join('')}
        </div>
        <div class="sweep-foot">
            <span><b>Average edge to investing all at once</b> ${signed(marginSum / count)}</span>
            <span style="color:var(--faint)">Bars above the line: all at once won</span>
        </div>
    </div>`;
}

// ── Charts ──────────────────────────────────────────────────────────

const moneyFormat = v => '$' + Math.round(v).toLocaleString('en-US');

function buildGrowthSource(dates, sim, benchSim, bench, cfg, real, cpiAxis, cpiBase, realBasis, m) {
    const adj = arr => real && cpiAxis ? arr.map((v, i) => v * cpiBase / cpiAxis[i]) : arr;

    const datasets = [{
        label: 'Your portfolio', data: adj(sim.equity),
        color: 'var(--accent)', width: 2, fill: true,
    }];
    if (benchSim && bench) {
        datasets.push({
            label: `${bench.id} with the same money`, data: adj(benchSim.equity),
            color: 'var(--s2)', width: 1.6, dash: [5, 4],
        });
    }
    if (cfg.contribution > 0 || sim.purchases.length > 1) {
        // realBasis is already in today's dollars — it was rebuilt from the
        // dated purchases, so it must not go through adj() a second time.
        datasets.push({
            label: 'What you put in', data: realBasis || sim.basis,
            color: 'var(--faint)', width: 1.2, dash: [2, 3], stepped: true,
        });
    }

    // The band is keyed to indices, so the ms dates the metrics report have
    // to be looked up on the axis they came from.
    const byDate = new Map(dates.map((d, i) => [d, i]));
    const drawdown = m.maxDD < 0 && byDate.has(m.ddFrom) && byDate.has(m.ddTo)
        ? { fromIndex: byDate.get(m.ddFrom), toIndex: byDate.get(m.ddTo) }
        : null;

    growthSource = { labels: dates.map(iso), datasets, drawdown };
}

function drawGrowth() {
    if (!growthSource) return;
    // Chart.js keeps a registry keyed on the canvas: constructing over a live
    // instance leaks the old one and leaves ghost tooltips and hover handlers
    // from the previous run.
    destroyChart(growthChart);
    growthChart = null;
    growthChart = renderGrowthChart($('chart'), $('chartLegend'), {
        labels: growthSource.labels,
        datasets: growthSource.datasets,
        logScale: chartLog,
        drawdown: chartDD ? growthSource.drawdown : null,
        onBrush: applyBrush,
        valueFormat: moneyFormat,
    });
}

function drawDuelChart(dates, d) {
    destroyChart(duelChart);
    duelChart = null;
    duelChart = renderDuelChart($('duelChart'), $('duelChartLegend'), {
        labels: dates.map(iso),
        // Already restated in place when real mode is on, so no adjustment here.
        datasets: [
            { label: 'All at once', data: d.lump.wealth, color: 'var(--accent)', width: 2 },
            { label: 'Spread out', data: d.dose.wealth, color: 'var(--s2)', width: 2 },
            { label: 'Money actually invested', data: d.dose.invested, color: 'var(--faint)', width: 1.2, dash: [2, 3], stepped: true },
        ],
        logScale: false,
        drawdown: null,
        onBrush: () => {},
        valueFormat: moneyFormat,
    });
}

/**
 * A drag across the plot becomes a custom window and a re-run, so the zoom is
 * a real narrowing of the simulation rather than a cosmetic crop — every
 * metric below the chart then describes what is on it.
 */
function applyBrush(fromIndex, toIndex) {
    if (!lastRun?.dates) return;
    const dates = lastRun.dates;
    const lo = Math.max(0, Math.min(fromIndex, toIndex));
    const hi = Math.min(dates.length - 1, Math.max(fromIndex, toIndex));
    // Two bars cannot be measured, and a sliver is a mis-click rather than a
    // window.
    if (hi - lo < 2) return;
    if (!preBrush) preBrush = { range: $('lookback').value, from: $('fromDate').value, to: $('toDate').value };
    $('lookback').value = 'custom';
    $('fromDate').value = iso(dates[lo]);
    $('toDate').value = iso(dates[hi]);
    syncRangeFields();
    $('chartReset').hidden = false;
    run();
}

function clearBrush(rerun) {
    if (!preBrush) return;
    $('lookback').value = preBrush.range;
    $('fromDate').value = preBrush.from;
    $('toDate').value = preBrush.to;
    preBrush = null;
    // The button hides itself, so pass focus to the tool button beside it
    // rather than letting it fall to <body>.
    rehomeFocus($('chartReset'), () => $('chartScale'));
    $('chartReset').hidden = true;
    syncRangeFields();
    if (rerun) run();
}

// ── Export ──────────────────────────────────────────────────────────

function exportCsv() {
    if (!lastRun) return;
    const { dates, real, cpiAxis, cpiBase } = lastRun;
    // The CSV must agree with what was on screen. Exporting nominal columns
    // from a run the page labelled "today's dollars" would be the same class
    // of lie the metrics rebuild removed, just moved into a file.
    // The null passthrough matters: null * x is 0, which would export a
    // fabricated zero NAV as if it were data.
    const adj = arr => (real && cpiAxis)
        ? arr.map((v, i) => (v == null ? v : v * cpiBase / cpiAxis[i]))
        : arr;
    const unit = real ? '_real' : '_nominal';
    let head, rows;
    if (lastRun.duel) {
        // The duel's series were already restated in place when real mode is on.
        const d = lastRun.duel;
        head = `date,all_at_once${unit},spread_out${unit},invested${unit}`;
        rows = dates.map((t, i) => [iso(t), d.lump.wealth[i], d.dose.wealth[i], d.dose.invested[i]].join(','));
    } else {
        const { sim, benchSim, bench } = lastRun;
        const equity = adj(sim.equity), basis = lastRun.realBasis || sim.basis;
        const benchEquity = benchSim ? adj(benchSim.equity) : null;
        head = `date,portfolio${unit},contributed${unit},nav_index${benchEquity ? `,${bench.id}${unit}` : ''}`;
        rows = dates.map((t, i) => {
            const cols = [iso(t), equity[i], basis[i], sim.nav[i] ?? ''];
            if (benchEquity) cols.push(benchEquity[i]);
            return cols.join(',');
        });
    }
    const blob = new Blob([head + '\n' + rows.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chronoticker-${iso(dates[0])}-to-${iso(dates[dates.length - 1])}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Wiring ──────────────────────────────────────────────────────────

function loadPreset(key, label, andRun) {
    const pairs = ALLOC_PRESETS[key];
    if (!pairs) return;
    const dropped = setAllocations(pairs);
    if (dropped.length) {
        setStatus('warn', `${label} needs ${dropped.join(', ')}, which has not been fetched yet — ` +
            `loaded the rest, so the weights no longer total 100%. Run the "Refresh stock data" action to backfill.`);
    } else if (!andRun) {
        setStatus('', 'Ready.');
    }
    if (andRun) run();
    else scheduleRun();
}

function wire() {
    // The preset cards' clickable area is almost entirely their child spans,
    // so e.target.dataset.preset is undefined for most real clicks.
    $('presetGrid').addEventListener('click', e => {
        const card = e.target.closest('[data-preset]');
        if (!card || card.disabled) return;
        const label = card.querySelector('.pc-name')?.textContent || card.textContent.trim();
        loadPreset(card.dataset.preset, label, true);
    });

    $('allocPresets').addEventListener('click', e => {
        const btn = e.target.closest('[data-preset]');
        if (!btn || btn.disabled) return;
        loadPreset(btn.dataset.preset, btn.textContent, false);
    });

    $('regimePresets').addEventListener('click', e => {
        const btn = e.target.closest('[data-regime]');
        if (!btn) return;
        const r = REGIMES[btn.dataset.regime];
        preBrush = null;
        $('chartReset').hidden = true;
        $('lookback').value = 'custom';
        $('fromDate').value = r.from;
        $('toDate').value = r.to;
        syncRangeFields();
        run();
    });

    $('addAsset').addEventListener('click', () => {
        makeRow(AVAILABLE[0]?.id || 'SPY', 0);
        refreshAlloc();
    });
    $('equalWeights').addEventListener('click', () => {
        const rows = rowEls();
        if (!rows.length) return;
        const next = evenSplit(rows.length);
        rows.forEach((r, i) => r.querySelector('input').value = next[i]);
        refreshAlloc();
        scheduleRun();
    });

    $('lookback').addEventListener('change', () => {
        preBrush = null;
        $('chartReset').hidden = true;
        syncRangeFields();
    });
    // Clearing a date must not lock the user into a custom range with a
    // half-empty date pair.
    ['fromDate', 'toDate'].forEach(id => $(id).addEventListener('change', () => {
        if ($(id).value) { $('lookback').value = 'custom'; syncRangeFields(); }
    }));

    // Live mode: one delegated pair on the rail covers every control in it,
    // including the rows the controller generates later.
    const rail = document.querySelector('.rail');
    rail.addEventListener('change', e => {
        if (e.target.id === 'autoRun') return;
        scheduleRun();
    });
    rail.addEventListener('input', e => {
        if (e.target.id === 'autoRun') return;
        scheduleRun();
    });
    $('autoRun').addEventListener('change', () => {
        if ($('autoRun').checked && hasRun) run();
    });

    const tabs = [$('modeBacktest'), $('modeDuel')];
    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => setMode(i === 0 ? 'backtest' : 'duel'));
        tab.addEventListener('keydown', e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const dir = e.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(i + dir + tabs.length) % tabs.length];
            setMode(next === tabs[0] ? 'backtest' : 'duel');
            next.focus();
        });
    });

    $('run').addEventListener('click', () => run({ explicit: true }));

    $('chartScale').addEventListener('click', () => {
        chartLog = !chartLog;
        syncChartTools();
        drawGrowth();
        if (lastRun) writeURL(lastRun.cfg);
    });
    $('chartDD').addEventListener('click', () => {
        chartDD = !chartDD;
        syncChartTools();
        drawGrowth();
        if (lastRun) writeURL(lastRun.cfg);
    });
    $('chartReset').addEventListener('click', () => clearBrush(true));

    $('exportCsv').addEventListener('click', exportCsv);
    $('copyLink').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            $('copyLink').textContent = 'Link copied';
            setTimeout(() => $('copyLink').textContent = 'Copy link to this run', 1600);
        } catch {
            // Insecure origins and denied permissions both land here; without
            // the fallback the button appears to do nothing and there is no
            // other way to get the link.
            $('copyLink').textContent = location.href;
            setTimeout(() => $('copyLink').textContent = 'Copy link to this run', 6000);
        }
    });
}

// ── Boot ────────────────────────────────────────────────────────────

(async function boot() {
    try {
        injectDuelHosts();
        // #weightBar ships aria-hidden while the CSS puts focusable handles
        // inside it. weights.js owns that contradiction, and fixes it, when it
        // fills the container — nothing to do here but stay out of its way.

        // The markup owns the chart-tool defaults; reading them here is what
        // keeps the buttons and the first chart from disagreeing.
        chartLog = $('chartScale').getAttribute('aria-pressed') === 'true';
        chartDD = $('chartDD').getAttribute('aria-pressed') === 'true';

        // Chart.js defaults are theme-wide and cheap to set once.
        if (typeof Chart !== 'undefined') deckChartTheme();

        wire();
        setMode('backtest');

        await loadCatalog();
        AVAILABLE = await availableInstruments();
        if (!AVAILABLE.length) throw new Error('No price data found under /data/.');
        markPresetAvailability();

        const fromURL = readURL();
        // Belt and braces against ever landing on an empty rail: whatever the
        // link did or did not carry, the workbench always opens with something
        // to run.
        if (!rowEls().length) setAllocations([['AAPL', 40], ['MSFT', 30], ['NVDA', 30]]);
        refreshAlloc();

        const total = CATALOG.instruments.length;
        const ready = AVAILABLE.length < total
            ? `Ready · ${AVAILABLE.length} of ${total} instruments have data (the rest have not been fetched yet).`
            : `Ready · ${AVAILABLE.length} instruments available.`;

        // A shared link reproduces its result without a click; a cold visit
        // shows the front door instead of firing a simulation nobody asked for.
        if (fromURL) {
            $('launchpad').hidden = true;
            setStatus('', ready);
            run();
        } else if (linkWarning) {
            setStatus('warn', `${ready} — ${linkWarning}`);
            linkWarning = null;
        } else {
            setStatus('', ready);
        }
    } catch (err) {
        console.error(err);
        setStatus('error', `Could not start: ${err.message}`);
    }
})();
