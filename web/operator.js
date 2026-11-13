/* P02a.2: the operator token on the cockpit's own requests.
 *
 * psm writes the token into the page it serves (<meta name="psm-operator">);
 * this adds it as the X-PSM-Operator header to every same-origin fetch, so
 * actions taken in the cockpit carry it and a bare `curl` does not. It is never
 * sent to another origin: not to the hosted page's agent calls (they use the
 * pairing token), not to Werewolf, not to anything else. Loaded first.
 *
 * When psm is restarted with a rotated token, an open page holds the old one
 * and gets 401 `operator_required`; reloading the page picks up the new one. */
(() => {
  const meta = document.querySelector('meta[name="psm-operator"]');
  const token = meta?.getAttribute("content") || "";
  if (!token) return; // the hosted page, or a page psm did not serve
  meta.remove(); // keep it out of the DOM other scripts walk
  let current = token;
  const original = window.fetch.bind(window);
  const sameOrigin = (input) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.origin === location.origin;
    } catch {
      return false;
    }
  };
  window.fetch = (input, init = {}) => {
    if (!sameOrigin(input)) return original(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("X-PSM-Operator", current);
    return original(input, { ...init, headers });
  };
  /** After the operator token is rotated from this page, keep using the new one. */
  window.PsmOperator = { replace(next) { if (typeof next === "string" && next) current = next; } };
})();
