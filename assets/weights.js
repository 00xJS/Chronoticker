// Chronoticker allocation weight bar — the draggable strip above the holdings
// list, plus the two things everything else colours and rounds by.
//
// Pure DOM, zero imports, no build step. Three jobs:
//
//   SERIES / colorAt   one palette, so the bar, the per-holding table and the
//                      chart never disagree about which colour is which holding.
//   renderWeightBar    the strip itself: segments, the unallocated gap, and a
//                      draggable boundary between every adjacent pair.
//   normalise          integers that sum to exactly 100, so the UI never has
//                      to print 33.333% and the total chip never sits at 99%.
//
// The bar is a view of the number inputs, not a second source of truth: a drag
// reports the new weights and the controller writes them back. Everything here
// is integer arithmetic on a snapshot taken when the drag starts, so a drag can
// never invent or destroy a percentage point.

// ── Series palette ──────────────────────────────────────────────────

// deck.css declares --s1…--s8 once, with the note that the allocation bar, the
// per-holding table and the charts all colour by holding and so must agree.
// These stay as `var(--sN)` rather than resolved hexes on purpose: the print
// stylesheet re-points the tokens, and a baked-in colour would not follow it.
export const SERIES = [
    'var(--s1)',
    'var(--s2)',
    'var(--s3)',
    'var(--s4)',
    'var(--s5)',
    'var(--s6)',
    'var(--s7)',
    'var(--s8)'
];

/** The palette colour for holding `i`, cycling once there are more than eight. */
export function colorAt(i) {
    const n = Number.isFinite(i) ? Math.trunc(i) : 0;
    return SERIES[((n % SERIES.length) + SERIES.length) % SERIES.length];
}

// ── Integer apportionment ───────────────────────────────────────────

// Largest-remainder apportionment: integers summing to EXACTLY `target`.
//
// Rounding each share on its own is the defect this replaces. Three equal
// holdings become 33/33/33, the total chip goes red at 99% and the run then
// refuses over a rounding error the user never made. Floor everything, then
// hand the shortfall to the largest fractional parts.
/**
 * Integer weights for a drag, touching only the pair either side of handle i.
 *
 * The pair's sum is rounded once so the two of them stay conserved for the
 * whole gesture; every other holding is copied through exactly as it was.
 */
function pairSnapshot(weights, i) {
    const out = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
    const pair = Math.max(0, Math.round(out[i] + out[i + 1]));
    const a = Math.min(pair, Math.max(0, Math.round(out[i])));
    out[i] = a;
    out[i + 1] = pair - a;
    return out;
}

function apportion(weights, target) {
    const n = weights.length;
    if (!n) return [];
    const want = Math.max(0, Math.round(Number.isFinite(target) ? target : 0));

    let clean = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
    let sum = clean.reduce((a, b) => a + b, 0);
    // An all-zero basket has no proportions worth preserving, and "even these
    // out" must not mean dumping the whole hundred on the first row.
    if (sum <= 0) {
        clean = clean.map(() => 1);
        sum = n;
    }

    const exact = clean.map(w => (w / sum) * want);
    const out = exact.map(Math.floor);
    let short = want - out.reduce((a, b) => a + b, 0);

    // Ties go to the earlier row, so three equal holdings always give 34/33/33
    // and never shuffle which row gets the spare point between renders.
    const order = exact
        .map((v, i) => ({ i, rem: v - Math.floor(v) }))
        .sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (let k = 0; short > 0 && k < order.length; k++, short--) out[order[k].i]++;

    return out;
}

/** Integer weights summing to exactly 100 (largest remainder). */
export function normalise(weights) {
    return apportion(Array.isArray(weights) ? weights : [], 100);
}

// ── Weight bar ──────────────────────────────────────────────────────

// A floor under the label test below: narrower than this and nothing readable
// fits regardless of the symbol.
const NARROW_PX = 46;
const KEY_STEP = 1;
const KEY_STEP_SHIFT = 5;

// el → render state. Weak, so a bar that leaves the document takes its state
// (and its ResizeObserver) with it.
const BARS = new WeakMap();

