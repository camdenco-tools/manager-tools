/*
 * pc-nav.js — Popcorn Chez Manager Toolkit shared navigation
 *
 * Loaded by every Netlify page AFTER /pc-auth.js. Injects:
 *   1. The top header bar (logo + MANAGER TOOLKIT pill on left; user + sign out on right)
 *   2. The sticky ribbon (People / Operations / Dashboards / Admin)
 *   3. The floating back-to-top button (appears after 600px scroll)
 *
 * Plus a single <style> block for everything above. No per-page CSS needed.
 *
 * To add a new page to the ribbon: edit PC_NAV_CONFIG below, push to GitHub.
 *
 * Spec: global-navigation-standards.md (May 11, 2026)
 */
(function () {
  'use strict';

  // =====================================================================
  // PAGE CONFIG — the single source of truth for what lives in each lane.
  // =====================================================================
  // Each item: { label, href, slug }
  //   - label: shown in dropdown (sentence case, no sub-text)
  //   - href: where the link points
  //   - slug: matches the User Access page-access checkbox grid
  //
  // To grey out / hide a no-access row, the slug must match exactly what
  // user_roles.page_access stores. Admins bypass these checks.
  //
  // Dashboards is a SINGLE direct link (no dropdown) per spec.
  // ---------------------------------------------------------------------
  var PC_NAV_CONFIG = {
    people: [
      { label: 'Pipeline',                       href: '/candidate-pipeline/',     slug: 'pipeline' },
      { label: 'Interviews',                     href: '/interviews/',             slug: 'interviews' },
      { label: 'I-9 verification',               href: '/i9-verification/',        slug: 'i9-verification' },
      { label: 'Certifications',                 href: '/certifications/',         slug: 'certifications' },
      { label: 'Crew',                           href: '/crew/',                   slug: 'crew' },
      { label: 'Handbook signatures',            href: '/handbook-signatures/',    slug: 'handbook-signatures' },
      { label: 'Schedule + Planning (Beta)',     href: '/schedule-assistant-beta/', slug: 'schedule-assistant-beta' },
      { label: 'Schedule assistant',             href: '/schedule-assistant/',     slug: 'schedule-assistant' },
      { label: 'Hiring snapshot',                href: '/hiring-snapshot/',        slug: 'hiring-snapshot' }
    ],
    operations: [
      { label: 'Submit event',                   href: '/submit-event/',           slug: 'submit-event' },
      { label: 'Event planning',                 href: '/event-planning/',         slug: 'event-planning' },
      { label: 'Prep & Production Planning',     href: '/prep-production-planning/', slugAny: ['prep-planning', 'prep-production'] },
      { label: 'Day-of-show sheet',              href: '/day-of-show-sheet/',      slug: 'day-of-show-sheet' },
      { label: 'Schedule assistant',             href: '/schedule-assistant/',     slug: 'schedule-assistant' },
      { label: 'Log sales',                      href: '/log-sales/',              slug: 'log-sales' },
      { label: 'Sales history',                  href: '/sales-history/',          slug: 'sales-history' },
      { label: 'Tips report',                    href: '/tips-report/',            slug: 'tips-report' },
      { label: 'Purchases & transfers',          href: '/purchases/',              slug: 'purchases' },
      { label: 'Cash deposit receipts',          href: '/cash-deposits/',          slug: 'cash-deposits' },
      { label: 'Ending inventory',               href: '/ending-inventory/',       slug: 'ending-inventory' },
      { label: 'Asset tracker',                  href: '/asset-tracker/',          slug: 'asset-tracker' },
      { label: 'COS & Labor',                    href: '/cos-labor/',              slug: 'cos-labor' }
    ],
    dashboards: [
      { label: 'Staffing dashboard',           href: '/dashboard/',          slug: 'dashboard' },
      { label: 'Weather Impacts',               href: '/weather-impacts/',    slug: 'weather-impacts' }
    ],
    admin: [
      { label: 'Accounts receivable',            href: '/accounts-receivable/',    slug: 'accounts-receivable' },
      { label: 'Sales by item',                  href: '/sales-by-item/',          slug: 'sales-by-item' },
      { label: 'Expense reports',                href: '/expense-reports/',        slug: 'expense-reports' },
      { label: 'Check writer',                   href: '/checks/',                 slug: 'checks' },
      { label: 'Bank review',                    href: '/bank-review/',            slug: 'bank-review' },
      { label: 'Event master list',              href: '/events-admin/',           slug: 'events-admin' },
      { label: 'User access',                    href: '/user-access/',            slug: 'user-access' },
      { label: 'Venue roles',                    href: '/manage-venue-roles/',     slug: 'manage-venue-roles' },
      { label: 'Par levels',                     href: '/par-levels/',             slug: 'par-levels' },
      { label: 'Deal structure',                 href: '/deal-structure/',         slug: 'deal-structure' },
      { label: 'Commission tracker',             href: '/commission-tracker/',     slug: 'commission-tracker' },
      { label: 'Item catalog',                   href: '/item-catalog/',           slug: 'item-catalog' },
      { label: 'Venue item profiles',            href: '/venue-item-profiles/',    slug: 'venue-item-profiles' },
      { label: 'Activity heartbeat',             href: '/activity-heartbeat/',     slug: 'activity-heartbeat' }
    ]
  };

  // =====================================================================
  // STYLES — injected once at the top of <head>
  // =====================================================================
  var STYLES = [
    '/* pc-nav.js injected styles */',
    '.pc-nav-header,.pc-nav-ribbon{font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '.pc-nav-header{position:sticky;top:0;z-index:900;background:#fff;border-bottom:1px solid #e8e8e4;height:64px;padding:0 22px;display:flex;align-items:center;justify-content:space-between;}',
    '.pc-nav-header-left{display:flex;align-items:center;gap:12px;}',
    '.pc-nav-wordmark{font-size:13px;font-weight:500;color:#1a1a1a;letter-spacing:-0.01em;text-decoration:none;}',
    '.pc-nav-wordmark:hover{opacity:0.7;}',
    '.pc-nav-pill{font-size:9px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;background:#1a1a1a;color:#fff;padding:3px 8px;border-radius:20px;}',
    '.pc-nav-header-right{display:flex;align-items:center;gap:12px;}',
    '.pc-nav-user{font-size:13px;color:#999;font-weight:500;}',
    '.pc-nav-user-placeholder{font-size:13px;color:#ccc;font-weight:500;}',
    '.pc-nav-signout{font-size:12px;color:#1a1a1a;background:#fff;border:1px solid #d8d8d4;padding:5px 12px;border-radius:20px;cursor:pointer;font-weight:500;font-family:inherit;}',
    '.pc-nav-signout:hover{background:#f6f6f3;}',
    '.pc-nav-ribbon{position:sticky;top:64px;z-index:899;background:#fff;border-bottom:1px solid #e8e8e4;padding:10px 22px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;}',
    '.pc-nav-lane{position:relative;display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;font-weight:500;padding:4px 2px;user-select:none;text-decoration:none;}',
    '.pc-nav-lane.lane-people{color:#639922;}',
    '.pc-nav-lane.lane-operations{color:#185FA5;}',
    '.pc-nav-lane.lane-dashboards{color:#BA7517;}',
    '.pc-nav-lane.lane-admin{color:#BA7517;}',
    '.pc-nav-lane-chevron{width:10px;height:10px;display:inline-block;transition:transform 0.15s ease;}',
    '.pc-nav-lane.pc-nav-open .pc-nav-lane-chevron{transform:rotate(180deg);}',
    '.pc-nav-dropdown{position:absolute;top:calc(100% + 8px);left:-8px;background:#fff;border:0.5px solid #d8d8d4;border-radius:8px;min-width:240px;padding:6px 0;box-shadow:0 4px 16px rgba(0,0,0,0.06);display:none;z-index:1001;}',
    '.pc-nav-lane.pc-nav-open .pc-nav-dropdown{display:block;}',
    '.pc-nav-dropdown a{display:block;padding:8px 16px;font-size:13px;font-weight:400;color:#1a1a1a;text-decoration:none;line-height:1.3;}',
    '.pc-nav-dropdown a:hover{background:#f6f6f3;}',
    '.pc-nav-dropdown a.pc-nav-current{background:#f6f6f3;font-weight:500;}',
    '.pc-nav-dropdown a.pc-nav-no-access{color:#b4b2a9;font-style:italic;cursor:not-allowed;pointer-events:none;}',
    '.pc-nav-dropdown a.pc-nav-no-access:hover{background:transparent;}',
    '.pc-nav-no-access-suffix{font-size:11px;color:#b4b2a9;font-style:italic;margin-left:4px;}',
    '.pc-nav-totop{position:fixed;bottom:18px;right:18px;width:42px;height:42px;border-radius:50%;background:#1a1a1a;color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);opacity:0;transform:scale(0.95);pointer-events:none;transition:opacity 0.15s ease,transform 0.15s ease;z-index:950;padding:0;}',
    '.pc-nav-totop.pc-nav-visible{opacity:1;transform:scale(1);pointer-events:auto;}',
    '.pc-nav-totop:hover{transform:scale(1.05);}',
    '.pc-nav-totop svg{width:18px;height:18px;display:block;}',
    '@media (max-width:640px){.pc-nav-ribbon{gap:18px;padding:10px 14px;}.pc-nav-header{padding:0 14px;}.pc-nav-dropdown{min-width:220px;}}'
  ].join('\n');

  // =====================================================================
  // BUILD-TIME helpers
  // =====================================================================
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Determine if current page matches a config href (for highlighting).
  function isCurrentPath(href) {
    var path = window.location.pathname || '/';
    var norm = path.replace(/\/index\.html?$/i, '/');
    if (norm !== '/' && norm.charAt(norm.length - 1) !== '/') norm += '/';
    var hrefNorm = href.replace(/\/index\.html?$/i, '/');
    if (hrefNorm !== '/' && hrefNorm.charAt(hrefNorm.length - 1) !== '/') hrefNorm += '/';
    return norm === hrefNorm;
  }

  // Inline SVG chevron-down (matches the 13px ribbon label sizing)
  var CHEVRON_SVG =
    '<svg class="pc-nav-lane-chevron" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  // Inline SVG up-arrow for the back-to-top button
  var UP_ARROW_SVG =
    '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9 14V4M4 9L9 4L14 9" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  // =====================================================================
  // RENDER — assemble the header + ribbon HTML
  // =====================================================================
  function buildLaneHTML(laneKey, laneLabel, items) {
    

    var dropdownInner = items.map(function (it) {
      var current = isCurrentPath(it.href) ? ' pc-nav-current' : '';
      var slugAnyAttr = (it.slugAny && it.slugAny.length)
        ? ' data-pc-nav-slug-any="' + esc(it.slugAny.join(',')) + '"'
        : '';
      return (
        '<a href="' + esc(it.href) +
        '" data-pc-nav-slug="' + esc(it.slug) + '"' + slugAnyAttr + ' class="pc-nav-link' + current + '">' +
        '<span class="pc-nav-link-label">' + esc(it.label) + '</span>' +
        '</a>'
      );
    }).join('');

    return (
      '<div class="pc-nav-lane lane-' + laneKey + '" data-pc-nav-lane="' + laneKey + '" tabindex="0" role="button" aria-haspopup="true" aria-expanded="false">' +
        esc(laneLabel) + CHEVRON_SVG +
        '<div class="pc-nav-dropdown" role="menu">' + dropdownInner + '</div>' +
      '</div>'
    );
  }

  function buildHeaderHTML() {
    return (
      '<header class="pc-nav-header" id="pc-nav-header">' +
        '<div class="pc-nav-header-left">' +
          '<a href="/" class="pc-nav-wordmark">Popcorn Chez</a>' +
          '<span class="pc-nav-pill">Manager Toolkit</span>' +
        '</div>' +
        '<div class="pc-nav-header-right" id="pc-nav-header-right">' +
          '<span class="pc-nav-user-placeholder">&hellip;</span>' +
        '</div>' +
      '</header>'
    );
  }

  function buildRibbonHTML() {
    return (
      '<nav class="pc-nav-ribbon" id="pc-nav-ribbon" aria-label="Toolkit navigation">' +
        buildLaneHTML('people',      'People',     PC_NAV_CONFIG.people) +
        buildLaneHTML('operations',  'Operations', PC_NAV_CONFIG.operations) +
        buildLaneHTML('dashboards',  'Dashboards', PC_NAV_CONFIG.dashboards) +
        buildLaneHTML('admin',       'Admin',      PC_NAV_CONFIG.admin) +
      '</nav>'
    );
  }

  function buildToTopHTML() {
    return (
      '<button class="pc-nav-totop" id="pc-nav-totop" type="button" aria-label="Back to top" title="Back to top">' +
        UP_ARROW_SVG +
      '</button>'
    );
  }

  // =====================================================================
  // ACCESS — apply greying once pcAuth resolves
  // =====================================================================
  function applyAccessState(user) {
    if (!user) return;
    var isAdmin = (typeof pcAuth !== 'undefined' && typeof pcAuth.isAdmin === 'function') ? pcAuth.isAdmin() : false;
    var access = (user.page_access && Array.isArray(user.page_access)) ? user.page_access : [];

    function hasSlugAccess(slug) {
      if (!slug) return true;
      if (isAdmin) return true;
      return access.indexOf(slug) !== -1;
    }

    // Direct lane links (Dashboards)
    var directs = document.querySelectorAll('.pc-nav-lane[data-pc-nav-direct="1"]');
    for (var i = 0; i < directs.length; i++) {
      var d = directs[i];
      var dSlug = d.getAttribute('data-pc-nav-slug');
      if (!hasSlugAccess(dSlug)) {
        d.classList.add('pc-nav-no-access');
        d.setAttribute('aria-disabled', 'true');
        d.addEventListener('click', function (e) { e.preventDefault(); });
        d.style.opacity = '0.4';
        d.style.cursor = 'not-allowed';
      }
    }

    // Dropdown items
    var links = document.querySelectorAll('.pc-nav-dropdown a[data-pc-nav-slug]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var slug = a.getAttribute('data-pc-nav-slug');
      var slugAnyRaw = a.getAttribute('data-pc-nav-slug-any');
      var granted;
      if (slugAnyRaw) {
        granted = isAdmin;
        var anyList = slugAnyRaw.split(',');
        for (var k = 0; k < anyList.length && !granted; k++) {
          if (access.indexOf(anyList[k].replace(/^\s+|\s+$/g, '')) !== -1) granted = true;
        }
      } else {
        granted = hasSlugAccess(slug);
      }
      if (!granted) {
        a.classList.add('pc-nav-no-access');
        a.setAttribute('aria-disabled', 'true');
        var label = a.querySelector('.pc-nav-link-label');
        if (label && !a.querySelector('.pc-nav-no-access-suffix')) {
          var suffix = document.createElement('span');
          suffix.className = 'pc-nav-no-access-suffix';
          suffix.textContent = '— no access';
          a.appendChild(suffix);
        }
      }
    }
  }

  function applyUserNameToHeader(user) {
    var slot = document.getElementById('pc-nav-header-right');
    if (!slot) return;
    var displayName = (user && (user.display_name || user.email)) || 'Signed in';
    slot.innerHTML =
      '<span class="pc-nav-user">' + esc(displayName) + '</span>' +
      '<button class="pc-nav-signout" type="button" id="pc-nav-signout-btn">Sign out</button>';
    var btn = document.getElementById('pc-nav-signout-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (typeof pcAuth !== 'undefined' && typeof pcAuth.signOut === 'function') {
          pcAuth.signOut();
        }
      });
    }
  }

  // =====================================================================
  // DROPDOWN BEHAVIOR — click to open, click outside to close, Esc to close
  // =====================================================================
  function wireDropdowns() {
    var lanes = document.querySelectorAll('.pc-nav-lane[data-pc-nav-lane]');

    function closeAll() {
      for (var i = 0; i < lanes.length; i++) {
        lanes[i].classList.remove('pc-nav-open');
        lanes[i].setAttribute('aria-expanded', 'false');
      }
    }

    for (var i = 0; i < lanes.length; i++) {
      (function (lane) {
        lane.addEventListener('click', function (e) {
          if (e.target.closest('.pc-nav-dropdown')) return;
          e.stopPropagation();
          var wasOpen = lane.classList.contains('pc-nav-open');
          closeAll();
          if (!wasOpen) {
            lane.classList.add('pc-nav-open');
            lane.setAttribute('aria-expanded', 'true');
          }
        });
        lane.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            var wasOpen = lane.classList.contains('pc-nav-open');
            closeAll();
            if (!wasOpen) {
              lane.classList.add('pc-nav-open');
              lane.setAttribute('aria-expanded', 'true');
            }
          }
        });
      })(lanes[i]);
    }

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.pc-nav-lane')) closeAll();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  // =====================================================================
  // BACK-TO-TOP — fade in past 600px scroll, smooth scroll to top on click
  // =====================================================================
  function wireBackToTop() {
    var btn = document.getElementById('pc-nav-totop');
    if (!btn) return;
    var threshold = 600;
    var visible = false;

    function update() {
      var y = window.scrollY || window.pageYOffset || 0;
      var shouldShow = y > threshold;
      if (shouldShow !== visible) {
        visible = shouldShow;
        btn.classList.toggle('pc-nav-visible', visible);
      }
    }

    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    var ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          update();
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });

    update();
  }

  // =====================================================================
  // INJECTION
  // =====================================================================
  function injectStyles() {
    if (document.getElementById('pc-nav-styles')) return;
    var style = document.createElement('style');
    style.id = 'pc-nav-styles';
    style.appendChild(document.createTextNode(STYLES));
    (document.head || document.documentElement).appendChild(style);
  }

  function injectMarkup() {
    if (document.getElementById('pc-nav-header')) return; // already injected

    // Remove legacy hardcoded header bars on retrofitted pages.
    // Opt-out with <body data-pc-nav-keep-header="1">.
    if (!document.body.getAttribute('data-pc-nav-keep-header')) {
      var firstChild = document.body.firstElementChild;
      while (firstChild && (firstChild.tagName === 'SCRIPT' || firstChild.tagName === 'STYLE')) {
        firstChild = firstChild.nextElementSibling;
      }
      if (firstChild && firstChild.tagName === 'HEADER') {
        firstChild.parentNode.removeChild(firstChild);
      }
    }

    var wrapper = document.createElement('div');
    wrapper.id = 'pc-nav-root';
    wrapper.innerHTML = buildHeaderHTML() + buildRibbonHTML();
    document.body.insertBefore(wrapper, document.body.firstChild);

    var totop = document.createElement('div');
    totop.innerHTML = buildToTopHTML();
    document.body.appendChild(totop.firstChild);
  }

  // =====================================================================
  // BOOT
  // =====================================================================
  function boot() {
    injectStyles();
    injectMarkup();
    wireDropdowns();
    wireBackToTop();

    function applyAuth(user) {
      if (user) {
        applyUserNameToHeader(user);
        applyAccessState(user);
      }
    }

    if (typeof pcAuth === 'undefined') {
      return;
    }

    var attempts = 0;
    var MAX_ATTEMPTS = 50; // 5s
    function tryReadUser() {
      var u = (typeof pcAuth.getUser === 'function') ? pcAuth.getUser() : null;
      if (u) {
        applyAuth(u);
        return;
      }
      if (++attempts < MAX_ATTEMPTS) {
        setTimeout(tryReadUser, 100);
      }
    }
    tryReadUser();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose config for debugging
  window.PC_NAV_CONFIG = PC_NAV_CONFIG;
})();
