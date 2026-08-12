/**
 * Injected into the previewed page by the dev-mode proxy (src/server/preview.ts).
 *
 * It runs inside the project's own page, so it can see what the user points at.
 * Everything it knows travels back to psm over postMessage — it never touches
 * the page's own state beyond a fixed overlay layer, and it only intercepts
 * clicks while psm has explicitly armed it.
 */
(function () {
  if (window.__psmPreviewInspector) return;
  window.__psmPreviewInspector = true;

  var parentOrigin = null; // learned from psm's first message; we only reply there
  var armed = false;
  var hovered = null;
  var pins = []; // { id, n, el }
  var seq = 0;

  /* ---- overlay ---- */
  var layer = document.createElement("div");
  layer.setAttribute("data-psm-preview-layer", "");
  layer.style.cssText =
    "position:fixed;inset:0;z-index:2147483600;pointer-events:none;" +
    "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

  var box = document.createElement("div");
  box.style.cssText =
    "position:absolute;border:2px solid #6ea8fe;border-radius:4px;display:none;" +
    "background:rgba(110,168,254,.14);box-shadow:0 0 0 1px rgba(0,0,0,.35);";

  var label = document.createElement("div");
  label.style.cssText =
    "position:absolute;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;" +
    "white-space:nowrap;background:#6ea8fe;color:#0b1220;font-weight:700;padding:3px 7px;" +
    "border-radius:4px;";

  var hint = document.createElement("div");
  hint.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;" +
    "background:rgba(14,17,22,.94);color:#e6edf3;border:1px solid #263041;border-radius:999px;" +
    "padding:7px 14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.4);";
  hint.textContent = "Dev mode — click anything to note a change · Esc to stop";

  layer.appendChild(box);
  layer.appendChild(label);
  layer.appendChild(hint);

  function mount() {
    if (document.body && !layer.parentNode) document.body.appendChild(layer);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  /* ---- describing an element ---- */
  var INTERESTING = [
    "id", "name", "type", "role", "href", "src", "alt", "title", "placeholder",
    "aria-label", "data-testid", "data-test", "data-cy",
  ];

  function escapeIdent(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&");
  }

  // A selector the AI can grep for. Prefers a unique id, then falls back to
  // tag + a couple of stable-looking classes + nth-of-type for the rest.
  function cssPath(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll("#" + escapeIdent(node.id)).length === 1) {
        parts.unshift("#" + node.id);
        break;
      }
      var part = node.tagName.toLowerCase();
      var classes = [];
      for (var i = 0; i < node.classList.length && classes.length < 2; i++) {
        var name = node.classList[i];
        // skip framework-generated hashes — they change on every build
        if (name.length > 24 || /^(ng-|css-|sc-|jsx-|svelte-|_)/.test(name)) continue;
        classes.push(name);
      }
      if (classes.length) part += "." + classes.map(escapeIdent).join(".");
      var parent = node.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var c = 0; c < parent.children.length; c++) {
          if (parent.children[c].tagName !== node.tagName) continue;
          same++;
          if (parent.children[c] === node) index = same;
        }
        if (same > 1) part += ":nth-of-type(" + index + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function describe(node) {
    var rect = node.getBoundingClientRect();
    var attrs = {};
    for (var i = 0; i < INTERESTING.length; i++) {
      var value = node.getAttribute(INTERESTING[i]);
      if (value) attrs[INTERESTING[i]] = value.slice(0, 120);
    }
    var text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    // the opening tag alone is usually enough for the AI to find the source line
    var html = node.outerHTML || "";
    var open = html.slice(0, html.indexOf(">") + 1) || html.slice(0, 200);
    return {
      tag: node.tagName.toLowerCase(),
      selector: cssPath(node),
      text: text.slice(0, 160),
      attrs: attrs,
      openTag: open.slice(0, 240),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      url: location.href,
      pathname: location.pathname + location.search,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }

  function shortLabel(info) {
    var name = info.tag;
    if (info.attrs["data-testid"]) name += '[data-testid="' + info.attrs["data-testid"] + '"]';
    else if (info.attrs.id) name += "#" + info.attrs.id;
    if (info.text) name += " · " + info.text.slice(0, 40);
    return name;
  }

  /* ---- talking to psm ---- */
  function send(payload) {
    payload.source = "psm-preview";
    try {
      window.parent.postMessage(payload, parentOrigin || "*");
    } catch (e) {}
  }

  function loopback(origin) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(String(origin || ""));
  }

  /* ---- pins ---- */
  function pinNode(pin) {
    if (pin.node) return pin.node;
    var node = document.createElement("div");
    node.style.cssText =
      "position:absolute;min-width:20px;height:20px;padding:0 5px;border-radius:999px;" +
      "background:#db6d28;color:#fff;font-weight:800;font-size:11px;line-height:20px;" +
      "text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.45);";
    node.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      send({ type: "focus", id: pin.id });
    });
    layer.appendChild(node);
    pin.node = node;
    return node;
  }

  function layoutPins() {
    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var node = pinNode(pin);
      if (!pin.el || !pin.el.isConnected) {
        node.style.display = "none";
        continue;
      }
      var rect = pin.el.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        node.style.display = "none";
        continue;
      }
      node.textContent = String(pin.n);
      node.style.display = "block";
      node.style.left = Math.max(2, rect.left - 8) + "px";
      node.style.top = Math.max(2, rect.top - 8) + "px";
    }
  }

  var layoutTimer = null;
  function scheduleLayout() {
    if (layoutTimer) return;
    layoutTimer = requestAnimationFrame(function () {
      layoutTimer = null;
      layoutPins();
      if (hovered && armed) drawHover(hovered);
    });
  }
  window.addEventListener("scroll", scheduleLayout, true);
  window.addEventListener("resize", scheduleLayout);
  // dev servers repaint constantly; a slow tick keeps pins glued on without a rAF loop
  setInterval(function () { if (pins.length) scheduleLayout(); }, 500);

  /* ---- hover + pick ---- */
  function drawHover(node) {
    var rect = node.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    label.style.display = "block";
    label.textContent = shortLabel(describe(node));
    var above = rect.top > 24;
    label.style.left = Math.max(2, rect.left) + "px";
    label.style.top = (above ? rect.top - 22 : rect.bottom + 4) + "px";
  }

  function clearHover() {
    hovered = null;
    box.style.display = "none";
    label.style.display = "none";
  }

  function onMove(event) {
    if (!armed) return;
    var node = event.target;
    if (!node || node.nodeType !== 1 || layer.contains(node)) return;
    if (node === hovered) return;
    hovered = node;
    drawHover(node);
  }

  function onClick(event) {
    if (!armed) return;
    var node = event.target;
    if (layer.contains(node)) return; // pin clicks handle themselves
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    var id = "pick-" + Date.now().toString(36) + "-" + ++seq;
    pins.push({ id: id, n: pins.length + 1, el: node });
    layoutPins();
    send({ type: "pick", id: id, target: describe(node) });
  }

  // swallow the rest of the interaction so the app underneath stays put
  function swallow(event) {
    if (!armed || layer.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("submit", swallow, true);
  document.addEventListener("keydown", function (event) {
    if (armed && event.key === "Escape") {
      event.preventDefault();
      setArmed(false);
      send({ type: "cancel" });
    }
  }, true);

  function setArmed(next) {
    armed = next;
    hint.style.display = next ? "block" : "none";
    document.documentElement.style.cursor = next ? "crosshair" : "";
    if (!next) clearHover();
  }

  /* ---- inbound ---- */
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "psm-devmode") return;
    if (!loopback(event.origin)) return;
    parentOrigin = event.origin;
    if (data.type === "arm") setArmed(true);
    else if (data.type === "disarm") setArmed(false);
    else if (data.type === "sync") {
      // psm owns the note list: drop pins it no longer has, and re-attach the
      // ones it still has. After a reload every element reference is stale, so
      // pins are rebuilt from the selectors psm remembered for them.
      var keep = data.pins || [];
      var next = [];
      for (var k = 0; k < keep.length; k++) {
        var wanted = keep[k];
        var existing = null;
        for (var i = 0; i < pins.length; i++) if (pins[i].id === wanted.id) existing = pins[i];
        if (existing && existing.el && existing.el.isConnected) {
          existing.n = wanted.n;
          next.push(existing);
          continue;
        }
        var found = null;
        try {
          found = wanted.selector ? document.querySelector(wanted.selector) : null;
        } catch (e) {}
        if (!found) continue; // not on this page — nothing to mark
        if (existing) {
          existing.el = found;
          existing.n = wanted.n;
          next.push(existing);
        } else {
          next.push({ id: wanted.id, n: wanted.n, el: found });
        }
      }
      for (var d = 0; d < pins.length; d++) {
        if (next.indexOf(pins[d]) < 0 && pins[d].node) layer.removeChild(pins[d].node);
      }
      pins = next;
      layoutPins();
    } else if (data.type === "flash") {
      for (var f = 0; f < pins.length; f++) {
        if (pins[f].id !== data.id || !pins[f].el || !pins[f].el.isConnected) continue;
        drawHover(pins[f].el);
        pins[f].el.scrollIntoView({ block: "center", behavior: "smooth" });
        clearTimeout(window.__psmFlashTimer);
        window.__psmFlashTimer = setTimeout(clearHover, 1400);
      }
    }
  });

  function announce() {
    mount();
    send({ type: "hello", url: location.href, pathname: location.pathname + location.search, title: document.title });
  }

  announce();
  window.addEventListener("load", announce);
  // SPA route changes: psm shows the live path next to the notes
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    send({ type: "navigate", url: location.href, pathname: location.pathname + location.search });
  }, 600);
})();