/**
 * Draw the allocation strip into `el`.
 *
 * segments: [{ sym, weight }] — weight in percent, may be fractional, and the
 * total may be anything at all. opts.onResize(nextWeights) fires live during a
 * drag with integer weights in the same order; opts.onCommit(weights), if the
 * caller supplies one, fires once when a drag or a keypress finishes.
 *
 * Safe to call as often as you like, including from inside onResize.
 */
export function renderWeightBar(el, segments, opts) {
    if (!el) return;

    const list = (Array.isArray(segments) ? segments : []).map(s => ({
        sym: String(s && s.sym != null ? s.sym : ''),
        weight: s && Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 0
    }));
    const shape = list.map(s => s.sym).join('|');

    const prev = BARS.get(el);
    // Rebuilding on every call destroys the node the pointer is captured on and
    // the node that has keyboard focus. Both are fatal: the controller wires
    // onResize straight back into this function, so a rebuild ended every drag
    // after a single pointermove and every arrow keypress after one press. When
    // the holdings have not changed, update the existing nodes instead.
    if (prev && prev.shape === shape && prev.segEls.length === list.length) {
        prev.opts = opts || {};
        prev.segments = list;
        apply(prev);
        return;
    }

    teardown(el);

    const state = {
        el,
        opts: opts || {},
        segments: list,
        shape,
        segEls: [],
        handles: [],
        gap: null,
        ac: new AbortController(),
        ro: null,
        drag: null,
        weights: [],
        total: 0,
        denom: 100
    };
    BARS.set(el, state);
    build(state);
    apply(state);
}

// Every listener below is bound with this AbortController's signal, so one
// abort drops all of them however many renders have been through here.
function teardown(el) {
    const prev = BARS.get(el);
    if (prev) {
        prev.ac.abort();
        if (prev.ro) prev.ro.disconnect();
        prev.drag = null;
        BARS.delete(el);
    }
    el.replaceChildren();
}

function build(state) {
    const el = state.el;
    el.classList.add('weight-bar');

    // The markup ships aria-hidden="true" on this container, but the handles
    // below are real focusable buttons and focusable nodes inside an
    // aria-hidden subtree are an outright accessibility violation. The bar
    // announces itself as a group instead; the number inputs remain the other
    // keyboard path to the same weights.
    el.removeAttribute('aria-hidden');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Allocation weights');

    for (let i = 0; i < state.segments.length; i++) {
        const seg = document.createElement('div');
        seg.className = 'wb-seg';
        const sym = document.createElement('span');
        const pct = document.createElement('span');
        // .wb-seg.narrow > * hides ELEMENT children, so the labels have to be
        // wrapped: bare text nodes would survive the narrow class and spill.
        seg.append(sym, pct);
        el.appendChild(seg);
        state.segEls.push({ seg, sym, pct });
    }

    // Built once and inserted or removed as the total crosses 100, so it always
    // sits after the segments and before the absolutely positioned handles.
    state.gap = document.createElement('div');
    state.gap.className = 'wb-gap';

    for (let i = 0; i < state.segments.length - 1; i++) {
        const h = document.createElement('button');
        h.type = 'button';
        h.className = 'wb-handle';
        h.dataset.index = String(i);
        // A focusable separator is the ARIA widget for exactly this: a boundary
        // the user can push either way. The grip is drawn by .wb-handle::after,
        // so the button must stay empty and take its name from aria-label.
        h.setAttribute('role', 'separator');
        h.setAttribute('aria-orientation', 'vertical');
        bindHandle(state, h);
        el.appendChild(h);
        state.handles.push(h);
    }

    // The narrow threshold is a pixel measurement, so it goes stale whenever
    // the rail is resized without the weights changing.
    if (typeof ResizeObserver === 'function') {
        state.ro = new ResizeObserver(() => applyNarrow(state));
        state.ro.observe(el);
    }
}

