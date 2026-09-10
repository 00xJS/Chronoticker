// Chronoticker charts — every line of Chart.js in the app lives here.
//
// Depends only on the global `Chart` that index.html loads from the CDN
// (chart.js@4.4.7, UMD). No imports, no build step, no plugin packages:
// the crosshair, the drawdown band and the drag-to-zoom brush are all
// hand-written below because chartjs-plugin-zoom is not loaded and adding
// a second CDN tag to a static page is a bigger cost than 200 lines.
//
// Two rules the rest of the app depends on:
//
//   1. Plugins are passed per-chart in the config's own `plugins` array,
//      never through Chart.register(). A registered plugin runs on EVERY
//      chart on the page, so registering the drawdown band would paint the
//      backtest's worst fall across the duel chart too.
//   2. Colours are resolved to real values before they reach the canvas.
//      A 2D context does not understand CSS custom properties: `var(--s3)`
//      arrives at ctx.strokeStyle as an invalid colour and the line simply
//      does not draw, with nothing in the console. The DOM legend keeps the
//      raw token, because there `var()` works and survives the print-mode
//      token swap.

// ── Theme ───────────────────────────────────────────────────────────

/**
 * Pull the deck's tokens out of :root, push the shared ones into
 * Chart.defaults, and hand back the palette both renderers draw with.
 */
export function deckChartTheme() {
    requireChart();
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();

    Chart.defaults.color = v('--muted');
    Chart.defaults.borderColor = gridColor();
    Chart.defaults.font.family = v('--font-sans');

    return {
        accent: v('--accent') || '#ff9a44',
        accentDeep: v('--accent-deep') || '#e8792b',
        muted: v('--muted') || '#9ba1c5',
        faint: v('--faint') || '#848ab0',
        magenta: v('--magenta') || '#c23e8c',
        live: v('--live') || '#3ddc84',
        warn: v('--warn') || '#ffc24b',
        down: v('--down') || '#ff6b6b',
        text: v('--text') || '#e8eaf6',
        border: v('--border') || 'rgba(255,255,255,0.09)',
        borderStrong: v('--border-strong') || 'rgba(255,255,255,0.16)',
        tooltipBg: v('--bg-raised') || '#10142e',
        card: v('--card') || '#12163a',
        grid: gridColor(),
        series: v('--accent') || '#ff9a44',
        // --s2 is the same blue the old page hard-coded as a hex because no
        // token existed yet. It does now, so the comparison line follows the
        // palette instead of drifting away from it.
        series2: v('--s2') || '#5b8def',
    };
}

// Grid lines sit UNDER the data and want to be lighter than --border, which
// is tuned for card edges. Read from a token rather than hard-coded, because
// the canvas is the one element the @media print swap cannot reach: a white
// grid on white paper is invisible, so --grid is re-pointed for print and
// resolved here at build time.
const gridColor = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--grid').trim()
    || 'rgba(255, 255, 255, 0.07)';

function requireChart() {
    if (typeof Chart === 'undefined') {
        // run() prints err.message verbatim, so this has to read as a sentence.
        throw new Error('The charting library did not load — check your connection and reload.');
    }
}

// ── Colour helpers ──────────────────────────────────────────────────

const VAR_RE = /^\s*var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)\s*$/;

/** Turn `var(--s3)` (or a plain colour) into something a canvas accepts. */
function resolveColor(value, fallback) {
    if (!value) return fallback;
    const m = VAR_RE.exec(String(value));
    if (!m) return String(value);
    const token = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    if (token) return token;
    return m[2] ? resolveColor(m[2].trim(), fallback) : fallback;
}

