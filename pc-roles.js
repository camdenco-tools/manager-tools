/*
 * pc-roles.js — Popcorn Chez Manager Toolkit shared role catalog helper
 *
 * Loaded by pages AFTER /pc-auth.js. Provides read-only access to the
 * `roles` and `venue_roles` catalog tables (seeded May 14, 2026 — Phase -2).
 *
 * This is the role-side sibling of pc-catalog.js (Phase -2b,
 * stands + venues). It is a PURE READ LAYER — it never writes. Pages that
 * edit venue_roles (e.g. the Venue Roles admin page) issue their own
 * fetch() writes and then call pcRoles.refresh() to invalidate the cache.
 *
 * Usage:
 *   <script src="/pc-auth.js"></script>
 *   <script src="/pc-roles.js"></script>
 *   ...
 *   pcAuth.require({ pageSlug: '...', onReady: function (user) {
 *     pcRoles.ready().then(function () {
 *       var roles = pcRoles.getRoles();                 // all 11 canonical roles
 *       var fmp   = pcRoles.getRolesForVenue('FMP');    // active roles at FMP
 *       var rate  = pcRoles.getPayRate('FMP', 'Bartender');
 *       var canon = pcRoles.legacyToCanonical('Concessions Cashier'); // -> 'Cashier'
 *     });
 *   }});
 *
 * Reads use pcAuth.headers() — the same authenticated header pattern every
 * admin page uses. RLS on `roles` (SELECT-only) and `venue_roles`
 * (SELECT/INSERT/UPDATE) governs access.
 *
 * Seeded reference (ground truth as of 2026-05-14):
 *   roles        — 11 rows: Supervisor, Lead, Bar Lead, Bartender, Cashier,
 *                  Cook, Pizza Maker, Stand Worker, Warehouse, Cleaner, Hawker
 *   venue_roles  — 59 rows across 11 venues (Kirkwood has 0)
 *
 * Legacy-to-canonical translation (added May 26, 2026):
 *   The DB still contains legacy role strings on rows written before the
 *   migration_markers cutover (2026-05-19 13:44:18 UTC). pcRoles.legacyToCanonical
 *   translates any legacy string to its canonical equivalent. Mapping is
 *   from role-pay-mapping-reference.md (confirmed by Keith May 14, 2026)
 *   + the legacy-role-string spelunking documented in
 *   project-update-may19-role-stand-catalog-foundation.md.
 *
 *   Safe to call on any input: canonical strings pass through unchanged,
 *   unknown strings pass through unchanged. Returns null only for the
 *   two confirmed DROP roles (Barback, Venue Manager) so callers can
 *   filter them out explicitly. Use pcRoles.isDropped() if you just want
 *   the boolean check.
 */
