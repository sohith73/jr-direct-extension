// FlashFire Extraction Engine - Site: Indeed
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'indeed',
    priority: 100,

    match: function (url) {
      var h = url.hostname;
      if (h.indexOf('indeed.com') === -1) return false;
      return url.pathname.indexOf('/viewjob') !== -1 ||
        url.pathname.indexOf('/jobs') !== -1 ||
        document.querySelector('#jobsearch-ViewjobPaneWrapper') !== null ||
        document.querySelector('.jobsearch-ViewJobLayout--embedded') !== null;
    },

    extract: function () {
      var u = ns.utils;

      // --- Company ---
      var company = u.firstText([
        '[data-company-name="true"]',
        '[data-testid="inlineHeader-companyName"]',
        '.css-19qk8gi .css-1tuvypf',
        '[data-testid="jobsearch-CompanyInfoContainer"] span'
      ]) || 'Unknown Company';

      // --- Position ---
      var position = u.firstText([
        '[data-testid="jobsearch-JobInfoHeader-title"]',
        '.jobsearch-JobInfoHeader-title',
        'h2[data-testid="jobsearch-JobInfoHeader-title"]',
        '.css-zsfb41'
      ]) || 'Unknown Position';

      // Remove "- job post" suffix
      position = position.replace(/\s*-\s*job\s*post\s*$/i, '');

      // --- Description (HTML) ---
      var description = '';
      var descEl = u.q('#jobDescriptionText') ||
        u.q('.jobsearch-JobComponent-description') ||
        u.q('[data-testid="jobsearch-JobComponent-description"]') ||
        u.q('.css-ci04xl') ||
        u.q('.css-19ehp9i') ||
        u.q('.css-19ehp9i.e37uo190') ||
        u.q('[class*="jobsearch-JobComponent-description"]') ||
        u.q('[class*="css-19ehp9i"]');

      if (descEl) {
        description = '<div class="indeed-job-description">' +
          u.extractDescriptionHtml(descEl) + '</div>';
      }

      // Fallback: find largest text block in main content area
      if (!description) {
        var mainContent = u.q('#jobsearch-ViewjobPaneWrapper') ||
          u.q('.jobsearch-ViewJobLayout--embedded') ||
          u.q('[class*="ViewjobPaneWrapper"]');
        if (mainContent) {
          var divs = u.qa('div', mainContent).filter(function (div) {
            var text = div.textContent || '';
            return text.length > 200 && text.length < 5000 &&
              div.querySelectorAll('div').length === 0 &&
              text.indexOf('Apply now') === -1 &&
              text.indexOf('Save job') === -1;
          });
          if (divs.length > 0) {
            var longest = divs.reduce(function (best, cur) {
              return (cur.textContent || '').length > (best.textContent || '').length ? cur : best;
            });
            description = '<div class="indeed-job-description">' +
              u.extractDescriptionHtml(longest) + '</div>';
          }
        }
      }

      // --- Location ---
      var location = u.firstText([
        '[data-testid="inlineHeader-companyLocation"]',
        '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
        '.css-1vysp2z div',
        '#jobLocationText span'
      ]) || 'Unknown Location';

      // --- Job Type ---
      var type = u.firstText([
        '[data-testid="Full-time-tile"] span',
        '[data-testid="Part-time-tile"] span',
        '[data-testid="Contract-tile"] span',
        '.js-match-insights-provider-1vjtffa'
      ]) || 'Unknown Type';

      // --- Salary ---
      var salary = '';
      var salaryEl = u.q('[data-testid*="tile"] span') ||
        u.q('.css-1oc7tea') ||
        u.q('.js-match-insights-provider-1vjtffa');
      if (salaryEl && /[$₹€£¥]/.test(salaryEl.textContent)) {
        salary = u.extractText(salaryEl);
      }

      return {
        data: {
          company: company,
          position: position,
          location: location,
          type: type,
          salary: salary,
          description: description,
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: 85,
        layerName: 'indeed'
      };
    }
  });
})();
