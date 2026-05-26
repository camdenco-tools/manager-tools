/* ============================================================================
 * pc-fiscal.js — Popcorn Chez 4-4-5 retail fiscal calendar (shared module)
 *
 * Single source of truth for fiscal period lookups across the toolkit.
 * Loaded by any page that needs to convert calendar dates into fiscal
 * periods or surface period-level start/end/week boundaries.
 *
 * USAGE:
 *   <script src="/pc-fiscal.js"></script>
 *   var period = pcFiscal.resolvePeriod('2026-05-15');   // → period object
 *   var current = pcFiscal.getCurrentPeriod();            // → today's period
 *   var prior = pcFiscal.getPriorPeriod(current);         // → period before
 *   var weeks = pcFiscal.getWeekRanges(period);           // → array of {start,end,label}
 *
 * NO DEPENDENCIES. Sync data — no DB call, no async ready. The fiscal
 * calendar is static config and is small enough to inline.
 *
 * GRACEFUL DEGRADATION:
 * - resolvePeriod() returns null for any date outside the defined range.
 *   This is deliberate. Pages should disable fiscal chips/displays when
 *   null is returned, NOT fall back to the closest period (silent
 *   wrong-answer territory).
 * - Two real cases the null return protects:
 *   1. Year-end gap (Jan 1–4 of a year before that year's first period)
 *   2. Future dates beyond the last defined year
 *
 * EXISTING CALLER PATTERNS this module supports:
 * - cos-labor's   FISCAL_PERIODS array          → pcFiscal.getPeriods()
 * - cos-labor's   findCurrentPeriod() (index)   → pcFiscal.getCurrentPeriodIndex()
 * - cos-labor's   getPeriodKey(period) → 'YYYY-MM' → period.key (precomputed)
 * - cos-labor's   getWeekRanges(period)         → pcFiscal.getWeekRanges(period)
 * - cos-labor's   getPriorPeriod(idx)           → pcFiscal.getPriorPeriod(period)
 * - sales-history's resolveFiscalPeriod(iso)    → pcFiscal.resolvePeriod(iso)
 *
 * ⚠️ KEY COLLISION — known bug carried forward from cos-labor:
 *   Because period.key = period.start.slice(0,7), the November and
 *   December periods of any given fiscal year share the same key:
 *     - November 2026 starts 2026-11-02 → key '2026-11'
 *     - December 2026 starts 2026-11-30 → key '2026-11' (same!)
 *     - November 2027 starts 2027-11-01 → key '2027-11'
 *     - December 2027 starts 2027-11-29 → key '2027-11' (same!)
 *
 *   Production data in eom_snapshots, eom_payroll, eom_manual_entries
 *   has been written under this collision for months. Fixing the
 *   keying scheme would orphan existing rows. The collision is
 *   preserved here for compatibility — getPeriodByKey() returns the
 *   first match (November), which matches what cos-labor's UI does.
 *
 *   Workarounds for callers that need to disambiguate:
 *   - Use getPeriodByName('November 2026') / 'December 2026' (unique)
 *   - Use the period.start ISO string (unique)
 *   - Use getPeriods()[index] when the index is known
 *
 *   getPriorPeriod / getNextPeriod accept the period OBJECT as their
 *   primary input and walk by array position, so they are immune to
 *   the collision when given the object directly.
 *
 * KNOWN DATA NOTE — CY2026 boundaries (preserved as-shipped):
 *   The CY2026 calendar carried over from cos-labor is NOT a standard
 *   4-4-5 retail calendar. It totals 51 weeks instead of 52 and has a
 *   one-week gap from 2026-03-30 through 2026-04-05 where no fiscal
 *   period covers those dates. The 5-week periods also fall in Jul,
 *   Oct, and Dec rather than the standard Mar/Jun/Sep/Dec.
 *
 *   This array is PRESERVED VERBATIM. CY2026 eom_snapshots,
 *   eom_payroll, and eom_manual_entries rows have been written under
 *   these boundaries since the page launched. Changing them would
 *   orphan that locked data. Dates in the Mar 30–Apr 5 gap continue
 *   to resolve to null (callers handle the null gracefully — same
 *   pattern as year-end gaps).
 *
 * CY2027+ FOLLOWS STANDARD 4-4-5:
 *   Starting with CY2027, periods follow the canonical pattern: every
 *   quarter is 4-4-5 (13 weeks), every year is 52 weeks (no gaps),
 *   5-week periods fall in March, June, September, and December. This
 *   is the shape future years should be built on.
 *
 * EXTENDING TO 2028+:
 *   Use the build script at the bottom of this comment block (or copy
 *   FISCAL_PERIODS_2027 and shift all dates by 364 days). Confirm the
 *   new year starts on a Monday and ends on a Sunday. Add as
 *   FISCAL_PERIODS_2028 and concat into ALL_PERIODS. CY2028 starts
 *   Mon Jan 3, 2028.
 * ========================================================================== */