(function () {
  'use strict';

  var SB_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var REST = SB_URL + '/rest/v1/';

  // ---------------------------------------------------------------------
  // Cache — populated once per page session by the first ready() call.
  // ---------------------------------------------------------------------
  var _roles = null;          // [{ id, name, sort_order, is_active }, ...]
  var _venueRoles = null;     // [{ id, venue_id, role_id, venue_code,
                              //    role_name, role_sort, pay_rate,
                              //    is_active }, ...]
  var _readyPromise = null;   // the in-flight or settled load promise

  // ---------------------------------------------------------------------
  // Legacy-to-canonical mapping (added May 26, 2026).
  //
  // Hardcoded constant — small, stable, derived from confirmed reference
  // doc. Building this as a function rather than a DB lookup because:
  //   1. The mapping universe is closed (22 strings, no new legacy strings
  //      can be created — the marker is in the past).
  //   2. Translating role strings is a hot path (every render call hits
  //      it many times). A function lookup is O(1) and synchronous.
  //   3. A DB-backed mapping would need yet another table + RLS + fetch
  //      for data that will never change.
  //
  // Source: role-pay-mapping-reference.md (confirmed by Keith 2026-05-14)
  // combined with the legacy-string spelunking from
  // project-update-may19-role-stand-catalog-foundation.md.
  //
  // Sentinel values:
  //   null  — the role is confirmed DROP (Barback, Venue Manager).
  //           Callers should filter these out. Don't render, don't sort.
  //   '__MULTI__' — the special "Multiple / Open" applicant tag that
  //           expands to three canonical roles. Callers that hit this
  //           should treat it as [Stand Worker, Cashier, Cleaner] rather
  //           than a single role. Rare — should only appear in candidate
  //           applicant data, not in staffing_requests or position_assignments.
  // ---------------------------------------------------------------------
  var _LEGACY_TO_CANONICAL = {
    // Already-canonical names (pass-through, included for completeness
    // so callers can blindly run any string through the function)
    'Supervisor':                  'Supervisor',
    'Lead':                        'Lead',
    'Bar Lead':                    'Bar Lead',
    'Bartender':                   'Bartender',
    'Cashier':                     'Cashier',
    'Cook':                        'Cook',
    'Pizza Maker':                 'Pizza Maker',
    'Stand Worker':                'Stand Worker',
    'Warehouse':                   'Warehouse',
    'Cleaner':                     'Cleaner',
    'Hawker':                      'Hawker',

    // Renames (one legacy string -> one canonical role)
    'Concessions Lead':            'Lead',
    'Concessions Cashier':         'Cashier',
    'Concessions Cook':            'Cook',
    'Cleaning Crew':               'Cleaner',
    'Warehouse/Runner':            'Warehouse',

    // Collapses (multiple legacy strings -> one canonical role)
    'Pizza Lead':                  'Lead',
    'Pizza Cashier':               'Cashier',
    'Beer Tender':                 'Bartender',
    'Prep Cook':                   'Cook',

    // Parenthetical-stripped variants seen in the spelunking
    'Bartender (mixed drinks)':    'Bartender',
    'Beer Tender (beer only)':     'Bartender',
    'Hawker (commission)':         'Hawker',
    'Supervisor / Manager':        'Supervisor',

    // Drops (no canonical equivalent — null sentinel)
    'Barback':                     null,
    'Venue Manager':               null,

    // Special expansion case (used only in applicant data, see header)
    'Multiple / Open':             '__MULTI__'
  };

  // ---------------------------------------------------------------------
  // Internal: one authenticated GET against PostgREST.
  // ---------------------------------------------------------------------
  function sbGet(path) {
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) {
      return Promise.reject(new Error('pc-roles.js: pc-auth.js must load first'));
    }
    return fetch(REST + path, { headers: pcAuth.headers() }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('pc-roles.js HTTP ' + r.status + ' on ' + path +
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
  // venue_roles is fetched with an embedded PostgREST select so we get
  // readable venue codes + role names in a single round trip instead of
  // joining UUIDs client-side.
  // ---------------------------------------------------------------------
  function loadAll() {
    var rolesReq = sbGet('roles?select=id,name,sort_order,is_active&order=sort_order.asc');

    var vrReq = sbGet(
      'venue_roles?select=id,venue_id,role_id,pay_rate,is_active,' +
      'venues(code),roles(name,sort_order)'
    );

    return Promise.all([rolesReq, vrReq]).then(function (results) {
      _roles = (results[0] || []).map(function (r) {
        return {
          id: r.id,
          name: r.name,
          sort_order: r.sort_order,
          is_active: r.is_active !== false
        };
      });

      _venueRoles = (results[1] || []).map(function (vr) {
        var venue = vr.venues || {};
        var role = vr.roles || {};
        return {
          id: vr.id,
          venue_id: vr.venue_id,
          role_id: vr.role_id,
          venue_code: venue.code || null,
          role_name: role.name || null,
          role_sort: typeof role.sort_order === 'number' ? role.sort_order : 9999,
          // pay_rate comes back as a string from PostgREST numeric — coerce.
          pay_rate: vr.pay_rate == null ? null : Number(vr.pay_rate),
          is_active: vr.is_active !== false
        };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  var pcRoles = {

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
     * to venue_roles so subsequent getter calls see fresh data.
     * Returns the new ready() promise.
     */
    refresh: function () {
      _roles = null;
      _venueRoles = null;
      _readyPromise = null;
      return pcRoles.ready();
    },

    /*
     * getRoles({ includeRetired }) — the canonical role catalog,
     * sorted by sort_order. Active-only by default.
     */
    getRoles: function (opts) {
      _assertReady('getRoles');
      var includeRetired = opts && opts.includeRetired;
      return _roles
        .filter(function (r) { return includeRetired || r.is_active; })
        .slice();
    },

    /*
     * getRole(name) — single canonical role row by name, or null.
     */
    getRole: function (name) {
      _assertReady('getRole');
      for (var i = 0; i < _roles.length; i++) {
        if (_roles[i].name === name) return _roles[i];
      }
      return null;
    },

    /*
     * getRolesForVenue(code, { includeRetired }) — the roles valid at a
     * venue, sorted by the role's catalog sort_order. Active venue_roles
     * only by default; pass includeRetired to also get retired mappings
     * (the Venue Roles editor needs this to surface un-retire controls).
     *
     * Each item: { venue_role_id, venue_code, role_id, role_name,
     *              pay_rate, is_active }
     */
    getRolesForVenue: function (code, opts) {
      _assertReady('getRolesForVenue');
      var includeRetired = opts && opts.includeRetired;
      return _venueRoles
        .filter(function (vr) {
          return vr.venue_code === code && (includeRetired || vr.is_active);
        })
        .sort(function (a, b) { return a.role_sort - b.role_sort; })
        .map(function (vr) {
          return {
            venue_role_id: vr.id,
            venue_code: vr.venue_code,
            role_id: vr.role_id,
            role_name: vr.role_name,
            pay_rate: vr.pay_rate,
            is_active: vr.is_active
          };
        });
    },

    /*
     * getVenueRole(code, roleName) — the single venue_roles row for a
     * (venue, role) pair, or null if that role isn't mapped at the venue.
     * Returns retired rows too — callers decide what to do with is_active.
     */
    getVenueRole: function (code, roleName) {
      _assertReady('getVenueRole');
      for (var i = 0; i < _venueRoles.length; i++) {
        var vr = _venueRoles[i];
        if (vr.venue_code === code && vr.role_name === roleName) {
          return {
            venue_role_id: vr.id,
            venue_code: vr.venue_code,
            role_id: vr.role_id,
            role_name: vr.role_name,
            pay_rate: vr.pay_rate,
            is_active: vr.is_active
          };
        }
      }
      return null;
    },

    /*
     * getPayRate(code, roleName) — the per-venue pay rate for a role, or
     * null if the role isn't mapped at that venue.
     *
     * Note: Hawker rows are seeded $0.00 by the existing commission
     * convention — a 0 here is meaningful, not "missing". Only null
     * means "no such mapping".
     */
    getPayRate: function (code, roleName) {
      var vr = pcRoles.getVenueRole(code, roleName);
      return vr ? vr.pay_rate : null;
    },

    /*
     * getVenueCodes() — distinct venue codes that have at least one
     * venue_roles row, sorted alphabetically. (Venues with zero roles —
     * e.g. Kirkwood today — won't appear here. The editor page should
     * source its venue list from the venues table, not from this.)
     */
    getVenueCodes: function () {
      _assertReady('getVenueCodes');
      var seen = {};
      _venueRoles.forEach(function (vr) {
        if (vr.venue_code) seen[vr.venue_code] = true;
      });
      return Object.keys(seen).sort();
    },

    /*
     * legacyToCanonical(roleString) — translates a legacy role string
     * to its canonical equivalent. Safe to call on any input:
     *   - Canonical names pass through unchanged ('Supervisor' -> 'Supervisor')
     *   - Known legacy names translate ('Concessions Cashier' -> 'Cashier')
     *   - Dropped roles return null (callers should filter these out)
     *   - 'Multiple / Open' returns '__MULTI__' sentinel (callers that
     *     hit this should expand to [Stand Worker, Cashier, Cleaner])
     *   - Unknown strings pass through unchanged so misspelled rows
     *     still render something (won't break the page)
     *
     * Does NOT require ready() to have been called — pure synchronous
     * lookup against the hardcoded constant table.
     */
    legacyToCanonical: function (roleString) {
      if (roleString == null) return null;
      if (Object.prototype.hasOwnProperty.call(_LEGACY_TO_CANONICAL, roleString)) {
        return _LEGACY_TO_CANONICAL[roleString];
      }
      // Unknown string — pass through unchanged. Better to render a
      // surprise string than to silently drop a row.
      return roleString;
    },

    /*
     * isDropped(roleString) — convenience boolean for the 2 confirmed
     * DROP roles (Barback, Venue Manager). Returns true if the string
     * is one of those; false for canonical, renamed, collapsed, or
     * unknown strings.
     *
     * Use this when filtering a role list before rendering — e.g. in a
     * stand card's role iteration, skip any role where isDropped() is
     * true so retired pseudo-roles disappear from the UI without losing
     * historical data.
     */
    isDropped: function (roleString) {
      if (roleString == null) return false;
      if (!Object.prototype.hasOwnProperty.call(_LEGACY_TO_CANONICAL, roleString)) {
        return false;
      }
      return _LEGACY_TO_CANONICAL[roleString] === null;
    }
  };

  // ---------------------------------------------------------------------
  // Internal: guard so getters fail loudly if called before ready().
  // ---------------------------------------------------------------------
  function _assertReady(fnName) {
    if (_roles === null || _venueRoles === null) {
      throw new Error('pc-roles.js: pcRoles.' + fnName +
        '() called before pcRoles.ready() resolved');
    }
  }

  // Expose globally, matching pcAuth / pcNav convention.
  window.pcRoles = pcRoles;

})();
