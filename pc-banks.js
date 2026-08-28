/*
 * pc-banks.js — Popcorn Chez Manager Toolkit shared bank account catalog
 *
 * Loaded by pages AFTER /pc-auth.js. Provides read-only access to the
 * `bank_accounts` catalog table (seeded Aug 27, 2026 — Session 6).
 *
 * Sibling of pc-roles.js and pc-catalog.js. PURE READ LAYER — it never
 * writes. Pages that edit bank_accounts (the /bank-accounts/ admin page)
 * issue their own fetch() writes and then call pcBanks.refresh().
 *
 * Usage:
 *   <script src="/pc-auth.js"></script>
 *   <script src="/pc-banks.js"></script>
 *   ...
 *   pcAuth.require({ pageSlug: '...', onReady: function (user) {
 *     pcBanks.ready().then(function () {
 *       var all  = pcBanks.getAccounts();                  // active, sorted
 *       var chk  = pcBanks.getAccounts({ type: 'checking' });
 *       var op   = pcBanks.getByCode('wf_operating');
 *       var acct = pcBanks.getByLast4('2927');             // statement routing
 *       var acc2 = pcBanks.getByAccountNumber('000009891393994');
 *       var ser  = pcBanks.checkSeriesFor('wf_operating'); // [{min,max}, ...]
 *     });
 *   }});
 *
 * Three consumers as of Session 7: the Check Writer account picker, the
 * bank-review upload picker, and the statement parser (which needs
 * getByLast4 / getByAccountNumber to split the Wells Fargo combined PDF
 * across three accounts).
 *
 * Reference (ground truth as of 2026-08-27) — nine accounts:
 *   wf_operating 2927 | wf_payroll 2935 | wf_de_bluecoats 6959 |
 *   wf_business 5725  | wf_signify_card 9825 (credit_card) |
 *   mt_cash 3978 | mt_satb_operating 3986 | mt_pr_reserve 3994 |
 *   mt_holding 7754 (savings)
 */
