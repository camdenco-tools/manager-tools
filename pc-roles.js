/*
 * pc-roles.js — Popcorn Chez Manager Toolkit shared role catalog helper
 *
 * Loaded by pages AFTER /pc-auth.js. Provides read-only access to the
 * `roles` and `venue_roles` catalog tables (seeded May 14, 2026 — Phase -2).
 *
 * This is the role-side sibling of pc-catalog.js (Phase -2b,
 * stands + venues). The roles/venue_roles CATALOG half is read-only —
 * pages that edit venue_roles (e.g. the Venue Roles admin page) issue
 * their own fetch() writes and then call pcRoles.refresh() to invalidate
 * the cache. The employee_venue_roles ELIGIBILITY half (added June 3, 2026)
 * is read + write via getEmployeeVenueRoles / setEmployeeVenueRoles.
 * Eligibility writes never touch pay_rate_override — wages are a separate
 * feature layered on top.
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
 *
 *       // Employee eligibility layer (employee_venue_roles, read + write):
 *       pcRoles.getEmployeeVenueRoles(empId).then(function (rows) { ... });
 *       pcRoles.setEmployeeVenueRoles(empId,
 *         [{ venueCode: 'FMP', roleName: 'Cashier' }], 'Keith K');
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
  // Internal: one authenticated write (POST/PATCH) against PostgREST.
  // Used only by the employee_venue_roles eligibility writer below — the
  // roles/venue_roles catalog stays read-only.
  // ---------------------------------------------------------------------
  function sbWrite(path, method, body, prefer) {
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) {
      return Promise.reject(new Error('pc-roles.js: pc-auth.js must load first'));
    }
    var headers = Object.assign({}, pcAuth.headers(), { 'Content-Type': 'application/json' });
    if (prefer) headers['Prefer'] = prefer;
    return fetch(REST + path, {
      method: method,
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('pc-roles.js HTTP ' + r.status + ' on ' + method + ' ' + path +
            (t ? ' -- ' + t.slice(0, 200) : ''));
          err.status = r.status;
          throw err;
        });
      }
      return r;
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
     * getEmployeeVenueRoles(employeeId, { includeRetired }) — every
     * (venue, role) this employee is assigned, with override-aware pay.
     * Active rows only by default. Returns a promise; calls ready()
     * internally so the live venue_roles rate is available to compute
     * effective_rate.
     *
     * Each item: { id, employee_id, venue_id, role_id, venue_code,
     *   role_name, is_active, pay_rate_override, default_rate,
     *   effective_rate }
     *     default_rate      — live venue_roles rate for the pair, or null
     *                         if the pair is no longer a mapped venue_role
     *     pay_rate_override — per-person rate, or null (inherits default)
     *     effective_rate    — pay_rate_override when set, else default_rate
     *
     * NOT cached — employee assignments are mutable per-person data,
     * unlike the catalog. Re-call after a write to refresh.
     */
    getEmployeeVenueRoles: function (employeeId, opts) {
      var includeRetired = opts && opts.includeRetired;
      return pcRoles.ready().then(function () {
        var path = 'employee_venue_roles?employee_id=eq.' +
          encodeURIComponent(employeeId) +
          '&select=id,employee_id,venue_id,role_id,pay_rate_override,is_active,' +
          'venues(code),roles(name)';
        if (!includeRetired) path += '&is_active=eq.true';
        return sbGet(path);
      }).then(function (rows) {
        return (rows || []).map(function (r) {
          var code = (r.venues || {}).code || null;
          var roleName = (r.roles || {}).name || null;
          var override = r.pay_rate_override == null ? null : Number(r.pay_rate_override);
          var def = (code && roleName) ? pcRoles.getPayRate(code, roleName) : null;
          return {
            id: r.id,
            employee_id: r.employee_id,
            venue_id: r.venue_id,
            role_id: r.role_id,
            venue_code: code,
            role_name: roleName,
            is_active: r.is_active !== false,
            pay_rate_override: override,
            default_rate: def,
            effective_rate: override != null ? override : def
          };
        }).sort(function (a, b) {
          if (a.venue_code === b.venue_code) {
            return (a.role_name || '').localeCompare(b.role_name || '');
          }
          return (a.venue_code || '').localeCompare(b.venue_code || '');
        });
      });
    },

    /*
     * setEmployeeVenueRoles(employeeId, desiredPairs, actor) — diffs the
     * employee's current eligibility against the desired (ticked) set and
     * writes only the difference. ELIGIBILITY ONLY — never touches
     * pay_rate_override, so a per-person wage survives an untick/retick
     * (the retired row keeps its override and comes back on reactivate).
     *
     *   desiredPairs — [{ venueCode, roleName }, ...]
     *   actor        — string stamped into created_by / updated_by
     *                  (pass pcAuth.getUser().display_name)
     *
     * Per pair: absent -> INSERT; present+retired -> reactivate;
     * present+active -> no-op. Active row not in desired -> soft-retire.
     * Resolves to { added, reactivated, retired, unchanged }. Rejects if
     * a desired pair isn't a legal venue_role (caller bug).
     */
    setEmployeeVenueRoles: function (employeeId, desiredPairs, actor) {
      desiredPairs = desiredPairs || [];
      var now = new Date().toISOString();
      return pcRoles.ready().then(function () {
        var desired = desiredPairs.map(function (p) {
          var match = null;
          for (var i = 0; i < _venueRoles.length; i++) {
            var vr = _venueRoles[i];
            if (vr.venue_code === p.venueCode && vr.role_name === p.roleName) {
              match = vr; break;
            }
          }
          if (!match) {
            throw new Error('pc-roles.js setEmployeeVenueRoles: no venue_role for ' +
              p.venueCode + ' / ' + p.roleName + ' — illegal pair.');
          }
          return {
            venue_id: match.venue_id,
            role_id: match.role_id,
            key: match.venue_id + '|' + match.role_id
          };
        });
        var desiredKeys = {};
        desired.forEach(function (d) { desiredKeys[d.key] = true; });

        return sbGet('employee_venue_roles?employee_id=eq.' +
            encodeURIComponent(employeeId) +
            '&select=id,venue_id,role_id,is_active')
          .then(function (rows) {
            rows = rows || [];
            var existing = {};
            rows.forEach(function (r) { existing[r.venue_id + '|' + r.role_id] = r; });

            var toInsert = [], toReactivate = [], toRetire = [], unchanged = 0;

            desired.forEach(function (d) {
              var ex = existing[d.key];
              if (!ex) {
                toInsert.push({
                  employee_id: employeeId,
                  venue_id: d.venue_id,
                  role_id: d.role_id,
                  is_active: true,
                  created_by: actor || null,
                  updated_by: actor || null
                });
              } else if (!ex.is_active) {
                toReactivate.push(ex.id);
              } else {
                unchanged++;
              }
            });

            rows.forEach(function (r) {
              if (r.is_active && !desiredKeys[r.venue_id + '|' + r.role_id]) {
                toRetire.push(r.id);
              }
            });

            var ops = [];
            if (toInsert.length) {
              ops.push(sbWrite('employee_venue_roles', 'POST', toInsert, 'return=minimal'));
            }
            if (toReactivate.length) {
              ops.push(sbWrite('employee_venue_roles?id=in.(' + toReactivate.join(',') + ')',
                'PATCH',
                { is_active: true, updated_by: actor || null, updated_at: now },
                'return=minimal'));
            }
            if (toRetire.length) {
              ops.push(sbWrite('employee_venue_roles?id=in.(' + toRetire.join(',') + ')',
                'PATCH',
                { is_active: false, updated_by: actor || null, updated_at: now },
                'return=minimal'));
            }
            return Promise.all(ops).then(function () {
              return {
                added: toInsert.length,
                reactivated: toReactivate.length,
                retired: toRetire.length,
                unchanged: unchanged
              };
            });
          });
      });
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
