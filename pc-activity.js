/*
 * pc-activity.js — Popcorn Chez Manager Toolkit activity instrumentation
 *
 * Loaded by pages AFTER /pc-auth.js (and after /pc-nav.js, /pc-roles.js
 * if they're used). Emits three event types to the activity_events
 * Supabase table so the future Activity Explorer + Heartbeat Dashboard
 * can answer questions like "what did Brian touch and when".
 *
 *   page_load     — fired once on pcAuth.require onReady callback
 *   heartbeat     — fired every 60s while the tab is visible
 *   page_unload   — fired on beforeunload via navigator.sendBeacon
 *
 * Sessions: each page-load generates a random session_id (UUID-ish).
 * All heartbeats and the eventual page_unload for that visit share it,
 * so the Explorer can group "one continuous visit" cleanly.
 *
 * RLS: the activity_events policy only allows INSERT when user_id =
 * auth.uid(). pcAuth.headers() supplies the JWT; the server derives
 * auth.uid() from it. We send our local user_id too for client-side
 * consistency, but the server's check is what governs.
 *
 * No-op safety: if pcAuth is missing, not ready, or has no user, this
 * script does nothing. It can be safely included on public pages — it
 * will sit silent. It also no-ops if the page is opted out via
 *   <body data-pc-activity-disable="1">
 *
 * Author: Keith (via session, May 18, 2026)
 * Related: activity-events-schema.sql, activity-heartbeat-spec.md
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  var SB_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var ENDPOINT = SB_URL + '/rest/v1/activity_events';
  var HEARTBEAT_MS = 60 * 1000;   // 60 seconds
  var MAX_BOOT_WAIT_MS = 8000;    // give pcAuth up to 8s to resolve

  // ---------------------------------------------------------------------
  // State (per page-load)
  // ---------------------------------------------------------------------
  var _sessionId    = null;
  var _pageSlug     = null;
  var _user         = null;
  var _heartbeatTmr = null;
  var _booted       = false;
  var _unloaded     = false;

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function genSessionId() {
    // Crypto-random when available, fallback to Math.random.
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return (
      'sess-' +
      Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function deviceClass() {
    var ua = (navigator.userAgent || '').toLowerCase();
    if (/ipad/.test(ua) || (/macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/iphone|ipod/.test(ua)) return 'iphone';
    if (/android/.test(ua) && /mobile/.test(ua)) return 'android-phone';
    if (/android/.test(ua)) return 'android-tablet';
    if (/windows phone/.test(ua)) return 'windows-phone';
    if (/macintosh|mac os x/.test(ua)) return 'mac';
    if (/windows/.test(ua)) return 'windows';
    if (/linux/.test(ua)) return 'linux';
    return 'unknown';
  }

  function baseMetadata() {
    return {
      device:     deviceClass(),
      ua:         (navigator.userAgent || '').slice(0, 250),
      viewport_w: window.innerWidth  || null,
      viewport_h: window.innerHeight || null,
      referrer:   (document.referrer || '').slice(0, 250) || null
    };
  }

  // ---------------------------------------------------------------------
  // Sending
  //
  // Normal events go via fetch() with auth headers.
  // The final page_unload uses navigator.sendBeacon when available so
  // the request survives the page being torn down. Beacon can only send
  // with simple content types, so it goes as text/plain JSON — Supabase
  // REST will reject the auth header pattern via beacon, so we fall back
  // to a synchronous-ish fetch with keepalive=true.
  // ---------------------------------------------------------------------
  function buildRow(eventType, extraMeta) {
    var meta = baseMetadata();
    if (extraMeta) {
      for (var k in extraMeta) {
        if (Object.prototype.hasOwnProperty.call(extraMeta, k)) {
          meta[k] = extraMeta[k];
        }
      }
    }
    // user_id MUST be the Supabase auth user UUID (auth.users.id), which
    // pc-auth.js exposes on currentUser.auth_id. The user_roles.id column
    // is a different (internal) PK and will fail the RLS check
    // user_id = auth.uid().
    return {
      user_id:      _user.auth_id,
      display_name: _user.display_name || _user.email || 'unknown',
      page_slug:    _pageSlug,
      event_type:   eventType,
      session_id:   _sessionId,
      metadata:     meta
    };
  }

  function sendEvent(eventType, extraMeta, useKeepalive) {
    if (!_booted || !_user || !_pageSlug) return;
    if (typeof pcAuth === 'undefined' || !pcAuth.headers) return;

    var row = buildRow(eventType, extraMeta);
    var headers = pcAuth.headers();
    headers['Content-Type'] = 'application/json';
    headers['Prefer'] = 'return=minimal';

    var opts = {
      method:  'POST',
      headers: headers,
      body:    JSON.stringify(row)
    };
    if (useKeepalive) {
      // Lets the request complete after page unload.
      opts.keepalive = true;
    }

    // Fire-and-forget. We swallow errors so a 403/500 never breaks the page.
    try {
      fetch(ENDPOINT, opts).catch(function () { /* silent */ });
    } catch (e) {
      // Some browsers throw synchronously if keepalive body is too large; ignore.
    }
  }

  // ---------------------------------------------------------------------
  // Heartbeat loop
  // ---------------------------------------------------------------------
  function startHeartbeat() {
    stopHeartbeat();
    _heartbeatTmr = setInterval(function () {
      if (_unloaded) return;
      // Only ping when the tab is visible. Background tabs don't count
      // as "working" time and would inflate session duration math.
      if (document.visibilityState !== 'visible') return;
      sendEvent('heartbeat', null, false);
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (_heartbeatTmr) {
      clearInterval(_heartbeatTmr);
      _heartbeatTmr = null;
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle wiring
  // ---------------------------------------------------------------------
  function onUnload() {
    if (_unloaded) return;
    _unloaded = true;
    stopHeartbeat();
    sendEvent('page_unload', null, true);
  }

  function wireUnloadHandlers() {
    // beforeunload + pagehide together cover desktop reloads, mobile
    // background-tab kills, and bfcache stashes.
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide',     onUnload);
  }

  // ---------------------------------------------------------------------
  // Boot
  //
  // We try to pick up the user from pcAuth.getUser(). If pcAuth.require
  // has already fired onReady, the user is sitting there immediately.
  // If not, we poll briefly. After MAX_BOOT_WAIT_MS we give up silently
  // (the page is probably public, or auth is broken — either way, not
  // our problem to surface here).
  // ---------------------------------------------------------------------
  function boot(pageSlug) {
    if (_booted) return;
    if (!pageSlug) return;
    if (typeof pcAuth === 'undefined' || !pcAuth.getUser) return;

    if (document.body && document.body.getAttribute('data-pc-activity-disable') === '1') {
      return;
    }

    var attempts = 0;
    var MAX = Math.ceil(MAX_BOOT_WAIT_MS / 100);

    function tryReady() {
      var u = pcAuth.getUser();
      // We need auth_id specifically — the Supabase auth UUID — because
      // RLS on activity_events checks user_id = auth.uid(). If a
      // user_roles row exists but auth_id has not been auto-linked yet,
      // skip silently rather than emit doomed inserts.
      if (u && u.auth_id) {
        _user = u;
        _pageSlug = pageSlug;
        _sessionId = genSessionId();
        _booted = true;
        sendEvent('page_load', null, false);
        startHeartbeat();
        wireUnloadHandlers();
        return;
      }
      if (++attempts < MAX) {
        setTimeout(tryReady, 100);
      }
    }
    tryReady();
  }

  // ---------------------------------------------------------------------
  // Public API
  //
  // Pages call:
  //   pcActivity.init('schedule-assistant');
  //
  // The simplest pattern is to call this inside the same
  // pcAuth.require({ onReady }) callback the page already has:
  //
  //   pcAuth.require({
  //     pageSlug: 'schedule-assistant',
  //     onReady: function (user) {
  //       pcActivity.init('schedule-assistant');
  //       // ... rest of page init
  //     }
  //   });
  //
  // init() is idempotent — calling twice is a no-op.
  // ---------------------------------------------------------------------
  var pcActivity = {
    init: function (pageSlug) {
      boot(pageSlug);
    },

    /*
     * Optional. Pages with a custom action (e.g. successful save) can
     * call this to emit a labelled event. Goes through the same RLS path.
     * Currently unused, but cheap to expose for future Explorer drilldown.
     */
    track: function (eventName, extraMeta) {
      if (!_booted) return;
      // Stored as a heartbeat-class event with metadata.action_name so we
      // don't need to expand the CHECK constraint on event_type. The
      // Explorer can surface metadata.action_name as a distinct row type.
      var meta = extraMeta || {};
      meta.action_name = String(eventName).slice(0, 80);
      sendEvent('heartbeat', meta, false);
    },

    /* Diagnostics — handy in DevTools. */
    _debug: function () {
      return {
        booted:    _booted,
        sessionId: _sessionId,
        pageSlug:  _pageSlug,
        user:      _user ? (_user.display_name || _user.email) : null
      };
    }
  };

  window.pcActivity = pcActivity;
})();
