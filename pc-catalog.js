/*
 * pc-catalog.js — Popcorn Chez Manager Toolkit shared stand & venue
 * catalog helper.
 *
 * Loaded by pages AFTER /pc-auth.js. Provides read-only access to the
 * `venues` and `stands` catalog tables. Replaces the hardcoded
 * VENUE_STANDS / VENUE_LABELS / TIERED_VENUES JavaScript objects that
 * historically lived at the top of every page.
 *
 * This is the stands-side sibling of pc-roles.js (Phase -2 role catalog
 * helper). It is a PURE READ LAYER — it never writes. Pages that edit
 * venues or stands (the /stand-setup/ admin page) issue their own fetch()
 * writes and then call pcCatalog.refresh() to invalidate the cache.
 *
 * Usage:
 *   <script src="/pc-auth.js"></script>
 *   <script src="/pc-catalog.js"></script>
 *   ...
 *   pcAuth.require({ pageSlug: '...', onReady: function (user) {
 *     pcCatalog.ready().then(function () {
 *       var venues       = pcCatalog.getActiveVenues();
 *       var fmpStands    = pcCatalog.getActiveStandsForVenue('FMP');
 *       var fmpAll       = pcCatalog.getAllStandsForVenue('FMP'); // incl retired
 *       var isTiered     = pcCatalog.isVenueTiered('Mann'); // -> true
 *       var label        = pcCatalog.getVenueLabel('FMP'); // 'Freedom Mortgage Pavilion'
 *     });
 *   }});
 *
 * Reads use pcAuth.headers() — same authenticated header pattern every
 * admin page uses. RLS on `venues` and `stands` (SELECT for authenticated)
 * governs access.
 *
 * Ground truth as of 2026-05-25 (post stand cleanup migration):
 *   venues — 11 active: ACCC, BWH, Cure, DE, FMP, Kirkwood, Mann, Montage,
 *            SATB, Subaru, Villanova.
 *   stands — Active counts per venue: ACCC 5, BWH 7, Cure 6, DE 8, FMP 19,
 *            Kirkwood 4, Mann 26, Montage 15, SATB 8, Subaru 4, Villanova 3.
 *            (~33 inactive rows kept as historical anchors so Sales History
 *             joins keep working.)
 */