(function() {
  'use strict';

  /* CY2026 — verbatim from /cos-labor/index.html as of 2026-05-26.
     This is the source-of-truth array. Do NOT edit without coordinating
     with locked eom_snapshots, which are keyed by these period boundaries. */
  var FISCAL_PERIODS_2026 = [
    { name: 'January 2026',   start: '2026-01-05', end: '2026-02-01', weeks: 4 },
    { name: 'February 2026',  start: '2026-02-02', end: '2026-03-01', weeks: 4 },
    { name: 'March 2026',     start: '2026-03-02', end: '2026-03-29', weeks: 4 },
    { name: 'April 2026',     start: '2026-04-06', end: '2026-05-03', weeks: 4 },
    { name: 'May 2026',       start: '2026-05-04', end: '2026-05-31', weeks: 4 },
    { name: 'June 2026',      start: '2026-06-01', end: '2026-06-28', weeks: 4 },
    { name: 'July 2026',      start: '2026-06-29', end: '2026-08-02', weeks: 5 },
    { name: 'August 2026',    start: '2026-08-03', end: '2026-08-30', weeks: 4 },
    { name: 'September 2026', start: '2026-08-31', end: '2026-09-27', weeks: 4 },
    { name: 'October 2026',   start: '2026-09-28', end: '2026-11-01', weeks: 5 },
    { name: 'November 2026',  start: '2026-11-02', end: '2026-11-29', weeks: 4 },
    { name: 'December 2026',  start: '2026-11-30', end: '2027-01-03', weeks: 5 }
  ];

  /* CY2027 — standard 4-4-5 retail calendar.
     Every quarter is 4-4-5 (13 weeks), year totals 52 weeks (364 days),
     every period starts Monday and ends Sunday, no gaps.
     This is the corrected shape — CY2026 above does NOT follow standard
     4-4-5 (it's missing a week between Mar and Apr, and has 5-week
     periods in Jul/Oct/Dec instead of Mar/Jun/Sep/Dec). CY2026 is left
     as-is to preserve locked eom_snapshots. From CY2027 forward, all
     years follow the canonical 4-4-5 pattern.

     Year starts Mon Jan 4, 2027 (the Monday after CY2026's
     Sun Jan 3, 2027 end date) and ends Sun Jan 2, 2028. */
  var FISCAL_PERIODS_2027 = [
    { name: 'January 2027',   start: '2027-01-04', end: '2027-01-31', weeks: 4 },
    { name: 'February 2027',  start: '2027-02-01', end: '2027-02-28', weeks: 4 },
    { name: 'March 2027',     start: '2027-03-01', end: '2027-04-04', weeks: 5 },
    { name: 'April 2027',     start: '2027-04-05', end: '2027-05-02', weeks: 4 },
    { name: 'May 2027',       start: '2027-05-03', end: '2027-05-30', weeks: 4 },
    { name: 'June 2027',      start: '2027-05-31', end: '2027-07-04', weeks: 5 },
    { name: 'July 2027',      start: '2027-07-05', end: '2027-08-01', weeks: 4 },
    { name: 'August 2027',    start: '2027-08-02', end: '2027-08-29', weeks: 4 },
    { name: 'September 2027', start: '2027-08-30', end: '2027-10-03', weeks: 5 },
    { name: 'October 2027',   start: '2027-10-04', end: '2027-10-31', weeks: 4 },
    { name: 'November 2027',  start: '2027-11-01', end: '2027-11-28', weeks: 4 },
    { name: 'December 2027',  start: '2027-11-29', end: '2028-01-02', weeks: 5 }
  ];

  /* Master array — concat of all defined years in chronological order. */
  var ALL_PERIODS = FISCAL_PERIODS_2026.concat(FISCAL_PERIODS_2027);

  /* Precompute the 'YYYY-MM' key used as fiscal_period across the schema
     (eom_snapshots.fiscal_period, eom_payroll.fiscal_period, etc.).
     Matches cos-labor's getPeriodKey(period) = period.start.slice(0,7). */
  ALL_PERIODS.forEach(function(p) { p.key = p.start.slice(0, 7); });

  /* ---------- helpers ---------- */

  function todayIso() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function isoToParts(iso) {
    // 'YYYY-MM-DD' → numeric Y/M/D, no timezone gotchas
    var parts = iso.split('-');
    return { y: parseInt(parts[0], 10), m: parseInt(parts[1], 10), d: parseInt(parts[2], 10) };
  }

  function isoCompare(a, b) {
    // String compare works on ISO dates as long as they're zero-padded.
    // Both our period boundaries and all caller inputs are 'YYYY-MM-DD'.
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function formatMd(iso) {
    var p = isoToParts(iso);
    return p.m + '/' + p.d;
  }

  /* ---------- public API ---------- */

  /* Returns the full periods array. Read-only by convention — do not
     mutate the returned reference; the precomputed .key field would be
     out of sync if start dates were changed. */
  function getPeriods() {
    return ALL_PERIODS;
  }

  /* Given an ISO date 'YYYY-MM-DD', return the fiscal period that
     contains it, or null if the date falls outside the defined range.
     Null return is deliberate — see file header. */
  function resolvePeriod(isoDate) {
    if (!isoDate) return null;
    for (var i = 0; i < ALL_PERIODS.length; i++) {
      var p = ALL_PERIODS[i];
      if (isoCompare(isoDate, p.start) >= 0 && isoCompare(isoDate, p.end) <= 0) {
        return p;
      }
    }
    return null;
  }

  /* Returns the period containing today's date, or null if today is in
     a gap (e.g. between defined years, or in the Mar 30–Apr 5 2026 gap). */
  function getCurrentPeriod() {
    return resolvePeriod(todayIso());
  }

  /* Returns the array index of today's period, or the last period's
     index if today is past all defined periods. Mirrors cos-labor's
     findCurrentPeriod() return shape, which is a non-null index even
     when today is out of range. Use getCurrentPeriod() if you want the
     null-on-gap behavior instead. */
  function getCurrentPeriodIndex() {
    var today = todayIso();
    for (var i = 0; i < ALL_PERIODS.length; i++) {
      var p = ALL_PERIODS[i];
      if (isoCompare(today, p.start) >= 0 && isoCompare(today, p.end) <= 0) return i;
    }
    return ALL_PERIODS.length - 1;
  }

  /* Lookup by 'YYYY-MM' key (the value stored in fiscal_period columns
     across the schema). Returns the FIRST match — note that November
     and December of any year share the same key (see file header), so
     this returns November when given a 'YYYY-11' key. Returns null on
     miss. Use getPeriodByName() when you need to disambiguate. */
  function getPeriodByKey(key) {
    if (!key) return null;
    for (var i = 0; i < ALL_PERIODS.length; i++) {
      if (ALL_PERIODS[i].key === key) return ALL_PERIODS[i];
    }
    return null;
  }

  /* Lookup by .name ('January 2026', 'December 2027', etc.). Always
     unique. Returns null on miss. Use this when getPeriodByKey() could
     hit the Nov/Dec collision. */
  function getPeriodByName(name) {
    if (!name) return null;
    for (var i = 0; i < ALL_PERIODS.length; i++) {
      if (ALL_PERIODS[i].name === name) return ALL_PERIODS[i];
    }
    return null;
  }

  /* Find a period's array index. Accepts a period object (matched by
     identity OR by .start, which is always unique) or a name string.
     Returns -1 on miss. Internal helper for prior/next. */
  function indexOfPeriod(periodOrName) {
    if (!periodOrName) return -1;
    // Object input — match by .start (unique even when key collides)
    if (typeof periodOrName === 'object' && periodOrName.start) {
      for (var i = 0; i < ALL_PERIODS.length; i++) {
        if (ALL_PERIODS[i].start === periodOrName.start) return i;
      }
      return -1;
    }
    // String input — try as name first (unique), then as key (lossy)
    if (typeof periodOrName === 'string') {
      for (var j = 0; j < ALL_PERIODS.length; j++) {
        if (ALL_PERIODS[j].name === periodOrName) return j;
      }
      for (var k = 0; k < ALL_PERIODS.length; k++) {
        if (ALL_PERIODS[k].key === periodOrName) return k;
      }
    }
    return -1;
  }

  /* Given a period object, name, or key, return the period immediately
     before it. Returns null when given the first defined period or an
     unrecognized input. Object input is the most reliable — string-key
     input hits the Nov/Dec collision and may return the wrong neighbor. */
  function getPriorPeriod(periodOrName) {
    var i = indexOfPeriod(periodOrName);
    if (i <= 0) return null;
    return ALL_PERIODS[i - 1];
  }

  /* Given a period object, name, or key, return the period immediately
     after it. Returns null when given the last defined period or an
     unrecognized input. Object input is the most reliable. */
  function getNextPeriod(periodOrName) {
    var i = indexOfPeriod(periodOrName);
    if (i < 0 || i === ALL_PERIODS.length - 1) return null;
    return ALL_PERIODS[i + 1];
  }

  /* Expand a period into its constituent weeks. Returns an array of
     { start, end, label } objects, one per week. Mirrors cos-labor's
     getWeekRanges() output shape exactly so eom_payroll's
     (venue, fiscal_period, week_start) rows stay key-compatible. */
  function getWeekRanges(period) {
    if (!period) return [];
    var ranges = [];
    var start = new Date(period.start + 'T12:00:00');
    for (var w = 0; w < period.weeks; w++) {
      var ws = new Date(start);
      ws.setDate(ws.getDate() + (w * 7));
      var we = new Date(ws);
      we.setDate(we.getDate() + 6);
      var wsIso = ws.toISOString().split('T')[0];
      var weIso = we.toISOString().split('T')[0];
      ranges.push({
        start: wsIso,
        end: weIso,
        label: formatMd(wsIso) + ' - ' + formatMd(weIso)
      });
    }
    return ranges;
  }

  /* Convenience: which period contains today, expressed as 'YYYY-MM'.
     Returns null if today is in a gap. Useful for default-filtering
     queries against fiscal_period columns. */
  function getCurrentKey() {
    var p = getCurrentPeriod();
    return p ? p.key : null;
  }

  /* Diagnostic — surface the defined coverage range. Useful for "you're
     looking at a year that isn't loaded" tooltip copy. */
  function getCoverage() {
    if (ALL_PERIODS.length === 0) return { start: null, end: null };
    return {
      start: ALL_PERIODS[0].start,
      end: ALL_PERIODS[ALL_PERIODS.length - 1].end
    };
  }

  /* ---------- expose ---------- */

  window.pcFiscal = {
    getPeriods: getPeriods,
    resolvePeriod: resolvePeriod,
    getCurrentPeriod: getCurrentPeriod,
    getCurrentPeriodIndex: getCurrentPeriodIndex,
    getCurrentKey: getCurrentKey,
    getPeriodByKey: getPeriodByKey,
    getPeriodByName: getPeriodByName,
    getPriorPeriod: getPriorPeriod,
    getNextPeriod: getNextPeriod,
    getWeekRanges: getWeekRanges,
    getCoverage: getCoverage
  };
})();
