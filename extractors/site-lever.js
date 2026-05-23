// FlashFire Extraction Engine - Site: Lever
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'lever',
    priority: 90,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('lever.co') !== -1 || h.indexOf('jobs.lever.co') !== -1;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '.posting-headline h2',
        '.posting-title',
        'h2.posting-title',
        'h1'
      ]);

      // --- Company ---
      var company = '';
      var logoLink = u.q('.main-header-logo a');
      if (logoLink) {
        company = logoLink.getAttribute('aria-label') || u.extractText(logoLink);
      }
      // Fallback: extract from URL path (jobs.lever.co/COMPANY/...)
      if (!company) {
        var m = window.location.pathname.match(/^\/([^\/]+)/);
        if (m) {
          company = m[1].replace(/-/g, ' ')
            .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
      }

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '.posting-description',
        '[data-qa="posting-description"]',
        '.section-wrapper.page-full-width',
        '.posting-page .content'
      ]);

      // --- Location ---
      var location = '';
      var locEl = u.q('.posting-categories .sort-by-commitment') ||
        u.q('.posting-categories .location') ||
        u.q('.posting-headline .posting-categories .workplaceTypes');
      if (locEl) location = u.extractText(locEl);

      if (!location) {
        var catEls = u.qa('.posting-categories .sort-by-commit, .posting-categories span');
        for (var i = 0; i < catEls.length; i++) {
          var text = u.extractText(catEls[i]);
          if (text && /,|remote|hybrid/i.test(text)) {
            location = text;
            break;
          }
        }
      }

      // --- Type ---
      var type = u.firstText([
        '.posting-categories .commitment',
        '.posting-categories .workplaceTypes'
      ]);

      if (!position && !company) return null;

      return {
        data: {
          company: company || '',
          position: position || '',
          location: location || '',
          type: type || '',
          description: description || '',
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: 85,
        layerName: 'lever'
      };
    }
  });
})();
