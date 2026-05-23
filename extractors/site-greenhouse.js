// FlashFire Extraction Engine - Site: Greenhouse
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'greenhouse',
    priority: 90,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('greenhouse.io') !== -1 ||
        h.indexOf('boards.greenhouse.io') !== -1 ||
        document.querySelector('#app_body[class*="greenhouse"]') !== null ||
        document.querySelector('[data-mapped="true"][data-greenhouse]') !== null;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '[data-gh="job-title"]',
        '.posting-title .posting-title__text',
        '.app-title',
        'h1.job-title'
      ]);
      // Fallback: get h1 but filter out garbage (reCAPTCHA, etc)
      if (!position) {
        var h1s = document.querySelectorAll('h1');
        for (var i = 0; i < h1s.length; i++) {
          var text = (h1s[i].textContent || '').trim();
          // Skip reCAPTCHA, empty, or very short h1s
          if (text && text.length > 3 &&
              !/recaptcha|captcha|verify|robot/i.test(text)) {
            position = text;
            break;
          }
        }
      }
      // Fallback: parse from page title ("Position at Company" or "Position - Company")
      if (!position && document.title) {
        var tm = document.title.match(/^(.+?)\s+(?:at|-|–|\|)\s+/i);
        if (tm) position = tm[1].trim();
      }

      // --- Company ---
      var company = u.firstText([
        '.company-name',
        '[data-gh="company-name"]',
        '.posting-title .posting-title__company'
      ]);
      // Fallback: parse from page title ("Position at Company")
      if (!company && document.title) {
        var m = document.title.match(/at\s+(.+?)(?:\s*[-|–]|$)/i);
        if (m) company = m[1].trim();
      }
      // Fallback: parse from URL parameter "for=companyname"
      if (!company) {
        try {
          var params = new URLSearchParams(window.location.search);
          var forParam = params.get('for');
          if (forParam) {
            company = forParam.replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) {
              return c.toUpperCase();
            });
          }
        } catch (e) { /* ignore */ }
      }
      // Fallback: OG meta
      if (!company) {
        var ogSite = document.querySelector('meta[property="og:site_name"]');
        if (ogSite) company = (ogSite.getAttribute('content') || '').trim();
      }

      // --- Description ---
      var description = u.firstHtml([
        '#content',
        '.posting-page .posting-description',
        '[data-gh="job-description"]',
        '.job-description',
        '.job__description'
      ]);
      // Fallback: grab visible body text (exclude scripts, styles, nav)
      if (!description) {
        var bodyText = (document.body.innerText || document.body.textContent || '').trim();
        if (bodyText.length >= 50) {
          description = bodyText.substring(0, 8000);
        }
      }

      // --- Location ---
      var location = u.firstText([
        '.posting-categories .sort-by-commit--location',
        '.location',
        '[data-gh="job-location"]',
        '.posting-title .posting-title__location',
        '.body--metadata .location'
      ]);
      // Fallback: look for "Location:" text pattern on the page
      if (!location) {
        var allText = document.body.innerText || '';
        var locMatch = allText.match(/Location:\s*(.+?)(?:\n|Remote|$)/i);
        if (locMatch) location = locMatch[1].trim();
      }

      if (!position && !company) return null;

      return {
        data: {
          company: company || '',
          position: position || '',
          location: location || '',
          type: '',
          description: description || '',
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: 85,
        layerName: 'greenhouse'
      };
    }
  });
})();
