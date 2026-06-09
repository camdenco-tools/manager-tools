/*
 * pc-commission.js — Popcorn Chez Manager Toolkit shared commission
 * calculation helper.
 *
 * Loaded by pages AFTER /pc-auth.js. Provides the canonical commission-
 * revenue formula: given a (venue, stand, grossSales), it applies the
 * stand's configured deal (from stand_deals) on top of the venue's deal
 * template (from deal_templates) and returns the predicted commission.
 *
 * This is the SINGLE SOURCE OF TRUTH for the deal math. It was lifted
 * verbatim from the Commission & Profitability Tracker's calcCommission()
 * so that page, the Commission Statements Receivable page, and AR Job B
 * (later) all compute identical numbers from one formula. Change a deal
 * formula here, and every consumer updates at once.
 *
 * It is a PURE READ + COMPUTE LAYER — it never writes. The Deal Structure
 * page remains the only writer of stand_deals / deal_templates. After such
 * a write, call pcCommission.refresh() to pick up the new config.
 *
 * Usage:
 *   <script src="/pc-auth.js"></script>
 *   <script src="/pc-commission.js"></script>
 *   ...
 *   pcAuth.require({ pageSlug: '...', onReady: function (user) {
 *     pcCommission.ready().then(function () {
 *       var r = pcCommission.calcCommission('Mann', 'Upper Concession', 32000);
 *       // r => { commission: 22400, dealType: 'rev_split', cosRelatable: true }
 *     });
 *   }});
 *
 * IMPORTANT: calcCommission expects CANONICAL venue + stand names — the
 * names exactly as they appear in stand_deals. Alias resolution
 * (sales.stand -> canonical, via stand_aliases / venue_aliases) is the
 * CALLER'S responsibility. This module deliberately does not touch the
 * alias tables — it is the recipe, not the pantry stocker.
 *
 * Deal defaults (verbatim from the Tracker, used when a deal_templates row
 * is missing a field):
 *   rev_split_pct 70 · bev_food_pct 91 · bev_bev_pct 9 · bev_food_cut 70
 *   bev_bev_comm 10 · labor_comm 15 · reimb_comm 5
 */
