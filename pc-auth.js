/*
  Popcorn Chez — Shared Auth Module (pc-auth.js)
  
  Drop this script into any page to add login gating.
  
  Usage:
    <script src="/pc-auth.js"></script>
    <script>
      pcAuth.require({
        pageSlug: 'log-sales',     // must match slug in user_roles.page_access
        onReady: function(user) {   // called after successful auth + access check
          // user = { id, email, display_name, role, page_access, is_active }
          init();  // your page's init function
        }
      });
    </script>
  
  What it does:
    1. Checks for existing session (localStorage token)
    2. If no session or expired, shows a login overlay
    3. After login, fetches the user's role from user_roles
    4. Checks that the user has the required pageSlug in their page_access array
    5. If admin, always passes (admins have access to everything)
    6. Calls onReady with the user object
    
  The login overlay is injected into the page automatically.
  It uses the same visual style as all other pages.
*/

var pcAuth = (function() {
  var SUPABASE_URL = 'https://aoazlttdjowhlfcksoyl.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvYXpsdHRkam93aGxmY2tzb3lsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNzU4MjMsImV4cCI6MjA5MDg1MTgyM30.tagP_88g7R3d_p7a4Kp0NirnJgkAR5AQQImCt414SJg';

  var accessToken = null;
  var currentUser = null;
  var config = null;
  var authUserId = null;
  var authUserEmail = null;

  function authHeaders() {
    var h = {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json'
    };
    if (accessToken) h['Authorization'] = 'Bearer ' + accessToken;
    return h;
  }

  function injectLoginOverlay() {
    if (document.getElementById('pcAuthOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'pcAuthOverlay';
    overlay.innerHTML = [
      '<div style="max-width:400px;margin:120px auto;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);text-align:center;">',
      '  <h2 style="margin-bottom:8px;font-size:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Sign In</h2>',
      '  <p style="color:#666;margin-bottom:24px;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Sign in to access this page</p>',
      '  <input type="email" id="pcAuthEmail" placeholder="Email address" autocomplete="email"',
      '    style="width:100%;padding:10px 14px;margin-bottom:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;">',
      '  <input type="password" id="pcAuthPassword" placeholder="Password" autocomplete="current-password"',
      '    style="width:100%;padding:10px 14px;margin-bottom:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box;">',
      '  <button id="pcAuthLoginBtn"',
      '    style="width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Sign In</button>',
      '  <div id="pcAuthError" style="color:#dc2626;font-size:13px;margin-top:8px;display:none;"></div>',
      '  <span id="pcAuthForgot" style="color:#2563eb;font-size:13px;margin-top:12px;cursor:pointer;display:inline-block;">Forgot password?</span>',
      '  <div id="pcAuthResetSent" style="color:#16a34a;font-size:13px;margin-top:8px;display:none;">Password reset email sent. Check your inbox.</div>',
      '</div>'
    ].join('\n');

    overlay.style.cssText = 'position:fixed;inset:0;background:#f5f5f5;z-index:10000;overflow-y:auto;';
    document.body.appendChild(overlay);

    document.getElementById('pcAuthLoginBtn').addEventListener('click', doLogin);
    document.getElementById('pcAuthPassword').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doLogin();
    });
    document.getElementById('pcAuthEmail').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') document.getElementById('pcAuthPassword').focus();
    });
    document.getElementById('pcAuthForgot').addEventListener('click', doForgotPassword);
  }

  function removeLoginOverlay() {
    var el = document.getElementById('pcAuthOverlay');
    if (el) el.remove();
  }

  function showError(msg) {
    var el = document.getElementById('pcAuthError');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }

  function doLogin() {
    var email = document.getElementById('pcAuthEmail').value.trim();
    var pw = document.getElementById('pcAuthPassword').value;
    var errEl = document.getElementById('pcAuthError');
    if (errEl) errEl.style.display = 'none';

    if (!email || !pw) {
      showError('Please enter email and password.');
      return;
    }

    fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: pw })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        showError(data.error_description || data.error.message || 'Login failed.');
        return;
      }
      accessToken = data.access_token;
      try {
        localStorage.setItem('sb_access_token', data.access_token);
        localStorage.setItem('sb_refresh_token', data.refresh_token);
      } catch(e) {}
      fetchUserRole();
    })
    .catch(function() {
      showError('Connection error. Please try again.');
    });
  }

  function doForgotPassword() {
    var email = document.getElementById('pcAuthEmail').value.trim();
    var errEl = document.getElementById('pcAuthError');
    var sentEl = document.getElementById('pcAuthResetSent');
    if (errEl) errEl.style.display = 'none';
    if (sentEl) sentEl.style.display = 'none';

    if (!email) {
      showError('Enter your email address first.');
      return;
    }

    fetch(SUPABASE_URL + '/auth/v1/recover', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
    .then(function() {
      if (sentEl) sentEl.style.display = 'block';
    });
  }

  function fetchUserRole() {
    // First get the authenticated user's ID and email
    fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + accessToken }
    })
    .then(function(r) { return r.json(); })
    .then(function(authUser) {
      if (!authUser || !authUser.id) {
        showError('Authentication error. Please sign in again.');
        accessToken = null;
        try { localStorage.removeItem('sb_access_token'); localStorage.removeItem('sb_refresh_token'); } catch(e) {}
        injectLoginOverlay();
        return;
      }
      authUserId = authUser.id;
      authUserEmail = authUser.email;
      // Now fetch the matching user_roles record by auth_id or email
      return fetch(SUPABASE_URL + '/rest/v1/user_roles?select=*&or=(auth_id.eq.' + authUser.id + ',email.eq.' + encodeURIComponent(authUser.email) + ')', {
        headers: authHeaders()
      });
    })
    .then(function(r) { if (r) return r.json(); return null; })
    .then(function(rows) {
      if (!rows || rows.length === 0) {
        showError('No access configured for this account. Contact your admin.');
        accessToken = null;
        try { localStorage.removeItem('sb_access_token'); localStorage.removeItem('sb_refresh_token'); } catch(e) {}
        return;
      }

      var user = rows[0];

      // Auto-link auth_id if matched by email but auth_id was null
      if (!user.auth_id && authUserId) {
        fetch(SUPABASE_URL + '/rest/v1/user_roles?id=eq.' + user.id, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ auth_id: authUserId })
        }).catch(function() {});
        user.auth_id = authUserId;
      }

      if (!user.is_active) {
        showError('Your account has been deactivated. Contact your admin.');
        accessToken = null;
        try { localStorage.removeItem('sb_access_token'); localStorage.removeItem('sb_refresh_token'); } catch(e) {}
        return;
      }

      // Check page access
      if (config.pageSlug && user.role !== 'admin') {
        var hasAccess = (user.page_access || []).indexOf(config.pageSlug) !== -1;
        if (!hasAccess) {
          showError('You don\'t have access to this page. Contact your admin.');
          return;
        }
      }

      currentUser = user;
      removeLoginOverlay();
      if (config.onReady) config.onReady(user);
    })
    .catch(function() {
      showError('Error loading account. Please try again.');
    });
  }

  function tryAutoLogin() {
    try {
      var token = localStorage.getItem('sb_access_token');
      if (!token) {
        injectLoginOverlay();
        return;
      }

      accessToken = token;

      // Verify token is still valid
      fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token }
      })
      .then(function(r) {
        if (r.ok) {
          fetchUserRole();
          return;
        }
        // Token expired, try refresh
        var refresh = localStorage.getItem('sb_refresh_token');
        if (refresh) {
          fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refresh })
          })
          .then(function(r2) { return r2.json(); })
          .then(function(data) {
            if (data.access_token) {
              accessToken = data.access_token;
              try {
                localStorage.setItem('sb_access_token', data.access_token);
                localStorage.setItem('sb_refresh_token', data.refresh_token);
              } catch(e) {}
              fetchUserRole();
            } else {
              accessToken = null;
              injectLoginOverlay();
            }
          })
          .catch(function() {
            accessToken = null;
            injectLoginOverlay();
          });
        } else {
          accessToken = null;
          injectLoginOverlay();
        }
      })
      .catch(function() {
        accessToken = null;
        injectLoginOverlay();
      });
    } catch(e) {
      injectLoginOverlay();
    }
  }

  // Public API
  return {
    require: function(cfg) {
      config = cfg;
      tryAutoLogin();
    },

    // Expose for other pages to use
    getUser: function() { return currentUser; },
    getToken: function() { return accessToken; },
    getRole: function() { return currentUser ? currentUser.role : null; },
    isAdmin: function() { return currentUser && currentUser.role === 'admin'; },
    hasAccess: function(slug) {
      if (!currentUser) return false;
      if (currentUser.role === 'admin') return true;
      return (currentUser.page_access || []).indexOf(slug) !== -1;
    },

    // Auth headers for Supabase API calls on the page
    headers: function() { return authHeaders(); },

    // Sign out
    signOut: function() {
      accessToken = null;
      currentUser = null;
      try {
        localStorage.removeItem('sb_access_token');
        localStorage.removeItem('sb_refresh_token');
      } catch(e) {}
      window.location.reload();
    }
  };
})();
