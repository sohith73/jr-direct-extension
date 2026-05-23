// FlashFire Extraction Engine - Site: BambooHR
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'bamboohr',
    priority: 85,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('bamboohr.com') !== -1 || h.indexOf('.bamboohr.') !== -1;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '.job-title-header',
        '.ResumableJob__title',
        'h2.JobDetails__title',
        '[class*="jobTitle"]',
        'h1'
      ]);

      // --- Company ---
      var company = u.firstText([
        '.company-name',
        '.ResumableJob__company',
        '[class*="companyName"]'
      ]);
      // Fallback: parse from subdomain (COMPANY.bamboohr.com)
      if (!company) {
        var m = window.location.hostname.match(/^([^.]+)\.bamboohr/);
        if (m && m[1] !== 'www') {
          company = m[1].replace(/-/g, ' ')
            .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
      }

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '.job-description',
        '.JobDetails__description',
        '[class*="jobDescription"]',
        '.BambooHR-ATS-Jobs-Description'
      ]);

      // --- Location ---
      var location = u.firstText([
        '.job-location',
        '.JobDetails__location',
        '[class*="jobLocation"]'
      ]);

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
        layerName: 'bamboohr'
      };
    }
  });
})();