(function () {
  'use strict';

  var SB_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var REST = SB_URL + '/rest/v1/';

  // ---------------------------------------------------------------------
  // Cache — populated once per page session by the first ready() call.
  // ---------------------------------------------------------------------
  var _accounts = null;       // [{ id, code, bank, label, account_type,
                              //    account_number, last4, alt_last4,
                              //    is_active, opened_at, closed_at, notes,
                              //    sort_order,
                              //    check_series, display }, ...]
  var _readyPromise = null;   // the in-flight or settled load promise

  // ---------------------------------------------------------------------
  // Internal: one authenticated GET against PostgREST.
  // ---------------------------------------------------------------------
  function sbGet(path) {
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) {
      return Promise.reject(new Error('pc-banks.js: pc-auth.js must load first'));
    }
    return fetch(REST + path, { headers: pcAuth.headers() }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('pc-banks.js HTTP ' + r.status + ' on ' + path +
            (t ? ' -- ' + t.slice(0, 200) : ''));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  // ---------------------------------------------------------------------
  // Internal: digits only, leading zeros stripped.
  //
  // M&T prints account numbers left-padded for display — 000009891393994
  // is the 10-digit account 9891393994. The padding is NOT fixed width
  // across product types: the savings account is genuinely 14 digits
  // (15004241507754), so we normalise both sides of every comparison
  // rather than assuming a length.
  // ---------------------------------------------------------------------
  function normNumber(v) {
    if (v == null) return '';
    var digits = String(v).replace(/[^0-9]/g, '');
    digits = digits.replace(/^0+/, '');
    return digits;
  }

  // ---------------------------------------------------------------------
  // Internal: last-4 normaliser. Accepts '2927', 2927, 'xxxxxx2927',
  // 'Xxxxxxxxxxxx9825' — statement text is inconsistent about masking.
  // ---------------------------------------------------------------------
  function normLast4(v) {
    if (v == null) return '';
    var digits = String(v).replace(/[^0-9]/g, '');
    if (digits.length < 4) return '';
    return digits.slice(-4);
  }

  // ---------------------------------------------------------------------
  // Internal: fetch and normalise into the cache shape.
  //
  // Soft-deleted rows are excluded at the query, not client-side, so a
  // deleted account can never reach a picker or a routing lookup.
  // ---------------------------------------------------------------------
  function loadAll() {
    return sbGet(
      'bank_accounts?select=id,code,bank,label,account_type,account_number,' +
      'last4,alt_last4,is_active,opened_at,closed_at,notes,sort_order,check_series' +
      '&deleted_at=is.null&order=sort_order.asc,code.asc'
    ).then(function (rows) {
      _accounts = (rows || []).map(function (a) {
        var alt = [];
        if (Object.prototype.toString.call(a.alt_last4) === '[object Array]') {
          alt = a.alt_last4.map(normLast4).filter(function (s) { return s !== ''; });
        }

        var series = [];
        if (Object.prototype.toString.call(a.check_series) === '[object Array]') {
          series = a.check_series
            .map(function (r) {
              return { min: Number(r.min), max: Number(r.max) };
            })
            .filter(function (r) {
              return isFinite(r.min) && isFinite(r.max) && r.max >= r.min;
            })
            .sort(function (x, y) { return x.min - y.min; });
        }

        var last4 = normLast4(a.last4);

        return {
          id: a.id,
          code: a.code,
          bank: a.bank,
          label: a.label,
          account_type: a.account_type,
          account_number: a.account_number || null,
          last4: last4,
          alt_last4: alt,
          is_active: a.is_active !== false,
          opened_at: a.opened_at || null,
          closed_at: a.closed_at || null,
          notes: a.notes || null,
          sort_order: typeof a.sort_order === 'number' ? a.sort_order : 9999,
          check_series: series,

          // Two accounts are both labelled "Operating" (wf_operating and
          // mt_satb_operating). Never render `label` alone in a picker.
          display: a.bank + ' ' + a.label + ' \u00b7\u00b7' + last4
        };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  var pcBanks = {

    /*
     * ready() — kicks off (or returns the in-flight) catalog load.
     * Resolves once the cache is populated. Safe to call repeatedly;
     * the fetch only happens once per page session.
     */
    ready: function () {
      if (!_readyPromise) {
        _readyPromise = loadAll().catch(function (e) {
          // Let the next ready() call retry rather than caching a failure.
          _readyPromise = null;
          throw e;
        });
      }
      return _readyPromise;
    },

    /*
     * refresh() — drops the cache and reloads. Call this after writing
     * to bank_accounts so subsequent getter calls see fresh data.
     * Returns the new ready() promise.
     */
    refresh: function () {
      _accounts = null;
      _readyPromise = null;
      return pcBanks.ready();
    },

    /*
     * getAccounts({ includeClosed, type }) — the account catalog, sorted
     * by sort_order. Active-only by default.
     *
     *   type — optional filter: 'checking' | 'savings' | 'credit_card'.
     *          The Check Writer picker uses { type: 'checking' }.
     */
    getAccounts: function (opts) {
      _assertReady('getAccounts');
      var includeClosed = opts && opts.includeClosed;
      var type = opts && opts.type;
      return _accounts
        .filter(function (a) {
          if (!includeClosed && !a.is_active) return false;
          if (type && a.account_type !== type) return false;
          return true;
        })
        .slice();
    },

    /*
     * getByCode(code) — single account by its stable business key, or
     * null. Returns closed accounts too; callers decide what to do with
     * is_active. (A closed account still owns its historical rows.)
     */
    getByCode: function (code) {
      _assertReady('getByCode');
      for (var i = 0; i < _accounts.length; i++) {
        if (_accounts[i].code === code) return _accounts[i];
      }
      return null;
    },

    /*
     * getByLast4(value, { includeClosed }) — routing lookup for statement
     * ingestion. Matches on last4 first, then alt_last4 (reissued cards
     * and card subaccounts). Accepts masked forms: 'xxxxxx2927' works.
     *
     * Active accounts only by default — routing a statement line into a
     * closed account is almost always a mis-parse.
     *
     * THROWS on ambiguity. Two accounts sharing a last-4 means the parser
     * cannot know which one a line belongs to, and silently picking one
     * poisons every row in the batch. No collisions exist today across
     * the nine accounts; this guards a future card reissue that lands on
     * an already-used last-4.
     *
     * Returns null when nothing matches — the caller should treat that as
     * "route this by hand", not as a reason to guess.
     */
    getByLast4: function (value, opts) {
      _assertReady('getByLast4');
      var want = normLast4(value);
      if (!want) return null;
      var includeClosed = opts && opts.includeClosed;

      var hits = _accounts.filter(function (a) {
        if (!includeClosed && !a.is_active) return false;
        if (a.last4 === want) return true;
        return a.alt_last4.indexOf(want) !== -1;
      });

      if (hits.length === 0) return null;
      if (hits.length > 1) {
        throw new Error('pc-banks.js: last4 "' + want + '" matches ' +
          hits.length + ' accounts (' +
          hits.map(function (a) { return a.code; }).join(', ') +
          ') -- cannot route unambiguously');
      }
      return hits[0];
    },

    /*
     * getByAccountNumber(value, { includeClosed }) — the preferred routing
     * lookup where the statement prints a full account number, which both
     * the Wells Fargo combined statement and every M&T statement do.
     * Stronger than last-4 because it cannot collide.
     *
     * Leading zeros and any punctuation are stripped from both sides, so
     * '000009891393994' matches the stored '9891393994'.
     *
     * Falls back to nothing — returns null if unmatched. Callers routing a
     * combined statement should try this first and only then getByLast4.
     */
    getByAccountNumber: function (value, opts) {
      _assertReady('getByAccountNumber');
      var want = normNumber(value);
      if (!want) return null;
      var includeClosed = opts && opts.includeClosed;

      for (var i = 0; i < _accounts.length; i++) {
        var a = _accounts[i];
        if (!includeClosed && !a.is_active) continue;
        if (a.account_number && normNumber(a.account_number) === want) return a;
      }
      return null;
    },

    /*
     * checkSeriesFor(code) — the check-number ranges for an account, as
     * [{ min, max }, ...] sorted ascending. Empty array means the account
     * has no check stock (six of the nine).
     *
     * JSONB rather than a min/max pair because wf_operating has two
     * disjoint ranges: 1-1999 (retired handwritten stock) and 2701-3700
     * (CheckOMatic). A single pair cannot express that.
     */
    checkSeriesFor: function (code) {
      _assertReady('checkSeriesFor');
      var acct = pcBanks.getByCode(code);
      return acct ? acct.check_series.slice() : [];
    },

    /*
     * isCheckNumberInSeries(code, number) — true if the number falls in
     * one of the account's ranges. Returns null (not false) when the
     * account has no ranges defined or the number isn't numeric, so a
     * caller can tell "outside the range" from "no rule to check against".
     *
     * The Check Writer treats a false as a SOFT warning, never a block:
     * the physical stock carries the pre-printed account number, so the
     * paper is the source of truth about which account a check draws on.
     */
    isCheckNumberInSeries: function (code, number) {
      _assertReady('isCheckNumberInSeries');
      var series = pcBanks.checkSeriesFor(code);
      if (!series.length) return null;

      var n = Number(String(number == null ? '' : number).replace(/[^0-9]/g, ''));
      if (!isFinite(n) || n <= 0) return null;

      for (var i = 0; i < series.length; i++) {
        if (n >= series[i].min && n <= series[i].max) return true;
      }
      return false;
    },

    /*
     * accountFor(number) — reverse lookup: which account does this check
     * number belong to, by series. Returns the account or null.
     *
     * This is the runtime twin of the Session 6 CASE-statement backfill.
     * It is only sound while the ranges stay non-overlapping, which is
     * what shredding the M&T stock numbered 2701+ guarantees. If a number
     * ever matches two accounts it throws rather than guessing.
     */
    accountFor: function (number) {
      _assertReady('accountFor');
      var n = Number(String(number == null ? '' : number).replace(/[^0-9]/g, ''));
      if (!isFinite(n) || n <= 0) return null;

      var hits = _accounts.filter(function (a) {
        for (var i = 0; i < a.check_series.length; i++) {
          if (n >= a.check_series[i].min && n <= a.check_series[i].max) return true;
        }
        return false;
      });

      if (hits.length === 0) return null;
      if (hits.length > 1) {
        throw new Error('pc-banks.js: check number ' + n + ' falls in ' +
          hits.length + ' account series (' +
          hits.map(function (a) { return a.code; }).join(', ') +
          ') -- ranges overlap');
      }
      return hits[0];
    }
  };

  // ---------------------------------------------------------------------
  // Internal: guard so getters fail loudly if called before ready().
  // ---------------------------------------------------------------------
  function _assertReady(fnName) {
    if (_accounts === null) {
      throw new Error('pc-banks.js: pcBanks.' + fnName +
        '() called before pcBanks.ready() resolved');
    }
  }

  // Expose globally, matching pcAuth / pcNav / pcRoles convention.
  window.pcBanks = pcBanks;

})();