// Push the current weights into the existing nodes. No node is created or
// destroyed here, which is what makes a mid-drag re-render harmless.
function apply(state) {
    const w = state.segments.map(s => s.weight);
    const total = w.reduce((a, b) => a + b, 0);
    // Over 100 the bases are divided by the total so the strip can never
    // overflow its 30px track; under 100 they are left alone and the hatched
    // .wb-gap shows exactly how much is still unallocated.
    const denom = Math.max(total, 100);

    state.weights = w;
    state.total = total;
    state.denom = denom;

    let acc = 0;
    for (let i = 0; i < state.segEls.length; i++) {
        const node = state.segEls[i];
        const sym = state.segments[i].sym;
        node.seg.style.setProperty('--c', colorAt(i));
        node.seg.style.flexBasis = ((w[i] / denom) * 100).toFixed(4) + '%';
        node.sym.textContent = sym;
        node.pct.textContent = fmt(w[i]) + '%';
        node.seg.title = sym + ' — ' + fmt(w[i]) + '%';

        acc += w[i];

        const h = state.handles[i];
        if (!h) continue;
        const other = state.segments[i + 1].sym;
        const pair = w[i] + w[i + 1];
        h.style.left = ((acc / denom) * 100).toFixed(4) + '%';
        h.setAttribute('aria-label', 'Weight split between ' + sym + ' and ' + other);
        h.setAttribute('aria-valuemin', '0');
        h.setAttribute('aria-valuemax', fmt(pair));
        h.setAttribute('aria-valuenow', fmt(w[i]));
        h.setAttribute('aria-valuetext', sym + ' ' + fmt(w[i]) + '%, ' + other + ' ' + fmt(w[i + 1]) + '%');
        h.title = 'Drag or use ← → to move weight between ' + sym + ' and ' + other;

        // A zero-width segment stacks its two bounding handles at the same
        // percentage with identical 13px hit rects, and the later one wins the
        // hit test — so the earlier handle became permanently unreachable by
        // pointer, in a state a drag can create by itself. The handle with
        // weight left to give is the one worth hitting, so let it take the
        // pointer and stand the buried one down. Keyboard reaches both either
        // way, since focus order is unaffected.
        const buried = w[i + 1] === 0 && i + 1 < state.handles.length;
        h.style.pointerEvents = '';
        if (buried) state.handles[i + 1].style.pointerEvents = 'none';
        else if (state.handles[i + 1]) state.handles[i + 1].style.pointerEvents = '';
    }

    const wantGap = total < 100 - 1e-9;
    if (wantGap) {
        if (!state.gap.isConnected) state.el.insertBefore(state.gap, state.handles[0] || null);
        state.gap.title = fmt(100 - total) + '% unallocated';
    } else if (state.gap.isConnected) {
        state.gap.remove();
    }

    applyNarrow(state);
}

// Ask the browser whether each label actually fits, rather than guessing from a
// pixel threshold. A fixed threshold cannot know that "GOOGL 14%" needs more
// room than "SPY 60%", and at a 340px rail an equal-weight Magnificent 7 came
// out reading "OOGL 14%" — a clipped half-symbol is worse than no symbol.
function applyNarrow(state) {
    const width = state.el.getBoundingClientRect().width;
    // Nothing is laid out yet (the panel is still hidden, say). Measuring now
    // would hide every label and there would be no second chance until the next
    // render, so leave the classes alone and let the ResizeObserver do it.
    if (width <= 0) return;

    // Unhide first, then read: a segment already carrying .narrow has
    // display:none children and would always measure as fitting. Every write
    // happens before every read, so this costs one reflow, not one per segment.
    for (let i = 0; i < state.segEls.length; i++) state.segEls[i].seg.classList.remove('narrow');
    const hide = state.segEls.map((node, i) => {
        const px = (state.weights[i] / state.denom) * width;
        return px < NARROW_PX || node.seg.scrollWidth > node.seg.clientWidth + 1;
    });
    for (let i = 0; i < state.segEls.length; i++) {
        if (hide[i]) state.segEls[i].seg.classList.add('narrow');
    }
}

// ── Dragging ────────────────────────────────────────────────────────

function bindHandle(state, h) {
    const signal = state.ac.signal;
    h.addEventListener('pointerdown', ev => onDown(state, ev), { signal });
    h.addEventListener('pointermove', ev => onMove(state, ev), { signal });
    h.addEventListener('pointerup', ev => onUp(state, ev), { signal });
    h.addEventListener('pointercancel', ev => onUp(state, ev), { signal });
    h.addEventListener('keydown', ev => onKey(state, ev), { signal });
}