(function () {
  'use strict';

  var SB_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var REST = SB_URL + '/rest/v1/';

  // ---------------------------------------------------------------------
  // Cache — populated once per page session by the first ready() call.
  // ---------------------------------------------------------------------
  var _standDeals = null;     // { 'Venue||Stand'      : stand_deals row }
  var _dealTemplates = null;  // { 'Venue||deal_type'  : deal_templates row }
  var _readyPromise = null;

  // ---------------------------------------------------------------------
  // Internal: one authenticated GET against PostgREST.
  // ---------------------------------------------------------------------
  function sbGet(path) {
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) {
      return Promise.reject(new Error('pc-commission.js: pc-auth.js must load first'));
    }
    return fetch(REST + path, { headers: pcAuth.headers() }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('pc-commission.js HTTP ' + r.status + ' on ' + path +
            (t ? ' -- ' + t.slice(0, 200) : ''));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  // ---------------------------------------------------------------------
  // Internal: fetch both deal tables into the cache.
  //
  // Explicit limit=10000 per project SQL/REST conventions — the 100-row
  // default would silently truncate as deal config grows across venues.
  // ---------------------------------------------------------------------
  function loadAll() {
    var dealsReq = sbGet('stand_deals?select=*&limit=10000');
    var tplReq = sbGet('deal_templates?select=*&limit=10000');

    return Promise.all([dealsReq, tplReq]).then(function (results) {
      _standDeals = {};
      (results[0] || []).forEach(function (r) {
        _standDeals[r.venue + '||' + r.stand] = r;
      });
      _dealTemplates = {};
      (results[1] || []).forEach(function (r) {
        _dealTemplates[r.venue + '||' + r.deal_type] = r;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Internal: guard so getters fail loudly if called before ready().
  // ---------------------------------------------------------------------
  function _assertReady(fnName) {
    if (_standDeals === null || _dealTemplates === null) {
      throw new Error('pc-commission.js: pcCommission.' + fnName +
        '() called before pcCommission.ready() resolved');
    }
  }

  // ---------------------------------------------------------------------
  // Internal: resolve a field value with the EXACT Tracker precedence:
  //   1. stand override, when has_override is set AND the field is non-null
  //   2. else the venue deal_templates value (falsy -> default, per `||`)
  //   3. else the hard default
  // The `tpl[field] || def` semantics are preserved verbatim — a 0 in a
  // template falls through to the default exactly as the Tracker does.
  // ---------------------------------------------------------------------
  function pick(sd, tpl, overrideField, tplField, def) {
    if (sd.has_override && sd[overrideField] != null) return sd[overrideField];
    return tpl[tplField] || def;
  }

  // ---------------------------------------------------------------------
  // Internal: defensive copy so callers can't mutate the cache.
  // ---------------------------------------------------------------------
  function _clone(obj) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  var pcCommission = {

    /*
     * ready() — kicks off (or returns the in-flight) deal-config load.
     * Resolves once the cache is populated. Safe to call repeatedly.
     */
    ready: function () {
      if (!_readyPromise) {
        _readyPromise = loadAll().catch(function (e) {
          _readyPromise = null;  // let the next ready() retry rather than caching a failure
          throw e;
        });
      }
      return _readyPromise;
    },

    /*
     * refresh() — drops the cache and reloads. Call after the Deal
     * Structure page writes stand_deals / deal_templates.
     */
    refresh: function () {
      _standDeals = null;
      _dealTemplates = null;
      _readyPromise = null;
      return pcCommission.ready();
    },

    /*
     * calcCommission(venue, stand, grossSales) — the canonical formula.
     * Returns { commission, dealType, cosRelatable }.
     *
     * When the stand has no configured deal, returns
     *   { commission: 0, dealType: null, cosRelatable: false }
     * — the signal for "no deal configured / not estimable".
     *
     * Lifted verbatim from the Commission Tracker so numbers match exactly.
     */
    calcCommission: function (venue, stand, grossSales) {
      _assertReady('calcCommission');
      var gross = Number(grossSales) || 0;
      var sd = _standDeals[venue + '||' + stand];
      if (!sd) return { commission: 0, dealType: null, cosRelatable: false };

      var dt = sd.deal_type;
      var tpl = _dealTemplates[venue + '||' + dt] || {};
      var result = { dealType: dt, cosRelatable: false, commission: 0 };

      if (dt === 'rev_split') {
        var pct = pick(sd, tpl, 'override_rev_split_pct', 'rev_split_pct', 70);
        result.commission = gross * pct / 100;
        result.cosRelatable = true;
      } else if (dt === 'rev_bev') {
        var foodPct = pick(sd, tpl, 'override_bev_food_pct', 'bev_food_pct', 91);
        var bevPct  = pick(sd, tpl, 'override_bev_bev_pct',  'bev_bev_pct',  9);
        var foodCut = pick(sd, tpl, 'override_bev_food_cut', 'bev_food_cut', 70);
        var bevComm = pick(sd, tpl, 'override_bev_bev_comm', 'bev_bev_comm', 10);
        var foodSales = gross * foodPct / 100;
        var bevSales  = gross * bevPct / 100;
        result.commission = (foodSales * foodCut / 100) + (bevSales * bevComm / 100);
        result.cosRelatable = true;
      } else if (dt === 'labor') {
        var commRate = pick(sd, tpl, 'override_labor_comm', 'labor_comm', 15);
        result.commission = gross * commRate / 100;
        result.cosRelatable = false;
      } else if (dt === 'reimb') {
        var reimbComm = pick(sd, tpl, 'override_reimb_comm', 'reimb_comm', 5);
        result.commission = gross * reimbComm / 100;
        result.cosRelatable = false;
      }

      return result;
    },

    /*
     * hasDeal(venue, stand) — true if the stand has a configured deal.
     * Lets callers distinguish "configured but $0 sales" (estimable, $0)
     * from "no deal at all" (not estimable). CSR uses this.
     */
    hasDeal: function (venue, stand) {
      _assertReady('hasDeal');
      return !!_standDeals[venue + '||' + stand];
    },

    /*
     * getStandDeal(venue, stand) — the raw stand_deals row, or null.
     * Defensive copy.
     */
    getStandDeal: function (venue, stand) {
      _assertReady('getStandDeal');
      var sd = _standDeals[venue + '||' + stand];
      return sd ? _clone(sd) : null;
    },

    /*
     * getDealTemplate(venue, dealType) — the raw deal_templates row, or
     * null. Defensive copy.
     */
    getDealTemplate: function (venue, dealType) {
      _assertReady('getDealTemplate');
      var tpl = _dealTemplates[venue + '||' + dealType];
      return tpl ? _clone(tpl) : null;
    }
  };

  // Expose globally, matching pcAuth / pcNav / pcCatalog / pcFiscal convention.
  window.pcCommission = pcCommission;

})();
