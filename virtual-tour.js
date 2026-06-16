/* ============================================================================
 * VIRTUAL TOUR MODULE — free 360° multi-scene panorama tour (Pannellum)
 * ----------------------------------------------------------------------------
 * SELF-CONTAINED + REMOVABLE. This one file owns the whole feature: it injects
 * its own CSS, builds its own modal, lazy-loads Pannellum (only on first open),
 * and exposes a tiny API. Nothing else depends on its internals.
 *
 * TO REMOVE THE VIRTUAL TOUR COMPLETELY:
 *   1. Delete this file (virtual-tour.js).
 *   2. index.html  — delete the <script src="virtual-tour.js"> tag and the 3
 *      lines marked "VIRTUAL TOUR" (button render, click->open, tour scenes).
 *   3. build.js    — delete the block marked "VIRTUAL TOUR" (scanTour + the
 *      gallery exclude + the `tour` field + copying this file to dist).
 *   4. server.js   — delete the block marked "VIRTUAL TOUR" (scanTour + the
 *      gallery exclude + the `tour` field + the two routes).
 * Then it's gone, with no leftovers.
 *
 * PUBLIC API (window.MMVirtualTour):
 *   .open(scenes)   scenes = [{ url, label }]  → opens the tour modal
 *   .close()        → closes it
 *   .isOpen()       → boolean
 *   .available      → true (presence check for the page)
 *
 * DATA: a listing's `tour` array (produced by build.js / server.js from
 * tour-*.jpg images, or a tour/ subfolder, inside the lot folder).
 * ========================================================================== */