/** Same colour at a given alpha, for fills and shaded bands. */
function tint(value, alpha) {
    const c = resolveColor(value, '#ff9a44');
    let r, g, b;
    if (c.charAt(0) === '#') {
        const hex = c.slice(1);
        const full = hex.length === 3
            ? hex.split('').map(ch => ch + ch).join('')
            : hex.slice(0, 6);
        const n = parseInt(full, 16);
        if (!Number.isFinite(n)) return `rgba(255,154,68,${alpha})`;
        r = (n >> 16) & 255;
        g = (n >> 8) & 255;
        b = n & 255;
    } else {
        const parts = c.match(/-?\d*\.?\d+/g);
        if (!parts || parts.length < 3) return `rgba(255,154,68,${alpha})`;
        r = Number(parts[0]);
        g = Number(parts[1]);
        b = Number(parts[2]);
    }
    return `rgba(${r},${g},${b},${alpha})`;
}

// ── Shared plumbing ─────────────────────────────────────────────────

const DEFAULT_FORMAT = n => '$' + Math.round(Number(n)).toLocaleString('en-US');

// Which canvases have already drawn once this session. A re-run with a
// slightly different contribution should not replay a second of animation
// on every keystroke, but the very first chart of the session earns it.
const HAS_DRAWN = new WeakSet();

function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clampIndex(i, n) {
    if (!Number.isFinite(i)) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(i)));
}

/**
 * Strip anything a line cannot draw, and — on a log axis — anything that
 * would blank the entire canvas.
 *
 * A logarithmic scale given a zero or a negative value does not clip the
 * point, it renders NOTHING: no axis, no lines, no error. The "what you put
 * in" series legitimately sits at 0 until the first purchase lands, so those
 * bars become gaps rather than taking the whole chart down with them.
 */
function cleanData(data, logScale) {
    return (data || []).map(v => {
        if (v == null || !Number.isFinite(v)) return null;
        if (logScale && v <= 0) return null;
        return v;
    });
}

// Category labels, not a time scale: Chart.js time scales need a date
// adapter library and none is loaded. ISO strings sort correctly and read
// fine on the axis, which is all this needs.
function baseScales(th, logScale, fmt) {
    return {
        x: {
            grid: { display: false },
            ticks: {
                maxTicksLimit: 8,
                color: th.faint,
                maxRotation: 0,
                autoSkip: true,
                font: { size: 10.5 },
            },
        },
        y: {
            type: logScale ? 'logarithmic' : 'linear',
            grid: { color: th.grid, drawTicks: false },
            border: { display: false },
            ticks: {
                color: th.faint,
                font: { size: 10.5 },
                padding: 6,
                callback(value, index, ticks) {
                    // A log axis generates a tick per significand, so labelling
                    // every one crowds the axis into mush. Chart.js's own
                    // logarithmic formatter already decides which decades keep a
                    // label; borrow that decision and only re-format the winners.
                    if (logScale && Chart.Ticks && Chart.Ticks.formatters) {
                        const keep = Chart.Ticks.formatters.logarithmic.call(this, value, index, ticks);
                        if (keep === '') return '';
                    }
                    return fmt(value);
                },
            },
        },
    };
}

// ── Plugins (local to one chart, never Chart.register'd) ────────────

/** A 1px vertical line at the hovered bar, so the eye can read across. */
function crosshairPlugin(th) {
    return {
        id: 'deckCrosshair',
        afterDatasetsDraw(chart) {
            const active = chart.getActiveElements ? chart.getActiveElements() : [];
            if (!active || !active.length) return;
            const el = active[0].element;
            if (!el) return;
            const area = chart.chartArea;
            const x = Math.round(el.x) + 0.5; // half-pixel, or a 1px line blurs to 2
            if (x < area.left || x > area.right) return;
            const ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth = 1;
            ctx.strokeStyle = th.borderStrong;
            ctx.moveTo(x, area.top);
            ctx.lineTo(x, area.bottom);
            ctx.stroke();
            ctx.restore();
        },
    };
}

/**
 * The deepest peak-to-trough fall, shaded behind the data.
 *
 * beforeDatasetsDraw, not after: a band painted over the lines makes the
 * exact region the user is trying to read the hardest one to read.
 */
