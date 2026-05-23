// FlashFire Extraction Engine - Site: Workday
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'workday',
    priority: 85,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('myworkdayjobs.com') !== -1 ||
        h.indexOf('wd5.myworkdayjobs.com') !== -1 ||
        (h.indexOf('workday.com') !== -1 && url.pathname.indexOf('/job') !== -1) ||
        document.querySelector('[data-automation-id="jobPostingPage"]') !== null;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '[data-automation-id="jobPostingHeader"]',
        '[data-automation-id="job-title"]',
        'h2[class*="job-title"]',
        '[class*="job-title"]',
        'h1'
      ]);

      // --- Company ---
      var company = u.firstText([
        '[data-automation-id="company-name"]',
        '[data-automation-id="organizationName"]'
      ]);
      // Fallback: extract from subdomain (company.wd5.myworkdayjobs.com)
      if (!company) {
        var m = window.location.hostname.match(/^([^.]+)\.wd\d*\./);
        if (m) {
          company = m[1].replace(/-/g, ' ')
            .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
      }

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '[data-automation-id="jobPostingDescription"]',
        '[data-automation-id="job-description"]',
        '.job-description',
        '[class*="jobPostingDescription"]'
      ]);

      // --- Location ---
      var location = u.firstText([
        '[data-automation-id="location"]',
        '[data-automation-id="locations"]',
        '[class*="job-location"]'
      ]);

      // --- Type ---
      var type = u.firstText([
        '[data-automation-id="time"]',
        '[data-automation-id="jobType"]',
        '[class*="job-type"]'
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
        layerConfidence: 80,
        layerName: 'workday'
      };
    }
  });
})();
