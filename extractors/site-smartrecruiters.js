// FlashFire Extraction Engine - Site: SmartRecruiters
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'smartrecruiters',
    priority: 85,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('smartrecruiters.com') !== -1 ||
        h.indexOf('jobs.smartrecruiters.com') !== -1;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '.smartrecruitersJobTitle',
        'h1.job-title',
        '[class*="jobTitle"]',
        'h1'
      ]);

      // --- Company ---
      var company = u.firstText([
        '.company-name',
        '[class*="companyName"]',
        '.smartrecruitersCompanyDescription h1'
      ]);
      // Fallback: parse from URL (jobs.smartrecruiters.com/COMPANY/...)
      if (!company) {
        var m = window.location.pathname.match(/^\/([^\/]+)/);
        if (m && m[1] !== 'api' && m[1] !== 'public') {
          company = decodeURIComponent(m[1]).replace(/-/g, ' ')
            .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
      }

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '.job-description',
        '[class*="jobDescription"]',
        '.job-sections',
        '.smartrecruitersJobDescription'
      ]);

      // --- Location ---
      var location = u.firstText([
        '.job-location',
        '[class*="jobLocation"]',
        '.job-info .location'
      ]);

      // --- Type ---
      var type = u.firstText([
        '.job-type',
        '[class*="employmentType"]'
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
        layerName: 'smartrecruiters'
      };
    }
  });
})();
