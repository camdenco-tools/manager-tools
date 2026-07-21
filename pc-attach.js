/* ============================================================================
 * pc-attach.js — shared attachment handling for Popcorn Chez manager toolkit
 * ----------------------------------------------------------------------------
 * Created Jul 20, 2026. Owns everything about "what files may be uploaded,
 * how they are labelled, and how a non-image file is viewed in-app."
 *
 * Consumers: /log-sales/, /sales-history/ (and any future upload page).
 *
 * Why a module: Log Sales and Sales History need byte-identical validation and
 * rendering rules. Duplicating them is how the s.name / stand_name bug shipped
 * twice in one day on May 26. One definition, two consumers.
 *
 * Loads standalone — no dependency on pc-auth/pc-nav/pc-catalog. Injects its
 * own CSS and its own viewer overlay on first use, so consuming pages need no
 * CSS patch and no extra markup.
 *
 * Public API (window.pcAttach):
 *   MAX_BYTES                       -> Number, hard client-side size cap
 *   fileExt(nameOrUrl)              -> 'csv' | 'pdf' | 'jpg' | ...
 *   resolveMime(file)               -> best-effort MIME with extension fallback
 *   kindOf(mime, nameOrUrl)         -> 'image' | 'pdf' | 'csv' | 'other'
 *   validate(file, mode)            -> null if OK, else user-facing error string
 *                                      mode: 'image'    (sign-in sheets)
 *                                            'document' (register / units)
 *   tileInnerHtml(mime, name, src)  -> inner HTML for a 64x64 preview tile
 *   humanSize(bytes)                -> '1.4 MB'
 *   viewLocal(file)                 -> open viewer on a pre-submit File object
 *   viewRemote(url, mime, name)     -> open viewer on a stored attachment
 *   parseCsv(text)                  -> Array of row Arrays (RFC-4180-ish)
 * ==========================================================================*/