function drawdownBandPlugin(th, state) {
    return {
        id: 'deckDrawdownBand',
        beforeDatasetsDraw(chart) {
            const dd = state.drawdown;
            if (!dd) return;
            const n = (chart.data.labels || []).length;
            if (n < 2) return;
            const from = clampIndex(dd.fromIndex, n);
            const to = clampIndex(dd.toIndex, n);
            if (to <= from) return; // a zero drawdown has ddFrom === ddTo

            const xs = chart.scales.x;
            const area = chart.chartArea;
            const raw0 = xs.getPixelForValue(from);
            const raw1 = xs.getPixelForValue(to);
            const x0 = Math.max(area.left, Math.min(raw0, raw1));
            const x1 = Math.min(area.right, Math.max(raw0, raw1));
            if (!(x1 - x0 > 1)) return;

            const ctx = chart.ctx;
            ctx.save();
            ctx.fillStyle = tint(th.down, 0.11);
            ctx.fillRect(x0, area.top, x1 - x0, area.bottom - area.top);
            ctx.strokeStyle = tint(th.down, 0.34);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x0) + 0.5, area.top);
            ctx.lineTo(Math.round(x0) + 0.5, area.bottom);
            ctx.moveTo(Math.round(x1) + 0.5, area.top);
            ctx.lineTo(Math.round(x1) + 0.5, area.bottom);
            ctx.stroke();
            ctx.restore();
        },
    };
}

/**
 * Drag across the plot area to select a window; on release the caller gets
 * the two bar indices and decides what to do with them (the controller
 * re-runs against the narrower window and unhides its reset button).
 *
 * The 8px floor is what separates a brush from a click. Without it every
 * stray click on the canvas — including the one that dismisses a tooltip —
 * fires a zero-width zoom and the chart appears to break on contact.
 */
function brushZoomPlugin(th, state) {
    const MIN_DRAG_PX = 8;
    let canvas = null;
    let priorCursor = '';
    let priorTouch = '';
    let frame = 0;
    let onDown = null;
    let onMove = null;
    let onUp = null;
    let onCancel = null;

    const repaint = chart => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (chart.canvas) chart.draw();
        });
    };

    return {
        id: 'deckBrushZoom',

        afterInit(chart) {
            if (typeof state.onBrush !== 'function') return;
            canvas = chart.canvas;
            priorCursor = canvas.style.cursor;
            canvas.style.cursor = 'crosshair';
            // Without this the browser claims the gesture for panning and no
            // pointermove ever reaches the brush, so drag-to-zoom was inert on
            // every touch device. pan-y rather than none: a horizontal brush
            // still works, and the page can still be scrolled vertically over
            // the chart, which is the only way past a full-width canvas on a
            // phone.
            priorTouch = canvas.style.touchAction;
            canvas.style.touchAction = 'pan-y';

            // Canvas pixels, not client pixels: the element can be scaled by
            // CSS (it is width:100% inside a flexible card), so a raw
            // clientX offset would drift from the chart's own coordinates.
            const xOf = ev => {
                const rect = canvas.getBoundingClientRect();
                if (!rect.width) return 0;
                return (ev.clientX - rect.left) * (chart.width / rect.width);
            };

            onDown = ev => {
                if (ev.button != null && ev.button !== 0) return;
                const area = chart.chartArea;
                if (!area) return;
                const rect = canvas.getBoundingClientRect();
                const y = rect.height ? (ev.clientY - rect.top) * (chart.height / rect.height) : 0;
                const x = xOf(ev);
                if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
                state.brush = { from: x, to: x };
                if (canvas.setPointerCapture && ev.pointerId != null) {
                    try { canvas.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
                }
                ev.preventDefault();
                repaint(chart);
            };

            onMove = ev => {
                if (!state.brush) return;
                const area = chart.chartArea;
                state.brush.to = Math.max(area.left, Math.min(area.right, xOf(ev)));
                repaint(chart);
            };

            onUp = ev => {
                const brush = state.brush;
                state.brush = null;
                if (canvas.releasePointerCapture && ev.pointerId != null) {
                    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
                }
                if (chart.canvas) chart.draw();
                if (!brush) return;
                if (Math.abs(brush.to - brush.from) < MIN_DRAG_PX) return; // a click, not a brush

                const xs = chart.scales.x;
                const n = (chart.data.labels || []).length;
                const lo = clampIndex(xs.getValueForPixel(Math.min(brush.from, brush.to)), n);
                const hi = clampIndex(xs.getValueForPixel(Math.max(brush.from, brush.to)), n);
                if (hi <= lo) return;
                state.onBrush(lo, hi);
            };

            onCancel = () => {
                state.brush = null;
                if (chart.canvas) chart.draw();
            };

            canvas.addEventListener('pointerdown', onDown);
            canvas.addEventListener('pointermove', onMove);
            canvas.addEventListener('pointerup', onUp);
            canvas.addEventListener('pointercancel', onCancel);
        },

        afterDatasetsDraw(chart) {
            const brush = state.brush;
            if (!brush) return;
            const area = chart.chartArea;
            const x0 = Math.max(area.left, Math.min(brush.from, brush.to));
            const x1 = Math.min(area.right, Math.max(brush.from, brush.to));
            const ctx = chart.ctx;
            ctx.save();
            ctx.fillStyle = tint(th.accent, 0.14);
            ctx.fillRect(x0, area.top, Math.max(1, x1 - x0), area.bottom - area.top);
            ctx.strokeStyle = tint(th.accent, 0.75);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x0) + 0.5, area.top);
            ctx.lineTo(Math.round(x0) + 0.5, area.bottom);
            ctx.moveTo(Math.round(x1) + 0.5, area.top);
            ctx.lineTo(Math.round(x1) + 0.5, area.bottom);
            ctx.stroke();
            ctx.restore();
        },

        afterDestroy() {
            // The canvas outlives the chart, so listeners left behind would
            // stack up one set per run and keep a dead chart alive with them.
            if (frame) {
                cancelAnimationFrame(frame);
                frame = 0;
            }
            if (!canvas) return;
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointercancel', onCancel);
            canvas.style.cursor = priorCursor;
            canvas.style.touchAction = priorTouch;
            canvas = null;
        },
    };
}

