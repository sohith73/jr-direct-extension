// FlashFire Extraction Engine - Global Namespace
// All extractor modules register on window.FFExtract
(function () {
  if (window.FFExtract) return; // Prevent re-initialization

  window.FFExtract = {
    // Registry for site-specific extractors
    siteExtractors: [],

    // Core layer extractors (set by their respective files)
    jsonLd: null,
    metaTags: null,
    generic: null,
    pipeline: null,
    confidence: null,

    // Register a site-specific extractor
    // config = { name: string, match: function(URL), extract: function(doc), priority: number }
    registerSite: function (config) {
      this.siteExtractors.push(config);
      this.siteExtractors.sort(function (a, b) {
        return (b.priority || 0) - (a.priority || 0);
      });
    },

    // Shared utility functions used across all extractors
    utils: {
      q: function (sel, root) {
        try { return (root || document).querySelector(sel); }
        catch (e) { return null; }
      },
      qa: function (sel, root) {
        try { return Array.from((root || document).querySelectorAll(sel)); }
        catch (e) { return []; }
      },
      // Extract clean text from an element, handling various DOM structures
      extractText: function (element) {
        if (!element) return '';
        var text = (element.textContent || '').trim();
        if (!text && element.childNodes) {
          text = Array.from(element.childNodes)
            .filter(function (node) { return node.nodeType === Node.TEXT_NODE; })
            .map(function (node) { return node.textContent; })
            .join(' ').trim();
        }
        if (!text) text = (element.innerText || '').trim();
        return text.replace(/\s+/g, ' ').trim();
      },
      // Strip class/id/data attributes from HTML for clean storage
      cleanHtml: function (html) {
        if (!html) return '';
        return html
          .replace(/\s*class="[^"]*"/gi, '')
          .replace(/\s*id="[^"]*"/gi, '')
          .replace(/\s*data-[a-z-]*="[^"]*"/gi, '')
          .replace(/\s*style="[^"]*"/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
      },

      // Extract only divs/text content: no links, images, forms, file inputs, or buttons.
      // Keeps structure from div/p/span/li etc. and their text; replaces <a> with plain text.
      extractDescriptionHtml: function (element) {
        if (!element || !element.cloneNode) return '';
        var clone = element.cloneNode(true);
        var doc = clone.ownerDocument || document;

        // Replace <a> with their text content (keep text, drop link)
        var links = clone.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          var a = links[i];
          var text = (a.textContent || '').trim();
          var textNode = doc.createTextNode(text);
          if (a.parentNode) a.parentNode.replaceChild(textNode, a);
        }

        // Remove elements to exclude (select deep-first so removal is safe)
        var excludeSelectors = [
          'img', 'form', 'input', 'button', 'select', 'textarea',
          'script', 'style', 'object', 'embed', 'iframe', 'video', 'audio',
          'noscript', 'svg', 'input[type="file"]'
        ];
        var toRemove = [];
        for (var s = 0; s < excludeSelectors.length; s++) {
          var nodes = clone.querySelectorAll(excludeSelectors[s]);
          for (var n = 0; n < nodes.length; n++) toRemove.push(nodes[n]);
        }
        // Sort by depth (deepest first) so removing doesn't orphan nodes
        toRemove.sort(function (x, y) {
          var dX = 0, dY = 0, p = x.parentNode; while (p) { dX++; p = p.parentNode; }
          p = y.parentNode; while (p) { dY++; p = p.parentNode; }
          return dY - dX;
        });
        for (var r = 0; r < toRemove.length; r++) {
          var node = toRemove[r];
          if (node.parentNode) node.parentNode.removeChild(node);
        }

        return this.cleanHtml(clone.innerHTML);
      },
      // Build a partial-class attribute selector
      byPartialClass: function (part) {
        return '[class*="' + part + '"]';
      },
      // Try multiple selectors in order, return first match's text
      firstText: function (selectors, root) {
        for (var i = 0; i < selectors.length; i++) {
          var el = this.q(selectors[i], root);
          if (el) {
            var text = this.extractText(el);
            if (text) return text;
          }
        }
        return '';
      },
      // Try multiple selectors in order, return first match's HTML (description-only: no a/img/forms)
      firstHtml: function (selectors, root) {
        for (var i = 0; i < selectors.length; i++) {
          var el = this.q(selectors[i], root);
          if (el && (el.innerHTML || '').trim().length >= 50) {
            return this.extractDescriptionHtml(el);
          }
        }
        return '';
      }
    },

    // In-memory pattern cache for unknown domains (per session)
    _patternCache: {},
    cachePattern: function (domain, selectors) {
      this._patternCache[domain] = {
        selectors: selectors,
        cachedAt: Date.now(),
        hitCount: 0
      };
    },
    getCachedPattern: function (domain) {
      var entry = this._patternCache[domain];
      if (entry) {
        entry.hitCount++;
        return entry.selectors;
      }
      return null;
    }
  };
})();