(function () {
  'use strict';

  var MAX_BYTES = 15 * 1024 * 1024;   // 15MB
  var CSV_ROW_CAP = 300;              // rows rendered in the viewer before truncating

  // ---------------------------------------------------------------- helpers

  function fileExt(nameOrUrl) {
    var s = String(nameOrUrl || '').toLowerCase();
    var q = s.indexOf('?');
    if (q !== -1) s = s.slice(0, q);
    var parts = s.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  function humanSize(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Browsers are inconsistent about CSV. Windows + Excel installed reports
  // 'application/vnd.ms-excel' for a plain .csv; some Android pickers report
  // '' or 'application/octet-stream'. Extension is the tiebreak, not the MIME.
  function resolveMime(file) {
    var t = String((file && file.type) || '').toLowerCase();
    var ext = fileExt(file && file.name);
    if (ext === 'csv') return 'text/csv';
    if (ext === 'pdf') return 'application/pdf';
    if (t) return t;
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'application/octet-stream';
  }

  function kindOf(mime, nameOrUrl) {
    var m = String(mime || '').toLowerCase();
    var ext = fileExt(nameOrUrl);
    if (ext === 'csv' || m.indexOf('csv') !== -1) return 'csv';
    if (ext === 'pdf' || m.indexOf('pdf') !== -1) return 'pdf';
    if (m.indexOf('image/') === 0) return 'image';
    // Legacy rows predate mime_type (NULL). Their URLs carry a real extension.
    if (!m && (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp' || ext === 'gif')) return 'image';
    if (!m) return 'image';   // NULL mime on a legacy row: treat as image
    return 'other';
  }

  function isHeic(file) {
    var ext = fileExt(file && file.name);
    var m = String((file && file.type) || '').toLowerCase();
    return ext === 'heic' || ext === 'heif' || m.indexOf('heic') !== -1 || m.indexOf('heif') !== -1;
  }

  // ------------------------------------------------------------- validation

  // mode 'image'    -> photos only. Sign-in sheets: the AI read requires an image.
  // mode 'document' -> photo, PDF, or CSV. Register / units evidence.
  function validate(file, mode) {
    if (!file) return 'No file selected.';

    // HEIC is rejected in every mode, in every page, always. Project-wide rule.
    if (isHeic(file)) {
      return 'HEIC photos are not supported. On iPhone: Settings \u2192 Camera \u2192 Formats \u2192 Most Compatible, ' +
             'or take a screenshot of the photo and upload that instead.';
    }

    if (file.size > MAX_BYTES) {
      return 'File is too large (' + humanSize(file.size) + '). Maximum is ' + humanSize(MAX_BYTES) + '.';
    }

    var mime = resolveMime(file);
    var kind = kindOf(mime, file.name);

    if (mode === 'image') {
      if (kind !== 'image') return 'Sign-in sheets must be a photo (JPG or PNG).';
      return null;
    }

    if (kind === 'image' || kind === 'pdf' || kind === 'csv') return null;
    return 'Unsupported file type. Use a photo (JPG/PNG), a PDF, or a CSV.';
  }

  // ---------------------------------------------------------------- styling

  var cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    var css =
      '.pca-doc{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:3px;background:#fafafa;cursor:pointer;padding:3px;text-align:center;}' +
      '.pca-doc:hover{background:#f0f0f0;}' +
      '.pca-badge{font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 5px;border-radius:4px;color:#fff;line-height:1;}' +
      '.pca-badge.csv{background:#1D9E75;}' +
      '.pca-badge.pdf{background:#A32D2D;}' +
      '.pca-badge.other{background:#888;}' +
      '.pca-doc-name{font-size:8px;color:#888;line-height:1.15;max-width:100%;overflow:hidden;' +
        'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;}' +
      '.pca-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1200;' +
        'align-items:flex-start;justify-content:center;padding:24px;overflow-y:auto;}' +
      '.pca-ov.open{display:flex;}' +
      '.pca-modal{background:#fff;border-radius:16px;max-width:900px;width:100%;padding:20px 22px;' +
        'box-shadow:0 10px 40px rgba(0,0,0,.2);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '.pca-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;}' +
      '.pca-title{font-size:16px;font-weight:700;color:#1a1a1a;word-break:break-all;}' +
      '.pca-sub{font-size:11px;color:#999;margin-top:2px;}' +
      '.pca-x{background:none;border:none;font-size:22px;line-height:1;color:#999;cursor:pointer;padding:0 4px;}' +
      '.pca-x:hover{color:#1a1a1a;}' +
      '.pca-body{max-height:60vh;overflow:auto;border:1px solid #eee;border-radius:10px;}' +
      '.pca-table{border-collapse:collapse;width:100%;font-size:12px;}' +
      '.pca-table th,.pca-table td{border-bottom:1px solid #f0f0f0;border-right:1px solid #f5f5f5;' +
        'padding:6px 9px;text-align:left;white-space:nowrap;color:#1a1a1a;}' +
      '.pca-table th{background:#fafafa;font-weight:700;position:sticky;top:0;font-size:11px;' +
        'text-transform:uppercase;letter-spacing:.05em;color:#666;z-index:1;}' +
      '.pca-table tr:hover td{background:#fafafa;}' +
      '.pca-num{text-align:right;font-variant-numeric:tabular-nums;}' +
      '.pca-msg{padding:20px;text-align:center;font-size:13px;color:#999;}' +
      '.pca-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap;}' +
      '.pca-note{font-size:11px;color:#999;}' +
      '.pca-dl{font-size:12px;font-weight:600;color:#185FA5;text-decoration:none;padding:7px 13px;' +
        'border:1px solid #B5D4F4;border-radius:9px;background:#E6F1FB;}' +
      '.pca-dl:hover{background:#D4E7F8;}';
    var el = document.createElement('style');
    el.setAttribute('data-pc-attach', '1');
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Inner HTML for a 64x64 tile. Images render as before; documents render as
  // a badge + filename so nothing ever shows a broken-image icon.
  function tileInnerHtml(mime, name, src) {
    injectCss();
    var kind = kindOf(mime, name || src);
    if (kind === 'image') return '<img src="' + esc(src) + '" alt="">';
    var badge = kind === 'csv' ? 'CSV' : kind === 'pdf' ? 'PDF' : 'FILE';
    var cls = kind === 'csv' ? 'csv' : kind === 'pdf' ? 'pdf' : 'other';
    var shortName = String(name || '').split('/').pop() || badge;
    return '<div class="pca-doc">' +
             '<span class="pca-badge ' + cls + '">' + badge + '</span>' +
             '<span class="pca-doc-name">' + esc(shortName) + '</span>' +
           '</div>';
  }

  // -------------------------------------------------------------- CSV parse

  // RFC-4180-ish: handles quoted fields, escaped double-quotes, CRLF, and a
  // UTF-8 BOM (Square exports on Windows carry one and it corrupts the first
  // header cell if not stripped).
  function parseCsv(text) {
    var s = String(text || '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    var rows = [], row = [], cur = '', inQ = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i++; }
          else { inQ = false; }
        } else { cur += c; }
      } else {
        if (c === '"') { inQ = true; }
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c === '\r') { /* swallow */ }
        else { cur += c; }
      }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    // Drop trailing all-empty rows (exports usually end with a newline).
    while (rows.length && rows[rows.length - 1].every(function (v) { return String(v).trim() === ''; })) {
      rows.pop();
    }
    return rows;
  }

  function looksNumeric(v) {
    var t = String(v || '').trim().replace(/^[$(]|[)]$/g, '').replace(/,/g, '');
    return t !== '' && !isNaN(Number(t));
  }

  function csvTableHtml(rows) {
    if (!rows.length) return '<div class="pca-msg">This CSV appears to be empty.</div>';
    var truncated = rows.length > CSV_ROW_CAP + 1;
    var body = rows.slice(1, truncated ? CSV_ROW_CAP + 1 : rows.length);
    var head = rows[0];
    var html = '<table class="pca-table"><thead><tr>';
    head.forEach(function (h) { html += '<th>' + esc(h) + '</th>'; });
    html += '</tr></thead><tbody>';
    body.forEach(function (r) {
      html += '<tr>';
      for (var i = 0; i < head.length; i++) {
        var v = r[i] == null ? '' : r[i];
        html += '<td class="' + (looksNumeric(v) ? 'pca-num' : '') + '">' + esc(v) + '</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (truncated) {
      html += '<div class="pca-msg">Showing the first ' + CSV_ROW_CAP + ' of ' + (rows.length - 1) +
              ' rows. Download the file to see all of it.</div>';
    }
    return html;
  }

  // ----------------------------------------------------------------- viewer

  var ovBuilt = false;
  function buildOverlay() {
    if (ovBuilt) return;
    ovBuilt = true;
    injectCss();
    var ov = document.createElement('div');
    ov.className = 'pca-ov';
    ov.id = 'pca-ov';
    ov.innerHTML =
      '<div class="pca-modal" id="pca-modal">' +
        '<div class="pca-head">' +
          '<div><div class="pca-title" id="pca-title"></div><div class="pca-sub" id="pca-sub"></div></div>' +
          '<button class="pca-x" id="pca-x" title="Close">&times;</button>' +
        '</div>' +
        '<div class="pca-body" id="pca-body"></div>' +
        '<div class="pca-foot">' +
          '<span class="pca-note" id="pca-note"></span>' +
          '<a class="pca-dl" id="pca-dl" target="_blank" rel="noopener">Download original</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeViewer(); });
    document.getElementById('pca-x').addEventListener('click', closeViewer);
    document.getElementById('pca-modal').addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeViewer();
    });
  }

  function closeViewer() {
    var ov = document.getElementById('pca-ov');
    if (ov) ov.classList.remove('open');
  }

  function openShell(title, sub, downloadHref, downloadName) {
    buildOverlay();
    document.getElementById('pca-title').textContent = title || 'Attachment';
    document.getElementById('pca-sub').textContent = sub || '';
    document.getElementById('pca-note').textContent = '';
    var dl = document.getElementById('pca-dl');
    if (downloadHref) {
      dl.style.display = 'inline-block';
      dl.setAttribute('href', downloadHref);
      if (downloadName) dl.setAttribute('download', downloadName);
      else dl.removeAttribute('download');
    } else {
      dl.style.display = 'none';
    }
    document.getElementById('pca-ov').classList.add('open');
    return document.getElementById('pca-body');
  }

  function renderCsvInto(bodyEl, text) {
    var rows;
    try { rows = parseCsv(text); }
    catch (e) { bodyEl.innerHTML = '<div class="pca-msg">Could not read this CSV.</div>'; return; }
    bodyEl.innerHTML = csvTableHtml(rows);
    var note = document.getElementById('pca-note');
    if (note && rows.length) note.textContent = (rows.length - 1) + ' rows \u00b7 ' + rows[0].length + ' columns';
  }

  // Pre-submit File object (not yet uploaded).
  function viewLocal(file) {
    if (!file) return;
    var mime = resolveMime(file);
    var kind = kindOf(mime, file.name);
    var url = URL.createObjectURL(file);

    if (kind === 'pdf' || kind === 'image') {
      window.open(url, '_blank');
      return;
    }
    if (kind !== 'csv') { window.open(url, '_blank'); return; }

    var body = openShell(file.name, humanSize(file.size) + ' \u00b7 not yet uploaded', url, file.name);
    body.innerHTML = '<div class="pca-msg">Reading file\u2026</div>';
    var reader = new FileReader();
    reader.onload = function () { renderCsvInto(body, reader.result); };
    reader.onerror = function () { body.innerHTML = '<div class="pca-msg">Could not read this file.</div>'; };
    reader.readAsText(file);
  }

  // Stored attachment. `url` is the public sale-photos URL.
  function viewRemote(url, mime, name) {
    if (!url) return;
    var kind = kindOf(mime, name || url);
    var label = name || String(url).split('/').pop();

    if (kind === 'pdf' || kind === 'image') {
      window.open(url, '_blank');
      return;
    }
    if (kind !== 'csv') { window.open(url, '_blank'); return; }

    var body = openShell(label, 'Uploaded attachment', url, label);
    body.innerHTML = '<div class="pca-msg">Loading\u2026</div>';
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (t) { renderCsvInto(body, t); })
      .catch(function () {
        body.innerHTML = '<div class="pca-msg">Could not load this file. Use Download original.</div>';
      });
  }

  window.pcAttach = {
    MAX_BYTES: MAX_BYTES,
    fileExt: fileExt,
    humanSize: humanSize,
    resolveMime: resolveMime,
    kindOf: kindOf,
    validate: validate,
    tileInnerHtml: tileInnerHtml,
    parseCsv: parseCsv,
    viewLocal: viewLocal,
    viewRemote: viewRemote,
    closeViewer: closeViewer
  };
})();
