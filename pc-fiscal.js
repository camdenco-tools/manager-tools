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
 * ⚠️ KEY COLLISION — known limitation of the .key field:
 *   Because period.key = period.start.slice(0,7), and a 5-week fiscal
 *   period often starts at the end of the prior calendar month, many
 *   periods share a key with one of their neighbors. This is NOT a
 *   Nov/Dec-only issue — it happens in every quarter where a 5-week
 *   period straddles a month boundary.
 *
 *   Concrete examples across the defined years:
 *     - CY2026: 3 colliding pairs (Jun/Jul, Aug/Sep, Nov/Dec)
 *     - CY2027: 3 colliding pairs (May/Jun, Aug/Sep, Nov/Dec)
 *     - CY2028: 4 colliding pairs (Jan/Feb, May/Jun, Jul/Aug, Oct/Nov)
 *     - CY2029: 4 colliding pairs (Jan/Feb, Apr/May, Jul/Aug, Oct/Nov)
 *     - CY2030: 2 colliding pairs (Apr/May, Jul/Aug)
 *
 *   Production data in eom_snapshots, eom_payroll, and eom_manual_entries
 *   has been written under this collision since the cos-labor page
 *   launched. The collision is preserved here for compatibility —
 *   getPeriodByKey() returns the first match it finds, which in practice
 *   means the earlier of the two colliding periods.
 *
 *   PRACTICAL IMPACT:
 *   - Callers that use the FULL period object (resolvePeriod, getCurrentPeriod,
 *     getPriorPeriod with an object input, etc.) are NOT affected — they
 *     work off period.start which is always unique.
 *   - Callers that pass around the 'YYYY-MM' key string and later try to
 *     map it back to a specific period can land on the wrong period. The
 *     existing eom_* tables in production are exactly this situation:
 *     two real fiscal periods can both write rows under the same
 *     fiscal_period value.
 *
 *   WORKAROUNDS for callers that need to disambiguate:
 *   - Use getPeriodByName('November 2026') / 'December 2026' (always unique)
 *   - Use the period.start ISO string (always unique)
 *   - Use getPeriods()[index] when the index is known
 *
 *   getPriorPeriod / getNextPeriod accept the period OBJECT as their
 *   primary input and walk by array position, so they are immune to
 *   the collision when given the object directly.
 *
 *   A proper fix would mean changing the key scheme (e.g., using the
 *   period's full start ISO date instead of just year-month). That's
 *   tracked as a follow-up and would require a data migration on the
 *   eom_* tables. Not done here because the impact is limited and a
 *   migration is non-trivial.
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
 * CY2027+ FOLLOWS STANDARD NRF 4-4-5:
 *   - CY2027: 52 weeks, standard 4-4-5 quarters
 *   - CY2028: 52 weeks, standard 4-4-5 quarters
 *   - CY2029: 52 weeks, standard 4-4-5 quarters
 *   - CY2030: 53 WEEKS — the 53rd week lands in December, making
 *     Q4 = 4-4-6 instead of 4-4-5. This is the standard NRF retail
 *     calendar "leap week" used to re-anchor the fiscal year to a
 *     January start. Without this extra week, by CY2032 the year
 *     would start mid-December, 9+ days drifted from the original
 *     anchor. The 53rd week brings CY2031 back to a Mon Jan 6, 2031
 *     start.
 *
 *   Note: January 2030 starts Mon Dec 31, 2029 — this is normal for
 *   the year preceding a 53-week year and is NOT a bug. The fiscal
 *   year label ("2030") follows the period's start MONTH, not its
 *   calendar year. resolvePeriod('2029-12-31') correctly returns the
 *   "January 2030" period.
 *
 * EXTENDING TO 2031+:
 *   CY2031 starts Mon Jan 6, 2031 (chains from CY2030's 53-week end
 *   on Sun Jan 5, 2031). Continue with standard 4-4-5 years until
 *   drift accumulates again — the next 53-week year will likely be
 *   CY2036 or CY2037. Recompute drift before encoding that far out.
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

  /* CY2028 — standard 4-4-5, 52 weeks. Starts Mon Jan 3, 2028. */
  var FISCAL_PERIODS_2028 = [
    { name: 'January 2028',   start: '2028-01-03', end: '2028-01-30', weeks: 4 },
    { name: 'February 2028',  start: '2028-01-31', end: '2028-02-27', weeks: 4 },
    { name: 'March 2028',     start: '2028-02-28', end: '2028-04-02', weeks: 5 },
    { name: 'April 2028',     start: '2028-04-03', end: '2028-04-30', weeks: 4 },
    { name: 'May 2028',       start: '2028-05-01', end: '2028-05-28', weeks: 4 },
    { name: 'June 2028',      start: '2028-05-29', end: '2028-07-02', weeks: 5 },
    { name: 'July 2028',      start: '2028-07-03', end: '2028-07-30', weeks: 4 },
    { name: 'August 2028',    start: '2028-07-31', end: '2028-08-27', weeks: 4 },
    { name: 'September 2028', start: '2028-08-28', end: '2028-10-01', weeks: 5 },
    { name: 'October 2028',   start: '2028-10-02', end: '2028-10-29', weeks: 4 },
    { name: 'November 2028',  start: '2028-10-30', end: '2028-11-26', weeks: 4 },
    { name: 'December 2028',  start: '2028-11-27', end: '2028-12-31', weeks: 5 }
  ];

  /* CY2029 — standard 4-4-5, 52 weeks. Starts Mon Jan 1, 2029.
     January 1 happens to be a Monday this year — no Dec-start needed. */
  var FISCAL_PERIODS_2029 = [
    { name: 'January 2029',   start: '2029-01-01', end: '2029-01-28', weeks: 4 },
    { name: 'February 2029',  start: '2029-01-29', end: '2029-02-25', weeks: 4 },
    { name: 'March 2029',     start: '2029-02-26', end: '2029-04-01', weeks: 5 },
    { name: 'April 2029',     start: '2029-04-02', end: '2029-04-29', weeks: 4 },
    { name: 'May 2029',       start: '2029-04-30', end: '2029-05-27', weeks: 4 },
    { name: 'June 2029',      start: '2029-05-28', end: '2029-07-01', weeks: 5 },
    { name: 'July 2029',      start: '2029-07-02', end: '2029-07-29', weeks: 4 },
    { name: 'August 2029',    start: '2029-07-30', end: '2029-08-26', weeks: 4 },
    { name: 'September 2029', start: '2029-08-27', end: '2029-09-30', weeks: 5 },
    { name: 'October 2029',   start: '2029-10-01', end: '2029-10-28', weeks: 4 },
    { name: 'November 2029',  start: '2029-10-29', end: '2029-11-25', weeks: 4 },
    { name: 'December 2029',  start: '2029-11-26', end: '2029-12-30', weeks: 5 }
  ];

  /* CY2030 — 53-WEEK LEAP YEAR. The 53rd week lands in December,
     making it a 6-week period and Q4 = 4-4-6 (14 weeks) for this year
     only. This is the standard NRF retail-calendar correction to keep
     the fiscal year anchored to early January.

     IMPORTANT: January 2030 starts Mon Dec 31, 2029 — NOT in January
     of calendar year 2030. This is intentional and normal for the year
     preceding a 53-week correction. The period name follows the start
     MONTH convention; resolvePeriod('2029-12-31') correctly returns
     the "January 2030" period.

     After CY2030's 53rd week, CY2031 starts cleanly on Mon Jan 6, 2031. */
  var FISCAL_PERIODS_2030 = [
    { name: 'January 2030',   start: '2029-12-31', end: '2030-01-27', weeks: 4 },
    { name: 'February 2030',  start: '2030-01-28', end: '2030-02-24', weeks: 4 },
    { name: 'March 2030',     start: '2030-02-25', end: '2030-03-31', weeks: 5 },
    { name: 'April 2030',     start: '2030-04-01', end: '2030-04-28', weeks: 4 },
    { name: 'May 2030',       start: '2030-04-29', end: '2030-05-26', weeks: 4 },
    { name: 'June 2030',      start: '2030-05-27', end: '2030-06-30', weeks: 5 },
    { name: 'July 2030',      start: '2030-07-01', end: '2030-07-28', weeks: 4 },
    { name: 'August 2030',    start: '2030-07-29', end: '2030-08-25', weeks: 4 },
    { name: 'September 2030', start: '2030-08-26', end: '2030-09-29', weeks: 5 },
    { name: 'October 2030',   start: '2030-09-30', end: '2030-10-27', weeks: 4 },
    { name: 'November 2030',  start: '2030-10-28', end: '2030-11-24', weeks: 4 },
    { name: 'December 2030',  start: '2030-11-25', end: '2031-01-05', weeks: 6 }
  ];

  /* Master array — concat of all defined years in chronological order. */
  var ALL_PERIODS = FISCAL_PERIODS_2026
    .concat(FISCAL_PERIODS_2027)
    .concat(FISCAL_PERIODS_2028)
    .concat(FISCAL_PERIODS_2029)
    .concat(FISCAL_PERIODS_2030);

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
     across the schema). Returns the FIRST match — be careful, key
     collisions are widespread because 5-week fiscal periods often
     straddle a month boundary. See the file header for the full list
     of colliding pairs by year. Use getPeriodByName() when you need to
     disambiguate. Returns null on miss. */
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
