/*
 * Prezlab proposal tracker
 * Injected by the server into every proposal it serves. Captures:
 *   view       page opened (viewport + document size)
 *   click      what was clicked, with page coordinates (heatmap-ready)
 *   scroll     each new 10% scroll-depth milestone
 *   heartbeat  every 15s while the tab is visible (active reading time)
 *   leave      when the tab is hidden or closed
 * Events are batched and sent with sendBeacon to /api/track.
 */
(function () {
  var cfg = window.__PZ_TRACK;
  if (!cfg || !cfg.token || window.__PZ_TRACK_STARTED) return;
  window.__PZ_TRACK_STARTED = true;

  var endpoint = cfg.endpoint || "/api/track";
  var sessionId = uid();
  var queue = [];
  var activeSeconds = 0;
  var maxDepth = 0;
  var lastMilestone = 0;
  var visible = document.visibilityState === "visible";

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function docSize() {
    var d = document.documentElement, b = document.body || d;
    return {
      w: Math.max(d.scrollWidth, b.scrollWidth),
      h: Math.max(d.scrollHeight, b.scrollHeight),
    };
  }

  function push(type, data) {
    queue.push({ type: type, data: data || {}, path: location.pathname });
  }

  function flush() {
    if (!queue.length) return;
    var body = JSON.stringify({
      token: cfg.token,
      visitorId: cfg.visitorId,
      sessionId: sessionId,
      internal: !!cfg.internal,
      referrer: document.referrer || null,
      events: queue.splice(0, 50),
    });
    var blob = new Blob([body], { type: "text/plain" });
    if (!(navigator.sendBeacon && navigator.sendBeacon(endpoint, blob))) {
      try {
        fetch(endpoint, { method: "POST", body: body, keepalive: true, mode: "no-cors" });
      } catch (e) { /* ignore */ }
    }
  }

  function selectorFor(el) {
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      var part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + "#" + el.id); break; }
      var cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(" > ");
  }

  function scrollDepth() {
    var size = docSize();
    var bottom = (window.scrollY || window.pageYOffset) + window.innerHeight;
    return Math.min(100, Math.round((bottom / Math.max(size.h, 1)) * 100));
  }

  // --- view ---
  var size = docSize();
  push("view", {
    vw: window.innerWidth, vh: window.innerHeight,
    docW: size.w, docH: size.h,
    title: (document.title || "").slice(0, 200),
  });
  maxDepth = scrollDepth();

  // --- clicks (capture phase so we see clicks even if the page stops propagation) ---
  document.addEventListener("click", function (e) {
    var target = e.target && e.target.closest ? e.target.closest("a,button,[role=button],input,summary,[onclick]") || e.target : e.target;
    var s = docSize();
    push("click", {
      x: Math.round(e.pageX), y: Math.round(e.pageY),
      xr: +(e.pageX / Math.max(s.w, 1)).toFixed(4),
      yr: +(e.pageY / Math.max(s.h, 1)).toFixed(4),
      vw: window.innerWidth, docW: s.w, docH: s.h,
      selector: target ? selectorFor(target).slice(0, 300) : null,
      tag: target && target.tagName ? target.tagName.toLowerCase() : null,
      text: target ? (target.innerText || target.value || "").trim().slice(0, 80) : null,
      href: target && target.href ? String(target.href).slice(0, 300) : null,
    });
    // Outbound links: send right away in case the page navigates.
    if (target && target.href) flush();
  }, true);

  // --- scroll depth milestones ---
  var scrollTimer = null;
  window.addEventListener("scroll", function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      maxDepth = Math.max(maxDepth, scrollDepth());
      var milestone = Math.floor(maxDepth / 10) * 10;
      if (milestone > lastMilestone) {
        lastMilestone = milestone;
        push("scroll", { maxDepth: maxDepth, activeSeconds: activeSeconds });
      }
    }, 250);
  }, { passive: true });

  // --- active time + heartbeat ---
  setInterval(function () { if (visible) activeSeconds += 1; }, 1000);
  setInterval(function () {
    if (visible) push("heartbeat", { activeSeconds: activeSeconds, maxDepth: maxDepth });
  }, 15000);
  setInterval(flush, 5000);

  function leave() {
    push("leave", { activeSeconds: activeSeconds, maxDepth: maxDepth });
    flush();
  }

  document.addEventListener("visibilitychange", function () {
    visible = document.visibilityState === "visible";
    if (!visible) leave();
  });
  window.addEventListener("pagehide", leave);

  flush();
})();