// ── Legend ──────────────────────────────────────────────────────────

/**
 * The DOM legend deck.css styles, replacing Chart.js's built-in one (which
 * is switched off in the options — leaving it on renders two legends).
 */
function buildLegend(legendEl, chart, datasets) {
    if (!legendEl) return;
    legendEl.textContent = '';
    datasets.forEach((d, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'true');
        btn.title = `Hide or show ${d.label}`;

        const key = document.createElement('span');
        key.className = d.dash ? 'key dashed' : 'key';
        // .key.dashed reads var(--c) with NO fallback, so the inline custom
        // property is not decoration — without it the swatch is invisible.
        key.style.setProperty('--c', d.color || 'var(--accent)');

        btn.appendChild(key);
        btn.appendChild(document.createTextNode(d.label));
        btn.addEventListener('click', () => {
            if (!chart.canvas) return; // the chart was destroyed under a stale button
            const showing = chart.isDatasetVisible(i);
            chart.setDatasetVisibility(i, !showing);
            btn.classList.toggle('off', showing);
            btn.setAttribute('aria-pressed', String(!showing));
            chart.update();
        });
        legendEl.appendChild(btn);
    });
}

// ── Renderers ───────────────────────────────────────────────────────

function build(canvas, legendEl, spec, opts) {
    requireChart();
    if (!canvas) throw new Error('No canvas to draw the chart on.');

    const th = deckChartTheme();
    const fmt = typeof spec.valueFormat === 'function' ? spec.valueFormat : DEFAULT_FORMAT;
    const labels = spec.labels || [];
    const incoming = spec.datasets || [];

    // Log mode is only honoured if something is left to plot on it. A window
    // where every series is still at zero would otherwise render an empty
    // canvas with no hint as to why.
    let logScale = !!spec.logScale;
    if (logScale) {
        const anyPositive = incoming.some(d => (d.data || []).some(v => Number.isFinite(v) && v > 0));
        if (!anyPositive) logScale = false;
    }

    // Chart.js keys its registry on the canvas element, so constructing over
    // a live instance throws "Canvas is already in use" — and a caller that
    // forgets to destroy leaks the old chart's tooltips and hover handlers.
    const existing = Chart.getChart ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();

    const state = {
        // logScale is the EFFECTIVE setting, not the requested one, so a
        // caller whose toggle button says "Log" can tell when the fallback
        // above quietly kept the axis linear.
        logScale,
        drawdown: opts.allowDrawdown ? (spec.drawdown || null) : null,
        onBrush: opts.allowBrush && typeof spec.onBrush === 'function' ? spec.onBrush : null,
        brush: null,
    };

    const datasets = incoming.map(d => {
        const stroke = resolveColor(d.color, th.accent);
        return {
            label: d.label,
            data: cleanData(d.data, logScale),
            borderColor: stroke,
            // fill: 'start' rather than 'origin' — on a log axis the origin is
            // not a point that exists, and on a linear one the two are visually
            // identical once the fill is clipped to the plot area.
            backgroundColor: tint(stroke, 0.12),
            fill: d.fill ? 'start' : false,
            borderWidth: Number.isFinite(d.width) ? d.width : 2,
            borderDash: d.dash || undefined,
            stepped: !!d.stepped,
            tension: d.stepped ? 0 : 0.05,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHoverBorderWidth: 0,
            pointHoverBackgroundColor: stroke,
            spanGaps: false,
        };
    });

    const first = !HAS_DRAWN.has(canvas);
    HAS_DRAWN.add(canvas);
    const animation = first && !prefersReducedMotion()
        ? { duration: 620, easing: 'easeOutQuart' }
        : false;

    const plugins = [crosshairPlugin(th)];
    if (opts.allowDrawdown) plugins.unshift(drawdownBandPlugin(th, state));
    if (state.onBrush) plugins.push(brushZoomPlugin(th, state));

    const chart = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        plugins,
        options: {
            responsive: true,
            // The markup dropped the old height attribute and .chart-wrap sets
            // no height either, so without an explicit ratio the canvas sizes
            // unpredictably on first paint.
            maintainAspectRatio: true,
            aspectRatio: 2.6,
            animation,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false }, // replaced by the DOM legend above
                tooltip: {
                    backgroundColor: th.tooltipBg,
                    borderColor: th.border,
                    borderWidth: 1,
                    titleColor: th.text,
                    bodyColor: th.muted,
                    titleFont: { size: 11.5, weight: '600' },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 8,
                    boxWidth: 8,
                    boxHeight: 8,
                    boxPadding: 4,
                    usePointStyle: true,
                    caretSize: 5,
                    displayColors: true,
                    callbacks: {
                        label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}`,
                    },
                },
            },
            scales: baseScales(th, logScale, fmt),
        },
    });

    // Exposed so a caller can flip the drawdown band without a full rebuild:
    // chart.deckState.drawdown = null; chart.update();
    chart.deckState = state;

    // A canvas is opaque to a screen reader. Say what it holds rather than
    // leaving an unlabelled graphic in the middle of the results.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', describe(labels, incoming));

    buildLegend(legendEl, chart, incoming);
    return chart;
}

function describe(labels, datasets) {
    const names = datasets.map(d => d.label).join(', ');
    if (!labels.length) return `Chart of ${names}.`;
    return `Chart of ${names}, ${labels[0]} to ${labels[labels.length - 1]}.`;
}

/** The backtest growth chart: drawdown band and drag-to-zoom both live. */
export function renderGrowthChart(canvas, legendEl, spec) {
    return build(canvas, legendEl, spec, { allowDrawdown: true, allowBrush: true });
}

/** The duel wealth chart: same shape, no drawdown band and no brush. */
export function renderDuelChart(canvas, legendEl, spec) {
    return build(canvas, legendEl, spec, { allowDrawdown: false, allowBrush: false });
}

/** Null-safe teardown — safe to call twice, and on a chart that never built. */
export function destroy(chart) {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
}
