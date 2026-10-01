/* Pages on other sites a person has to visit because psm cannot do that work itself.
   House rule: such work links straight to the exact page, opening in a new tab. */
(() => {
  const URLS = /https:\/\/[^\s)"'<>]+/g;
  const tidy = (href) => href.replace(/[.,;:]+$/, "");

  /** What the page is, so the button says where it goes. */
  function label(href) {
    let url;
    try { url = new URL(href); } catch { return "Open link"; }
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "github.com") return `Open ${host}`;
    const path = url.pathname;
    if (/\/settings\/billing$/.test(path)) return "GitHub billing";
    if (/\/settings\/apps\/[^/]+\/permissions$/.test(path)) return "App permissions";
    if (/\/settings\/installations\/\d+$/.test(path)) return "App repositories";
    if (/\/settings\/environments$/.test(path)) return "Repository environments";
    if (/^\/[^/]+\/[^/]+\/settings$/.test(path)) return "Repository settings";
    if (/\/compare\//.test(path)) return "Review changes";
    if (/\/edit\//.test(path)) return "Edit file";
    if (/\/new\//.test(path)) return "Create file";
    return "Open on GitHub";
  }

  /** Every distinct page a message names, in the order it names them. */
  function find(text) {
    const seen = new Set();
    const links = [];
    for (const match of String(text || "").matchAll(URLS)) {
      const href = tidy(match[0]);
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ href, label: label(href) });
    }
    return links;
  }

  /** Show a message with the pages it names as links. */
  function linkify(node, text) {
    const message = String(text || "");
    node.replaceChildren();
    let at = 0;
    for (const match of message.matchAll(URLS)) {
      const href = tidy(match[0]);
      node.append(document.createTextNode(message.slice(at, match.index)));
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = href;
      node.append(link);
      at = match.index + href.length;
    }
    node.append(document.createTextNode(message.slice(at)));
  }

  window.PsmExternalLinks = { find, label, linkify };
})();
