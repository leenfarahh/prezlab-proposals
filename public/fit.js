/*
 * Prezlab Proposals Hub: fit to screen.
 *
 * The hub adds this to every proposal page it serves. The proposal's files are
 * never changed, and pages that already fit the screen are left exactly as they
 * are.
 *
 * When a page's real content is wider than the screen (a desktop-only layout on
 * a phone, or a 1440px design in a smaller browser window), the whole page is
 * scaled down to fit, keeping the design as built:
 *   phones and tablets  through the viewport tag, the way phones show desktop
 *                       websites (pinch to zoom still works)
 *   desktop browsers    through CSS zoom (they ignore the viewport tag)
 *
 * Inside the hub's preview and screen check (a frame), it also posts what it
 * measured to the hub page.
 */
(function () {
  "use strict";
  if (window.__PZ_FIT_STARTED) return;
  window.__PZ_FIT_STARTED = true;

  var cfg = window.__PZ_FIT || {};
  var APPLY = cfg.apply !== false;
  var root = document.documentElement;
  var framed = true;
  try { framed = window.parent !== window; } catch (e) { /* cross-origin parent: framed */ }

  // Wider than this is a stray element (an animation strip, a broken width),
  // not a layout. Shrinking to it would make the page unreadable. Keep in sync
  // with MAX_FIT_WIDTH in lib/fit.ts.
  var MAX_CONTENT = 2560;
  var XHTML = "http://www.w3.org/1999/xhtml";
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, TITLE: 1, BR: 1, WBR: 1 };
  var NO_DESCEND = {
    IFRAME: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IMG: 1, PICTURE: 1, OBJECT: 1,
    EMBED: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1,
  };

  var state = {
    mode: null,        // null, "viewport" or "zoom"
    width: 0,          // layout width the page is fitted to
    natural: null,     // last measurement of the page as built
    meta: null,        // the page's own viewport tag content, restored when re-measuring
    zoomBefore: "",    // the page's own inline zoom, if any
    zoomOnly: framed,  // frames and desktop browsers can't use the viewport tag
    deviceWidth: 0,    // screen width in CSS pixels at the page's own layout
    screenKey: "",
    innerWidth: 0,
    finalSent: false,
  };

  function tolerance(vw) {
    return Math.max(6, vw * 0.015);
  }

  function screenKey() {
    var o = (window.screen && window.screen.orientation && window.screen.orientation.type) || window.orientation || "";
    return window.screen ? window.screen.width + "x" + window.screen.height + ":" + o : String(o);
  }

  function viewportTag() {
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "viewport");
      m.setAttribute("content", "width=device-width, initial-scale=1");
      (document.head || root).appendChild(m);
    }
    return m;
  }

  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }

  function describe(el) {
    if (!el || !el.tagName) return null;
    var name = el.tagName.toLowerCase();
    if (el.id) return (name + "#" + el.id).slice(0, 80);
    var cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return (cls ? name + "." + cls : name).slice(0, 80);
  }

  /*
   * Width of the widest real content, in page pixels. Not counted:
   *  - decorative shapes that bleed off the edge (positioned, no text of their own)
   *  - anything inside a box that clips or scrolls (sliders, marquees, tables
   *    in a scroll box): the designer chose to cut or scroll those
   *  - invisible elements, such as animations that haven't revealed yet
   */
  function measure() {
    var vw = root.clientWidth || window.innerWidth;
    var sx = window.pageXOffset || 0;
    var widest = 0;
    var culprit = null;
    var seen = 0;

    function walk(parent) {
      var kids = parent.children;
      for (var i = 0; i < kids.length; i++) {
        if (++seen > 20000) return;
        var el = kids[i];
        if (SKIP[el.tagName]) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
        var pos = cs.position;
        if (pos === "static" || pos === "relative" || pos === "sticky" || hasOwnText(el)) {
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.right + sx > widest) {
            widest = r.right + sx;
            culprit = el;
          }
        }
        if (el.namespaceURI === XHTML && !NO_DESCEND[el.tagName] && cs.overflowX === "visible") walk(el);
      }
    }

    if (document.body) walk(document.body);
    var content = Math.ceil(widest);
    var fits = content - vw <= tolerance(vw);
    return { viewport: vw, content: Math.max(content, 0), fits: fits, culprit: fits ? null : describe(culprit) };
  }

  function afterFrames(cb) {
    var done = false;
    function go() {
      if (!done) { done = true; cb(); }
    }
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () { window.requestAnimationFrame(go); });
    }
    setTimeout(go, 400);
  }

  /*
   * Lay the page out at `width` and show all of it. Changing the viewport tag
   * after load doesn't reset the zoom level, so the scale is first locked to
   * the fit (maximum = minimum), then unlocked a moment later so readers can
   * pinch to zoom in again.
   */
  function setViewport(width, lock) {
    var s = Math.round((state.deviceWidth / width) * 1000) / 1000;
    viewportTag().setAttribute(
      "content",
      "width=" + width + ", initial-scale=" + s + ", minimum-scale=" + s + (lock ? ", maximum-scale=" + s : "")
    );
  }

  function viewportTo(width, then) {
    state.mode = "viewport";
    state.width = width;
    setViewport(width, true);
    afterFrames(function () {
      if (state.mode !== "viewport" || state.width !== width) return;
      setViewport(width, false);
      if (then) then();
    });
  }

  function zoomTo(width, vw) {
    if (!("zoom" in root.style)) return; // very old browsers: leave the page as built
    if (state.mode !== "zoom") state.zoomBefore = root.style.zoom || "";
    root.style.zoom = String(vw / width);
    state.mode = "zoom";
    state.width = width;
  }

  function fitTo(width, vw) {
    if (!APPLY) return;
    if (state.zoomOnly) {
      zoomTo(width, vw);
      return;
    }
    // Phones and tablets: lay the page out at its own width and let the browser
    // zoom out to show all of it.
    state.deviceWidth = vw;
    state.screenKey = screenKey();
    viewportTo(width, function () {
      if ((root.clientWidth || window.innerWidth) >= width - 2) {
        refineViewport(0);
        return;
      }
      // The browser ignored the viewport tag (desktop): use zoom from now on.
      viewportTag().setAttribute("content", state.meta);
      state.mode = null;
      state.zoomOnly = true;
      zoomTo(width, vw);
      report(false);
    });
  }

  // Content that grows with the layout width needs one or two more passes.
  function refineViewport(pass) {
    var m = measure();
    if (pass < 2 && m.content > state.width + tolerance(state.width) && m.content <= MAX_CONTENT) {
      viewportTo(m.content, function () { refineViewport(pass + 1); });
      return;
    }
    report(false);
  }

  function evaluate(final) {
    state.innerWidth = window.innerWidth;

    if (state.mode === "viewport") {
      // Already laid out at the page's own width: only widen if content grew.
      var current = measure();
      if (current.content > state.width + tolerance(state.width) && current.content <= MAX_CONTENT) {
        viewportTo(current.content);
      }
      report(final);
      return;
    }

    // Measure the page as built. Zoom comes off and goes back on within this
    // one task, so nothing flickers.
    var hadZoom = state.mode === "zoom";
    if (hadZoom) {
      root.style.zoom = state.zoomBefore;
      state.mode = null;
    }
    var m = measure();
    state.natural = m;
    if (!m.fits && m.content <= MAX_CONTENT) {
      if (hadZoom) state.mode = null;
      fitTo(m.content, m.viewport);
    }
    report(final);
  }

  function report(final) {
    if (!framed) return;
    if (final) state.finalSent = true;
    var n = state.natural || { viewport: 0, content: 0, fits: true, culprit: null };
    var scale = state.mode && state.width ? Math.min(1, n.viewport / state.width) : 1;
    try {
      window.parent.postMessage(
        {
          source: "pz-fit",
          final: state.finalSent,
          viewport: n.viewport,
          content: n.content,
          fits: n.fits,
          scale: Math.round(scale * 1000) / 1000,
          culprit: n.culprit,
        },
        "*"
      );
    } catch (e) { /* ignore */ }
  }

  // --- start -----------------------------------------------------------------
  if (framed) {
    // Phones and tablets have overlay scrollbars. In the hub's preview and
    // check frames, hide the desktop scrollbar at those widths so the page gets
    // the same width it would on the device.
    var hideBars = document.createElement("style");
    hideBars.textContent =
      "@media (max-width:1023px){html,body{scrollbar-width:none}" +
      "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}}";
    (document.head || root).appendChild(hideBars);
  }
  state.meta = viewportTag().getAttribute("content") || "width=device-width, initial-scale=1";
  state.screenKey = screenKey();
  evaluate(false);

  // Images, fonts and scripted content can change the layout after first paint.
  function settle() {
    evaluate(false);
    setTimeout(function () { evaluate(true); }, 1200);
  }
  function onLoad() {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(settle, settle);
    } else {
      settle();
    }
  }
  if (document.readyState === "complete") onLoad();
  else window.addEventListener("load", onLoad);

  // Rotating a phone or resizing a window: fit again for the new size.
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.mode === "viewport") {
        // Resizes caused by the fitting itself, or by the address bar showing
        // and hiding, keep the same screen. Only a rotation needs a new fit.
        if (screenKey() === state.screenKey) return;
        // Back to the page's own layout at 100%, measure, and fit again if needed.
        state.mode = null;
        state.screenKey = screenKey();
        viewportTag().setAttribute("content", "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1");
        afterFrames(function () {
          viewportTag().setAttribute("content", state.meta);
          evaluate(state.finalSent);
        });
        return;
      }
      if (window.innerWidth !== state.innerWidth) evaluate(state.finalSent);
    }, 250);
  });

  // The hub page can ask for the latest result at any time.
  window.addEventListener("message", function (e) {
    if (e.data && e.data.source === "pz-fit-ping") report(false);
  });
})();