function onDown(state, ev) {
    if (ev.button > 0) return;
    const rect = state.el.getBoundingClientRect();
    if (!rect.width) return;

    const h = ev.currentTarget;
    const i = Number(h.dataset.index);
    if (!Number.isInteger(i) || i + 1 >= state.weights.length) return;

    // Snapshot integers ONCE, here. Everything for the rest of the drag is
    // integer arithmetic against this snapshot, so the pair's total is
    // conserved exactly however far the pointer travels — deriving each frame
    // from the previous one accumulates rounding and leaks percentage points.
    //
    // Only the dragged PAIR is integerised. Re-apportioning the whole basket
    // on pointerdown rewrote holdings nobody touched: grabbing the handle
    // between rows 1 and 2 of [33.3, 33.3, 33.3] silently rounded row 3 too,
    // and invented a percentage point doing it. Everything outside the pair
    // passes through verbatim, so a drag's blast radius is exactly the two
    // segments either side of the handle.
    const base = pairSnapshot(state.weights, i);
    const baseTotal = base.reduce((a, b) => a + b, 0);

    state.drag = {
        i,
        base,
        pair: base[i] + base[i + 1],
        startX: ev.clientX,
        // Weight units per pixel across the whole track, so the boundary stays
        // under the cursor 1:1 instead of drifting away from it.
        perPx: Math.max(baseTotal, 100) / rect.width,
        pointerId: ev.pointerId,
        node: h,
        last: null
    };

    ev.preventDefault();
    h.classList.add('dragging');
    try { h.focus({ preventScroll: true }); } catch { /* focus is a nicety, not the drag */ }
    // The pointer leaves the 13px handle on the first frame, so without capture
    // the drag would end immediately. .weight-bar sets touch-action:none, so
    // the same path works for touch without the page scrolling underneath.
    try { h.setPointerCapture(ev.pointerId); } catch { /* older engines still track the handle */ }
}

function onMove(state, ev) {
    const d = state.drag;
    if (!d || ev.pointerId !== d.pointerId) return;

    let a = Math.round(d.base[d.i] + (ev.clientX - d.startX) * d.perPx);
    // Clamped so neither neighbour can go negative; the pair keeps its total
    // either way, so the rest of the basket never moves.
    a = Math.max(0, Math.min(d.pair, a));
    if (d.last === a) return;
    d.last = a;

    const next = d.base.slice();
    next[d.i] = a;
    next[d.i + 1] = d.pair - a;
    emit(state, next);
}

function onUp(state, ev) {
    const d = state.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    state.drag = null;
    d.node.classList.remove('dragging');
    try { d.node.releasePointerCapture(d.pointerId); } catch { /* already gone */ }
    commit(state);
}

function onKey(state, ev) {
    let dir = 0;
    if (ev.key === 'ArrowLeft') dir = -1;
    else if (ev.key === 'ArrowRight') dir = 1;
    else return;

    const i = Number(ev.currentTarget.dataset.index);
    if (!Number.isInteger(i) || i + 1 >= state.weights.length) return;
    ev.preventDefault();

    const base = pairSnapshot(state.weights, i);
    const pair = base[i] + base[i + 1];
    const step = dir * (ev.shiftKey ? KEY_STEP_SHIFT : KEY_STEP);
    const a = Math.max(0, Math.min(pair, base[i] + step));

    const next = base.slice();
    next[i] = a;
    next[i + 1] = pair - a;
    // At either end of the pair the arrow key has nothing left to move; firing
    // anyway would schedule a fresh run on every repeat of a held-down key.
    if (same(next, state.weights)) return;

    emit(state, next);
    commit(state);
}

function emit(state, next) {
    state.segments = state.segments.map((s, i) => ({ sym: s.sym, weight: next[i] }));
    // Repaint before telling the caller, so the bar tracks the cursor whether
    // or not onResize comes back through renderWeightBar.
    apply(state);
    if (typeof state.opts.onResize === 'function') state.opts.onResize(next.slice());
}

function commit(state) {
    if (typeof state.opts.onCommit === 'function') state.opts.onCommit(state.weights.slice());
}

// ── Small helpers ───────────────────────────────────────────────────

// One decimal at most, and never a trailing ".0" — a weight bar that reads
// "33.3%" while the input beside it reads "33" is a contradiction the user has
// to resolve, so fractional weights only ever arrive from a hand-edited link.
function fmt(w) {
    const r = Math.round(w * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function same(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