(function () {
  'use strict';

  var PANNELLUM_JS  = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js';
  var PANNELLUM_CSS = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css';

  var modal, panoEl, hintEl, viewer = null, hideTimer = null, pannellumPromise = null;

  // ---- self-injected styles (forest-green theme, full backdrop blur) --------
  function injectCSS() {
    if (document.getElementById('mm-vt-style')) return;
    var s = document.createElement('style');
    s.id = 'mm-vt-style';
    s.textContent = [
      '.mm-vt{position:fixed;inset:0;z-index:900;display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .28s ease}',
      '.mm-vt.show{display:flex}',
      '.mm-vt.open{opacity:1}',
      '.mm-vt::before{content:"";position:fixed;inset:0;background:rgba(15,28,20,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);z-index:0}',
      '.mm-vt-card{position:relative;z-index:1;width:min(92vw,1200px);height:min(86vh,800px);border-radius:16px;overflow:hidden;background:var(--pine-deep,#1C3A2A);box-shadow:0 30px 90px -20px rgba(0,0,0,.85)}',
      '.mm-vt-pano{position:absolute;inset:0;width:100%;height:100%;background:#0d1410}',
      '.mm-vt-close{position:fixed;top:16px;right:18px;z-index:3;width:46px;height:46px;border-radius:50%;border:none;background:rgba(255,255,255,.94);color:#1e2a22;font-size:1.7rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px -6px rgba(0,0,0,.6);transition:background .2s,transform .15s}',
      '.mm-vt-close:hover{background:#fff;transform:scale(1.06)}',
      '.mm-vt-close:focus{outline:2px solid #fff;outline-offset:2px}',
      '.mm-vt-hint{position:absolute;left:0;right:0;bottom:0;z-index:2;text-align:center;color:#fff;font:600 .82rem/1.35 "Hanken Grotesk",system-ui,sans-serif;padding:12px 14px 14px;background:linear-gradient(transparent,rgba(0,0,0,.55));pointer-events:none}',
      // "move to next room" hotspot arrow
      '.mm-vt-arrow{height:46px;width:46px;margin:-23px 0 0 -23px;background:var(--clay,#C25A35);border:2px solid #fff;border-radius:50%;box-shadow:0 4px 14px -3px rgba(0,0,0,.6);cursor:pointer;transition:transform .15s,filter .15s}',
      '.mm-vt-arrow:hover{filter:brightness(1.1);transform:scale(1.08)}',
      '.mm-vt-arrow::after{content:"";position:absolute;inset:0;background:no-repeat center/22px url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'white\' stroke-width=\'3\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M5 12h14M13 6l6 6-6 6\'/%3E%3C/svg%3E")}',
      '@media(max-width:600px){.mm-vt-card{width:94vw;height:86vh;border-radius:12px}.mm-vt-close{top:10px;right:10px;width:42px;height:42px;font-size:1.5rem}}'
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    if (modal) return;
    injectCSS();
    modal = document.createElement('div');
    modal.className = 'mm-vt';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '3D virtual tour');
    modal.innerHTML =
      '<button class="mm-vt-close" type="button" aria-label="Close virtual tour">&times;</button>' +
      '<div class="mm-vt-card"><div class="mm-vt-pano" id="mm-vt-pano"></div>' +
      '<div class="mm-vt-hint" id="mm-vt-hint"></div></div>';
    document.body.appendChild(modal);
    panoEl = modal.querySelector('#mm-vt-pano');
    hintEl = modal.querySelector('#mm-vt-hint');
    modal.querySelector('.mm-vt-close').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    // Capture-phase Escape so the tour closes WITHOUT the page also closing the
    // listing modal underneath it (and with no coupling back into the page code).
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); }
    }, true);
  }

  function loadPannellum() {
    if (window.pannellum) return Promise.resolve();
    if (pannellumPromise) return pannellumPromise;
    pannellumPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = PANNELLUM_CSS; document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = PANNELLUM_JS; js.onload = resolve;
      js.onerror = function () { reject(new Error('pannellum failed to load')); };
      document.head.appendChild(js);
    });
    return pannellumPromise;
  }

  function destroyViewer() { if (viewer) { try { viewer.destroy(); } catch (e) {} viewer = null; } }

  // Link the scenes sequentially: each room gets a "next" arrow (front) and a
  // "back" arrow (behind) so you can walk room → room, approximating a tour.
  function buildSceneConfig(scenes) {
    var cfg = {};
    scenes.forEach(function (sc, i) {
      var hot = [];
      if (i + 1 < scenes.length) {
        hot.push({ pitch: -3, yaw: 0, type: 'scene', sceneId: 's' + (i + 1),
          text: 'Go to ' + (scenes[i + 1].label || ('Room ' + (i + 2))), cssClass: 'mm-vt-arrow' });
      }
      if (i - 1 >= 0) {
        hot.push({ pitch: -3, yaw: 180, type: 'scene', sceneId: 's' + (i - 1),
          text: 'Back to ' + (scenes[i - 1].label || ('Room ' + i)), cssClass: 'mm-vt-arrow' });
      }
      cfg['s' + i] = { type: 'equirectangular', panorama: sc.url, autoLoad: true,
        showZoomCtrl: true, hfov: 110, hotSpots: hot };
    });
    return cfg;
  }

  function initViewer(scenes) {
    destroyViewer();
    viewer = window.pannellum.viewer('mm-vt-pano', {
      default: { firstScene: 's0', sceneFadeDuration: 700, autoLoad: true },
      scenes: buildSceneConfig(scenes)
    });
    hintEl.textContent = scenes.length > 1
      ? 'Drag to look around · use the arrow to move to the next room'
      : 'Drag to look around';
  }

  function open(scenes) {
    if (!scenes || !scenes.length) return;
    build();
    clearTimeout(hideTimer);
    modal.classList.add('show');
    requestAnimationFrame(function () { modal.classList.add('open'); });   // smooth fade-in
    document.body.style.overflow = 'hidden';                               // halt background scroll
    hintEl.textContent = 'Loading tour…';
    loadPannellum().then(function () { initViewer(scenes); })
      .catch(function () { hintEl.textContent = 'Sorry — the tour viewer could not load. Please try again.'; });
  }

  function close() {
    if (!modal) return;
    destroyViewer();                                                       // stop rendering immediately
    modal.classList.remove('open');
    hideTimer = setTimeout(function () { modal.classList.remove('show'); }, 300);
    // Only release scroll if no other modal is holding it (the listing modal sets
    // its own overflow:hidden and clears it on its own close).
    if (!document.querySelector('.modal.open, .appt-modal.open')) document.body.style.overflow = '';
  }

  function isOpen() { return !!(modal && modal.classList.contains('show')); }

  window.MMVirtualTour = { open: open, close: close, isOpen: isOpen, available: true };
})();
