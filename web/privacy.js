/* Presentation masking only: real values stay in memory and server requests. */
(() => {
  const KEY = "psm.stream-privacy";
  const REGIONS = [
    "#account-chip", "#workspace-select", "#ws-workspace", "#pairing", "#cloud-body", "#cloud-modal .modal-body",
    "#machines-body", "#procs-body", "#links-list", "#link-browser", "#usage-body",
    "#ws-console", "#ws-depconsole", "#ws-transcript", "#planner-transcript", "#changes-body",
    "#note-body", "#notes-list", "#ws-notes .notes-list", "#web-notes-list", "#ws-webframe", "#ws-session-log",
    "#ws-session-current", "#ws-session-summary", "#ws-ai-activity-text", "#planner-activity-text", "#ws-ai-recap", "#ws-ai-limit", "#planner-loop-message", "#plan-notes",
    "#toast", "#dep-error", "#dep-prep-failure", "#dep-prep-message", "#plan-review", "#plan-editor", ".dep-publication-facts", ".dep-publication-commits", ".dep-row-detail", ".todo-detail",
    ".mon-incidents .dep-row", "#dep-events", "#dep-run-reason", "#dep-secrets", "#dep-connection-setup", "#cap-deployment-connections",
    "#question-body", "#question-title", "#questions-list", "#questions-body", "#cap-preview-body", ".card-desc", ".card-next",
    ".link-path", ".repo-path", ".note-text", ".dep-publication-changes", ".dep-controller-review",
    'a[href^="http"], a[href^="ssh"], a[href^="file"]', "pre", "code", "[data-private]", "[data-stream-private]",
  ].join(",");
  const FIELDS = 'textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="number"]):not(#search), select:not([id^="ws-"]):not([id^="web-"]):not([id^="dep-prep-"]):not(#dep-environment):not(#mon-environment):not(#mon-period)';
  // Unknown free-form secrets are covered by the regions above, rather than guessed.
  const sensitiveText = (text) => /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3}|(?:\/home\/|\/Users\/|\/srv\/|\/etc\/|~\/|[A-Z]:\\)\S+|(?:https?|ssh):\/\/\S+|\b(?:Bearer\s+\S+|gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+|AKIA[A-Z0-9]{16})|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:api[_ -]?key|password|secret|token|business[_ -]?id)\s*[:=]\s*\S+/i.test(text || "");
  let enabled = false;
  try { enabled = localStorage.getItem(KEY) === "on"; } catch { /* storage can be disabled */ }
  document.documentElement.classList.toggle("stream-privacy", enabled);
  const covered = new Set();
  const previousInert = new WeakMap();
  const attributes = new Map();
  let originalTitle = document.title;
  const MASKED_TITLE = "psm · Stream privacy";

  function cover(node) {
    if (!node || node.closest("#stream-privacy") || /^(SCRIPT|STYLE|TITLE|HTML|BODY)$/.test(node.tagName)) return;
    node.setAttribute("data-stream-private", "");
    covered.add(node);
    if (enabled) {
      if (!previousInert.has(node)) previousInert.set(node, !!node.inert);
      node.inert = true;
    }
  }
  function maskAttributes(node) {
    for (const name of ["title", "aria-label", "placeholder"]) {
      const value = node.getAttribute(name);
      if (!value || value === "***" || (!sensitiveText(value) && !node.closest("[data-stream-private]"))) continue;
      let saved = attributes.get(node);
      if (!saved) attributes.set(node, saved = new Map());
      saved.set(name, value);
      node.setAttribute(name, "***");
    }
  }
  function scan(root) {
    if (!enabled || !root) return;
    if (root.nodeType === 3) root = root.parentElement;
    if (!root?.querySelectorAll || root.closest?.("script,style,head,#stream-privacy")) return;
    if (root.matches?.(REGIONS) || root.matches?.(FIELDS)) cover(root);
    for (const node of root.querySelectorAll(`${REGIONS},${FIELDS}`)) cover(node);
    for (const frame of root.querySelectorAll("iframe")) cover(frame.parentElement);
    if (root.tagName === "IFRAME") cover(root.parentElement);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walk.nextNode(); text; text = walk.nextNode()) {
      const parent = text.parentElement;
      if (!parent || parent.closest("script,style,[data-stream-private],#stream-privacy")) continue;
      if (sensitiveText(text.nodeValue)) cover(parent);
    }
    maskAttributes(root);
    for (const node of root.querySelectorAll("[title],[aria-label],[placeholder]")) maskAttributes(node);
  }
  function updateButton() {
    const button = document.getElementById("stream-privacy");
    if (!button) return;
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "Stream privacy: on" : "Stream privacy: off";
    button.title = "Mask private PSM content with ***. Other windows, copied data and exported files are not masked.";
  }
  function setEnabled(value) {
    enabled = !!value;
    document.documentElement.classList.toggle("stream-privacy", enabled);
    try { localStorage.setItem(KEY, enabled ? "on" : "off"); } catch { /* session still works */ }
    if (enabled) {
      for (const node of covered) if (node.isConnected) cover(node); else covered.delete(node);
      originalTitle = document.title;
      document.title = MASKED_TITLE;
      scan(document.body);
    } else {
      for (const node of covered) {
        if (previousInert.has(node)) node.inert = previousInert.get(node);
        previousInert.delete(node);
        if (!node.isConnected) covered.delete(node);
      }
      for (const [node, saved] of attributes) for (const [name, value] of saved) {
        if (node.getAttribute(name) === "***") node.setAttribute(name, value);
      }
      attributes.clear();
      if (document.title === MASKED_TITLE) document.title = originalTitle;
    }
    updateButton();
    document.dispatchEvent(new CustomEvent("psm-privacy-change", { detail: { enabled } }));
  }
  function boot() {
    document.getElementById("stream-privacy")?.addEventListener("click", () => setEnabled(!enabled));
    updateButton();
    if (enabled) { document.title = MASKED_TITLE; scan(document.body); }
    new MutationObserver((changes) => {
      if (!enabled) return;
      if (document.title !== MASKED_TITLE) { originalTitle = document.title; document.title = MASKED_TITLE; }
      const roots = new Set();
      for (const change of changes) {
        if (change.type === "childList") for (const node of change.addedNodes) roots.add(node);
        else roots.add(change.target);
      }
      for (const root of roots) scan(root);
      for (const node of covered) if (!node.isConnected) covered.delete(node);
      for (const node of attributes.keys()) if (!node.isConnected) attributes.delete(node);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["title", "aria-label", "placeholder", "value", "src", "href"] });
    // Selection/context menus cannot expose the original DOM text in covered regions.
    document.addEventListener("copy", (event) => {
      if (!enabled) return;
      event.preventDefault(); event.clipboardData?.setData("text/plain", "***");
    });
  }
  window.PsmPrivacy = { get enabled() { return enabled; }, setEnabled, sensitiveText, cover };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