(function () {
  'use strict';

  var SB_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var REST = SB_URL + '/rest/v1/';

  // ---------------------------------------------------------------------
  // Cache — populated once per page session by the first ready() call.
  // ---------------------------------------------------------------------
  var _venues = null;   // [{ code, full_name, state, city, is_tiered,
                        //    is_active, sort_order }, ...]
  var _stands = null;   // [{ id, venue_code, stand_name, stand_type,
                        //    category_id, is_active, sort_order }, ...]
  var _readyPromise = null;

  // ---------------------------------------------------------------------
  // Internal: one authenticated GET against PostgREST.
  // ---------------------------------------------------------------------
  function sbGet(path) {
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) {
      return Promise.reject(new Error('pc-catalog.js: pc-auth.js must load first'));
    }
    return fetch(REST + path, { headers: pcAuth.headers() }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('pc-catalog.js HTTP ' + r.status + ' on ' + path +
            (t ? ' -- ' + t.slice(0, 200) : ''));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  // ---------------------------------------------------------------------
  // Internal: fetch both tables and normalise into the cache shape.
  //
  // Fetch limits are explicit (10000) per project SQL/REST conventions —
  // the Supabase 100-row default could silently truncate the stands fetch
  // as the inactive-rows pile grows.
  // ---------------------------------------------------------------------
  function loadAll() {
    var venuesReq = sbGet(
      'venues?select=code,full_name,state,city,is_tiered,is_active,sort_order' +
      '&order=sort_order.asc,code.asc&limit=10000'
    );

    var standsReq = sbGet(
      'stands?select=id,venue_code,stand_name,stand_type,category_id,is_active,sort_order' +
      '&order=venue_code.asc,sort_order.asc,stand_name.asc&limit=10000'
    );

    return Promise.all([venuesReq, standsReq]).then(function (results) {
      _venues = (results[0] || []).map(function (v) {
        return {
          code: v.code,
          full_name: v.full_name || v.code,
          state: v.state || null,
          city: v.city || null,
          is_tiered: v.is_tiered === true,
          is_active: v.is_active !== false,
          sort_order: typeof v.sort_order === 'number' ? v.sort_order : 0
        };
      });

      _stands = (results[1] || []).map(function (s) {
        return {
          id: s.id,
          venue_code: s.venue_code,
          stand_name: s.stand_name,
          stand_type: s.stand_type || 'revenue',
          category_id: s.category_id || null,
          is_active: s.is_active !== false,
          sort_order: typeof s.sort_order === 'number' ? s.sort_order : 0
        };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  var pcCatalog = {

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
     * to venues or stands so subsequent getter calls see fresh data.
     * Returns the new ready() promise.
     */
    refresh: function () {
      _venues = null;
      _stands = null;
      _readyPromise = null;
      return pcCatalog.ready();
    },

    // -------------------------------------------------------------------
    // VENUE GETTERS
    // -------------------------------------------------------------------

    /*
     * getActiveVenues() — every is_active = true venue, sorted by
     * sort_order then code. Returns an array of venue rows.
     */
    getActiveVenues: function () {
      _assertReady('getActiveVenues');
      return _venues
        .filter(function (v) { return v.is_active; })
        .map(_cloneVenue);
    },

    /*
     * getAllVenues({ includeRetired }) — same as getActiveVenues but
     * includes retired venues when { includeRetired: true } is passed.
     * Pages that show historical data (Sales History, EOM, Deal
     * Structure) should pass true.
     */
    getAllVenues: function (opts) {
      _assertReady('getAllVenues');
      var includeRetired = opts && opts.includeRetired;
      return _venues
        .filter(function (v) { return includeRetired || v.is_active; })
        .map(_cloneVenue);
    },

    /*
     * getVenue(code) — single venue row by code, or null. Active or
     * retired; callers decide what to do with is_active.
     */
    getVenue: function (code) {
      _assertReady('getVenue');
      for (var i = 0; i < _venues.length; i++) {
        if (_venues[i].code === code) return _cloneVenue(_venues[i]);
      }
      return null;
    },

    /*
     * getVenueCodes({ includeRetired }) — array of just venue codes,
     * sort-ordered. Active-only by default.
     */
    getVenueCodes: function (opts) {
      _assertReady('getVenueCodes');
      var includeRetired = opts && opts.includeRetired;
      return _venues
        .filter(function (v) { return includeRetired || v.is_active; })
        .map(function (v) { return v.code; });
    },

    /*
     * getVenueLabel(code) — full_name for a venue, or the code itself
     * as a fallback if the venue isn't in the catalog. Use this anywhere
     * the old VENUE_LABELS dict was being read.
     */
    getVenueLabel: function (code) {
      var v = pcCatalog.getVenue(code);
      return v ? v.full_name : code;
    },

    /*
     * isVenueTiered(code) — boolean. Replaces the hardcoded
     * TIERED_VENUES object. Returns false for unknown venues (safe
     * default — the par-level tier toggle will simply not appear).
     */
    isVenueTiered: function (code) {
      var v = pcCatalog.getVenue(code);
      return !!(v && v.is_tiered);
    },

    // -------------------------------------------------------------------
    // STAND GETTERS
    // -------------------------------------------------------------------

    /*
     * getActiveStandsForVenue(code) — active stands at a venue, sorted
     * by sort_order. Includes all stand_types (revenue, support,
     * hawking, client, nonevent). Most event-scoped pages should call
     * this and let downstream code filter by stand_type if needed.
     *
     * Each item: { id, venue_code, stand_name, stand_type, is_active,
     *              sort_order }
     */
    getActiveStandsForVenue: function (code) {
      _assertReady('getActiveStandsForVenue');
      return _stands
        .filter(function (s) { return s.venue_code === code && s.is_active; })
        .map(_cloneStand);
    },

    /*
     * getAllStandsForVenue(code) — every stand row for a venue,
     * including retired (is_active = false). Used by historical pages
     * (Sales History, EOM lookback, Deal Structure) so retired stands
     * with prior data still surface.
     */
    getAllStandsForVenue: function (code) {
      _assertReady('getAllStandsForVenue');
      return _stands
        .filter(function (s) { return s.venue_code === code; })
        .map(_cloneStand);
    },

    /*
     * getRevenueStandsForVenue(code) — convenience filter on top of
     * getActiveStandsForVenue, restricted to stand_type = 'revenue'.
     * Sales Log, Tips Report, and any other page concerned only with
     * revenue-attributing stands can use this directly.
     */
    getRevenueStandsForVenue: function (code) {
      _assertReady('getRevenueStandsForVenue');
      return _stands
        .filter(function (s) {
          return s.venue_code === code && s.is_active &&
            s.stand_type === 'revenue';
        })
        .map(_cloneStand);
    },

    /*
     * getStand(code, standName) — single stand row by (venue, name),
     * active or retired. Returns null if no match.
     */
    getStand: function (code, standName) {
      _assertReady('getStand');
      for (var i = 0; i < _stands.length; i++) {
        var s = _stands[i];
        if (s.venue_code === code && s.stand_name === standName) {
          return _cloneStand(s);
        }
      }
      return null;
    },

    /*
     * getStandById(id) — single stand row by UUID. Returns null if no
     * match. Used by FK-based callers (par_levels after migration,
     * future Plan tab on Event Workspace).
     */
    getStandById: function (id) {
      _assertReady('getStandById');
      for (var i = 0; i < _stands.length; i++) {
        if (_stands[i].id === id) return _cloneStand(_stands[i]);
      }
      return null;
    },

    /*
     * getStandsByType(code, type) — all active stands at a venue of a
     * particular stand_type. Useful for the Event Workspace Plan tab
     * which separates support / client / nonevent into their own
     * sections.
     */
    getStandsByType: function (code, type) {
      _assertReady('getStandsByType');
      return _stands
        .filter(function (s) {
          return s.venue_code === code && s.is_active &&
            s.stand_type === type;
        })
        .map(_cloneStand);
    }
  };

  // ---------------------------------------------------------------------
  // Internal: defensive copies so callers can't mutate the cache.
  // ---------------------------------------------------------------------
  function _cloneVenue(v) {
    return {
      code: v.code,
      full_name: v.full_name,
      state: v.state,
      city: v.city,
      is_tiered: v.is_tiered,
      is_active: v.is_active,
      sort_order: v.sort_order
    };
  }

  function _cloneStand(s) {
    return {
      id: s.id,
      venue_code: s.venue_code,
      stand_name: s.stand_name,
      stand_type: s.stand_type,
      category_id: s.category_id,
      is_active: s.is_active,
      sort_order: s.sort_order
    };
  }

  // ---------------------------------------------------------------------
  // Internal: guard so getters fail loudly if called before ready().
  // ---------------------------------------------------------------------
  function _assertReady(fnName) {
    if (_venues === null || _stands === null) {
      throw new Error('pc-catalog.js: pcCatalog.' + fnName +
        '() called before pcCatalog.ready() resolved');
    }
  }

  // Expose globally, matching pcAuth / pcNav / pcRoles convention.
  window.pcCatalog = pcCatalog;

})();
