// FlashFire Extraction Engine - Layer 4: Generic Heuristic DOM Extraction
// Works on any job page by analyzing DOM structure, semantic HTML, and text patterns.
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.generic = {
    name: 'generic',
    layerConfidence: 40,

    extract: function () {
      var u = ns.utils;
      var result = {
        company: '', position: '', location: '', type: '', description: '',
        url: window.location.href, scrapedAt: new Date().toISOString()
      };

      // --- Position extraction ---
      result.position = this._extractPosition(u);

      // --- Company extraction ---
      result.company = this._extractCompany(u);

      // --- Description extraction ---
      result.description = this._extractDescription(u);

      // --- Location extraction ---
      result.location = this._extractLocation(u);

      // --- Type extraction ---
      result.type = this._extractType(u);

      // Return null if we got nothing useful
      if (!result.position && !result.company && !result.description) return null;

      return {
        data: result,
        layerConfidence: this.layerConfidence,
        layerName: this.name
      };
    },

    _extractPosition: function (u) {
      // Strategy 1: Look for microdata/itemprop
      var itempropTitle = u.q('[itemprop="title"]') || u.q('[itemprop="name"][itemtype*="JobPosting"]');
      if (itempropTitle) {
        var t = u.extractText(itempropTitle);
        if (t && t.length >= 3 && t.length <= 150) return t;
      }

      // Strategy 2: h1 analysis
      var h1s = u.qa('h1').map(function (el) {
        return { el: el, text: u.extractText(el) };
      }).filter(function (x) {
        return x.text.length >= 3 && x.text.length <= 150;
      }).filter(function (x) {
        // Exclude navigation/branding h1s
        return !/^\s*(about|company|login|sign\s*in|subscribe|contact|apply\s*now|careers?|home|menu|navigation)\s*$/i.test(x.text);
      });

      if (h1s.length === 1) {
        return h1s[0].text;
      }

      if (h1s.length > 1) {
        // Prefer h1 containing job-related words
        var jobH1 = null;
        for (var i = 0; i < h1s.length; i++) {
          if (/\b(engineer|developer|manager|analyst|designer|director|lead|senior|junior|intern|specialist|coordinator|consultant|architect|administrator|associate|executive|scientist|researcher|recruiter|sales|marketing|product|data|software|devops|mobile|cloud|security)\b/i.test(h1s[i].text)) {
            jobH1 = h1s[i];
            break;
          }
        }
        if (jobH1) return jobH1.text;
        return h1s[0].text;
      }

      // Strategy 3: document.title parsing
      if (document.title) {
        var parts = document.title.split(/\s*[-|–]\s*/);
        if (parts.length >= 1) {
          var candidate = parts[0].trim();
          if (candidate.length >= 3 && candidate.length <= 150) {
            return candidate;
          }
        }
      }

      return '';
    },

    _extractCompany: function (u) {
      // Strategy 1: Microdata/itemprop
      var el = u.q('[itemprop="hiringOrganization"] [itemprop="name"]') ||
        u.q('[itemprop="hiringOrganization"]');
      if (el) {
        var t = u.extractText(el);
        if (t && t.length >= 2 && t.length <= 100) return t;
      }

      // Strategy 2: Common class patterns
      var companySelectors = [
        '[class*="company-name"]', '[class*="companyName"]',
        '[class*="employer-name"]', '[class*="employerName"]',
        '[class*="organization-name"]', '[class*="organizationName"]',
        '[data-company]', '[data-employer]'
      ];
      for (var i = 0; i < companySelectors.length; i++) {
        el = u.q(companySelectors[i]);
        if (el) {
          var text = u.extractText(el);
          if (text && text.length >= 2 && text.length <= 100) return text;
        }
      }

      // Strategy 3: Label-value patterns ("Company: Acme Corp")
      var labels = u.qa('label, span, div, dt, th, strong').filter(function (el) {
        return /^(company|employer|organization|posted\s*by|hiring)\s*:?\s*$/i.test(u.extractText(el));
      }).slice(0, 5);

      for (var j = 0; j < labels.length; j++) {
        var next = labels[j].nextElementSibling;
        if (next) {
          var val = u.extractText(next);
          if (val && val.length >= 2 && val.length <= 100) return val;
        }
        // dt/dd pattern
        if (labels[j].tagName === 'DT') {
          var dd = labels[j].nextElementSibling;
          if (dd && dd.tagName === 'DD') {
            var ddText = u.extractText(dd);
            if (ddText && ddText.length >= 2 && ddText.length <= 100) return ddText;
          }
        }
      }

      return '';
    },

    _extractDescription: function (u) {
      // Strategy 1: Common description selectors
      var descSelectors = [
        '[itemprop="description"]',
        '[class*="job-description"]', '[class*="jobDescription"]',
        '[class*="job-details"]', '[class*="jobDetails"]',
        '[id*="job-description"]', '[id*="jobDescription"]',
        '#jobDescriptionText',
        '[class*="posting-description"]',
        '[class*="role-description"]', '[class*="roleDescription"]'
      ];

      for (var i = 0; i < descSelectors.length; i++) {
        var el = u.q(descSelectors[i]);
        if (el && (el.innerHTML || '').length >= 100) {
          return u.extractDescriptionHtml(el);
        }
      }

      // Strategy 2: Find main content area and pick the largest text block
      var mainEl = u.q('main') || u.q('[role="main"]') || u.q('.content') ||
        u.q('article') || document.body;
      var candidates = u.qa('div, section, article', mainEl).filter(function (el) {
        var text = el.textContent || '';
        // Must be substantial but not the entire page
        return text.length >= 200 && text.length <= 15000 &&
          // Relatively leaf-like (not deeply nested container)
          el.querySelectorAll('div, section, article').length < 5;
      }).sort(function (a, b) {
        return (b.textContent || '').length - (a.textContent || '').length;
      });

      if (candidates.length > 0) {
        return u.extractDescriptionHtml(candidates[0]);
      }

      return '';
    },

    _extractLocation: function (u) {
      var locSelectors = [
        '[itemprop="jobLocation"] [itemprop="address"]',
        '[itemprop="jobLocation"]',
        '[class*="job-location"]', '[class*="jobLocation"]',
        '[class*="work-location"]', '[class*="workLocation"]'
      ];

      for (var i = 0; i < locSelectors.length; i++) {
        var el = u.q(locSelectors[i]);
        if (el) {
          var text = u.extractText(el);
          if (text && text.length >= 2 && text.length <= 150) return text;
        }
      }

      return '';
    },

    _extractType: function (u) {
      var typeSelectors = [
        '[itemprop="employmentType"]',
        '[class*="job-type"]', '[class*="jobType"]',
        '[class*="employment-type"]', '[class*="employmentType"]'
      ];

      for (var i = 0; i < typeSelectors.length; i++) {
        var el = u.q(typeSelectors[i]);
        if (el) {
          var text = u.extractText(el);
          if (text && text.length >= 2 && text.length <= 50) return text;
        }
      }

      return '';
    }
  };
})();
