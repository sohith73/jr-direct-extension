// FlashFire Extraction Engine - Site: Ashby (jobs.ashbyhq.com)
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'ashby',
    priority: 90,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('ashbyhq.com') !== -1 ||
        h.indexOf('jobs.ashbyhq.com') !== -1 ||
        document.querySelector('[data-testid="job-posting"]') !== null;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        'h1[class*="JobPostingHeader"]',
        'h1[class*="ashby-job-posting-brief-title"]',
        'h1',
        '[data-testid="job-title"]',
        'h2[class*="title"]'
      ]);

      // --- Company ---
      // Ashby usually has company logo/name in header or page title
      var company = u.firstText([
        '[class*="CompanyName"]',
        '[class*="company-name"]',
        'header img[alt]',
        '[data-testid="company-name"]'
      ]);
      // Fallback: parse from page title ("Position - Company")
      if (!company && document.title) {
        var m = document.title.match(/[-–—|]\s*(.+?)(?:\s*[-–—|]|$)/);
        if (m) company = m[1].trim();
      }
      // Fallback: parse from OG site_name
      if (!company) {
        var ogSite = document.querySelector('meta[property="og:site_name"]');
        if (ogSite) company = ogSite.getAttribute('content') || '';
      }

      // --- Location ---
      var location = u.firstText([
        '[class*="LocationItem"]',
        '[class*="location"]',
        '[data-testid="job-location"]',
        '.ashby-job-posting-location'
      ]);
      // Fallback: look for location-like text near "Location" label
      if (!location) {
        var labels = document.querySelectorAll('div, span, p, dt');
        for (var i = 0; i < labels.length; i++) {
          var el = labels[i];
          var txt = (el.textContent || '').trim();
          if (txt === 'Location' || txt === 'Locations') {
            var next = el.nextElementSibling;
            if (next) {
              location = (next.textContent || '').trim();
              break;
            }
            var parent = el.parentElement;
            if (parent) {
              var siblings = parent.querySelectorAll('div, span, dd');
              for (var j = 0; j < siblings.length; j++) {
                var sib = siblings[j];
                if (sib !== el && (sib.textContent || '').trim().length > 1) {
                  location = (sib.textContent || '').trim();
                  break;
                }
              }
            }
            if (location) break;
          }
        }
      }

      // --- Employment Type ---
      var type = '';
      var typeLabels = document.querySelectorAll('div, span, p, dt');
      for (var k = 0; k < typeLabels.length; k++) {
        var lbl = typeLabels[k];
        var ltxt = (lbl.textContent || '').trim();
        if (ltxt === 'Employment Type' || ltxt === 'Type') {
          var nxt = lbl.nextElementSibling;
          if (nxt) {
            type = (nxt.textContent || '').trim();
            break;
          }
        }
      }

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '[class*="job-description"]',
        '[class*="JobDescription"]',
        '[data-testid="job-description"]',
        '.ashby-job-posting-description',
        'main [class*="posting"]',
        'main article',
        '#overview'
      ]);
      // Fallback: grab the main content area
      if (!description) {
        var main = document.querySelector('main') || document.querySelector('[role="main"]');
        if (main) {
          description = main.innerHTML || '';
        }
      }

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
        layerConfidence: 82,
        layerName: 'ashby'
      };
    }
  });
})();
