# Frozen fixtures

Reference data for the golden scenarios in `scripts/replay.mjs`.

**Do not refresh these.** They are deliberately stale. Golden scenarios record exact
numbers, so they need input that never moves; the nightly data refresh exists to move
`data/`, and pointing the goldens at it made the refresh fail every trading day.

Property tests still run against live `data/` — they assert invariants rather than values.

Regenerate with `node scripts/make-fixtures.mjs` only when deliberately re-baselining,
and re-record the goldens in the same commit.
