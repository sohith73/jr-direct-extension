// FlashFire Extraction Engine - Site: LinkedIn
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'linkedin',
    priority: 100,

    match: function (url) {
      var h = url.hostname;
      return (h === 'www.linkedin.com' || h === 'linkedin.com') &&
        (url.pathname.indexOf('/jobs/view/') !== -1 ||
          url.pathname.indexOf('/jobs/collections/') !== -1 ||
          url.search.indexOf('currentJobId=') !== -1);
    },

    extract: function () {
      var u = ns.utils;

      // Scope to main job details to avoid sidebar contamination
      var main = u.q('.jobs-details__main-content') ||
        u.q('.job-details-jobs-unified-top-card__container') ||
        u.q('main') || document.body;

      var qScoped = function (sel) {
        try { return main.querySelector(sel); }
        catch (e) { return u.q(sel); }
      };

      // --- Company ---
      var company = 'Unknown Company';
      var companySelectors = [
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name',
        'a[href*="/company/"][href*="/life"]',
        'a[href*="/company/"]',
        '.artdeco-entity-lockup__title a',
        '.artdeco-entity-lockup__title'
      ];

      for (var i = 0; i < companySelectors.length; i++) {
        var el = qScoped(companySelectors[i]);
        if (!el) el = u.q(companySelectors[i]);
        if (el && main.contains(el)) {
          var text = u.extractText(el);
          if (text && text !== 'Unknown Company') {
            company = text;
            break;
          }
        }
      }

      // Fallback: company name div
      if (company === 'Unknown Company') {
        var cDiv = qScoped('.job-details-jobs-unified-top-card__company-name') ||
          u.q('.job-details-jobs-unified-top-card__company-name');
        if (cDiv && main.contains(cDiv)) {
          var cText = u.extractText(cDiv);
          if (cText) company = cText;
        }
      }

      // --- Position ---
      var position = 'Unknown Position';
      var titleSelectors = [
        '.job-details-jobs-unified-top-card__job-title h1 a',
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__sticky-header h2',
        '.jobs-unified-top-card__job-title h1 a',
        '.jobs-unified-top-card__job-title h1',
        'h1 a[href*="/jobs/view/"]',
        'h1.t-24.t-bold',
        'h1.t-24',
        'h1'
      ];

      for (var j = 0; j < titleSelectors.length; j++) {
        var tEl = qScoped(titleSelectors[j]);
        if (!tEl) tEl = u.q(titleSelectors[j]);
        if (tEl && main.contains(tEl)) {
          var tText = u.extractText(tEl);
          if (tText && tText !== 'Unknown Position') {
            position = tText;
            break;
          }
        }
      }

      // Fallback: title div
      if (position === 'Unknown Position') {
        var tDiv = qScoped('.job-details-jobs-unified-top-card__job-title') ||
          u.q('.job-details-jobs-unified-top-card__job-title');
        if (tDiv && main.contains(tDiv)) {
          var tDivText = u.extractText(tDiv);
          if (tDivText) position = tDivText;
        }
      }

      // --- Description (HTML) ---
      var description = '';
      var descEl = qScoped('.jobs-description__content .jobs-box__html-content') ||
        qScoped('.jobs-description__content') ||
        qScoped('.jobs-box__html-content') ||
        qScoped('#job-details') ||
        qScoped('[class*="job-description"]');

      if (descEl) {
        description = '<div class="linkedin-job-description">' + u.extractDescriptionHtml(descEl) + '</div>';
      }

      // --- Location ---
      var location = 'Unknown Location';
      var locEl = u.q('.job-details-jobs-unified-top-card__tertiary-description-container .tvm__text') ||
        u.q('.job-details-jobs-unified-top-card__tertiary-description-container span') ||
        u.q('[class*="tertiary-description"] span');
      if (locEl) {
        var locText = locEl.textContent.trim();
        var locMatch = locText.match(/^([^·]+)/);
        if (locMatch) location = locMatch[1].trim();
      }

      // --- Job Type ---
      var type = 'Unknown Type';
      var typeEls = u.qa('.job-details-fit-level-preferences button span strong');
      if (typeEls.length > 0) {
        var types = [];
        for (var k = 0; k < typeEls.length; k++) {
          var typeText = u.extractText(typeEls[k]);
          if (typeText) types.push(typeText);
        }
        if (types.length > 0) type = types.join(', ');
      }

      return {
        data: {
          company: company,
          position: position,
          location: location,
          type: type,
          description: description,
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: 85,
        layerName: 'linkedin'
      };
    }
  });
})();
