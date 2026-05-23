// FlashFire Extraction Engine - Site: JobRight.ai
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'jobright',
    priority: 100,

    match: function (url) {
      return url.hostname === 'jobright.ai' &&
        url.pathname.indexOf('/jobs/info/') === 0;
    },

    extract: function () {
      var u = ns.utils;

      // --- Company Name (7 strategies) ---
      var company = 'Unknown Company';

      // Strategy 1: Direct selector
      var el = u.q('h2.ant-typography[class*="company-row"] span[class*="company-name"]');
      if (el && u.extractText(el)) company = u.extractText(el);

      // Strategy 2: h2 company-row > span company-name
      if (company === 'Unknown Company') {
        var h2 = u.q('h2[class*="company-row"]') ||
          u.q('h2.ant-typography[class*="company-row"]');
        if (!h2) {
          var h2s = u.qa('h2');
          for (var i = 0; i < h2s.length; i++) {
            if (h2s[i].className && h2s[i].className.indexOf('company-row') !== -1) {
              h2 = h2s[i]; break;
            }
          }
        }
        if (h2) {
          el = h2.querySelector('span[class*="company-name"]');
          if (!el) {
            var spans = h2.querySelectorAll('span');
            for (var j = 0; j < spans.length; j++) {
              if (spans[j].className && spans[j].className.indexOf('company-name') !== -1) {
                el = spans[j]; break;
              }
            }
          }
          if (el && u.extractText(el)) company = u.extractText(el);
        }
      }

      // Strategy 3: jobIntroduction section
      if (company === 'Unknown Company') {
        var intro = u.q('[class*="jobIntroduction"]') || u.q('[class*="job-introduction"]');
        if (intro) {
          el = intro.querySelector('span[class*="company-name"]') ||
            intro.querySelector('h2[class*="company-row"] span[class*="company-name"]');
          if (el && u.extractText(el)) company = u.extractText(el);
        }
      }

      // Strategy 4: All company-name spans
      if (company === 'Unknown Company') {
        var allSpans = u.qa('span[class*="company-name"]');
        if (allSpans.length > 0) {
          // Prefer one inside h2[company-row]
          var best = null;
          for (var k = 0; k < allSpans.length; k++) {
            if (allSpans[k].closest && allSpans[k].closest('h2[class*="company-row"]')) {
              best = allSpans[k]; break;
            }
          }
          el = best || allSpans[0];
          if (el && u.extractText(el)) company = u.extractText(el);
        }
      }

      // Strategy 5: h2 company-row, first non-time span
      if (company === 'Unknown Company') {
        var h2Row = u.q('h2[class*="company-row"]');
        if (h2Row) {
          var rowSpans = h2Row.querySelectorAll('span');
          for (var m = 0; m < rowSpans.length; m++) {
            if (rowSpans[m].className.indexOf('publish-time') === -1 &&
              u.extractText(rowSpans[m]) &&
              u.extractText(rowSpans[m]).length < 100) {
              company = u.extractText(rowSpans[m]); break;
            }
          }
        }
      }

      // Strategy 6: Company summary strong tag
      if (company === 'Unknown Company') {
        var summary = u.q('[class*="company-summary"]');
        if (summary) {
          var strong = summary.querySelector('strong');
          if (strong && u.extractText(strong)) company = u.extractText(strong);
        }
      }

      // Strategy 7: Company section header
      if (company === 'Unknown Company') {
        var section = u.q('[id="company"]') || u.q('[class*="companyIntroduction"]');
        if (section) {
          var nameH2 = section.querySelector('h2[class*="companyName"]');
          if (nameH2 && u.extractText(nameH2)) company = u.extractText(nameH2);
        }
      }

      if (!company || company.length > 100) company = 'Unknown Company';

      // --- Job Title ---
      var position = u.firstText([
        'h1.ant-typography',
        '[class*="job-title"]',
        'h1'
      ]) || 'Unknown Position';

      // --- Job Description (HTML) ---
      var description = '';

      // Company summary
      var summaryEl = u.q('[class*="company-summary"] p') || u.q('[class*="company-summary"]');
      if (summaryEl) {
        description += '<div class="company-summary">' +
          u.extractDescriptionHtml(summaryEl) + '</div>';
      }

      // Responsibilities
      var respHeading = null;
      var allH2 = u.qa('h2');
      for (var r = 0; r < allH2.length; r++) {
        if (allH2[r].textContent.toLowerCase().indexOf('responsibilities') !== -1) {
          respHeading = allH2[r]; break;
        }
      }
      if (respHeading) {
        var respSection = respHeading.closest ? respHeading.closest('section') : null;
        if (respSection) {
          var respItems = respSection.querySelectorAll('[class*="listText"]');
          if (respItems.length > 0) {
            description += '<div class="responsibilities"><h3>Responsibilities:</h3><ul>';
            for (var ri = 0; ri < respItems.length; ri++) {
              description += '<li>' + u.extractDescriptionHtml(respItems[ri]) + '</li>';
            }
            description += '</ul></div>';
          }
        }
      }

      // Qualifications
      var qualHeading = null;
      for (var q2 = 0; q2 < allH2.length; q2++) {
        if (allH2[q2].textContent.toLowerCase().indexOf('qualification') !== -1) {
          qualHeading = allH2[q2]; break;
        }
      }
      if (qualHeading) {
        var qualSection = qualHeading.closest ? qualHeading.closest('section') : null;
        if (qualSection) {
          var qualItems = qualSection.querySelectorAll('[class*="listText"]');
          if (qualItems.length > 0) {
            description += '<div class="qualifications"><h3>Qualifications:</h3><ul>';
            for (var qi = 0; qi < qualItems.length; qi++) {
              description += '<li>' + u.extractDescriptionHtml(qualItems[qi]) + '</li>';
            }
            description += '</ul></div>';
          }
        }
      }

      // --- Location & Type ---
      var metaSpans = u.qa('[class*="job-metadata-item"] span');
      var location = metaSpans[0] ? u.extractText(metaSpans[0]) : 'Unknown Location';
      var type = metaSpans[1] ? u.extractText(metaSpans[1]) : 'Unknown Type';

      return {
        data: {
          company: company,
          position: position,
          location: location,
          type: type,
          description: description.trim(),
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: 85,
        layerName: 'jobright'
      };
    }
  });
})();
