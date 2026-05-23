// FlashFire Extraction Engine - Layer 2: Meta Tag Extraction
// Extracts from og:title, og:description, twitter cards, and document.title
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.metaTags = {
    name: 'meta-tags',
    layerConfidence: 60,

    extract: function () {
      var title = this._getMeta(['og:title', 'twitter:title']);
      var description = this._getMeta(['og:description', 'twitter:description', 'description']);
      var siteName = this._getMeta(['og:site_name']);
      var pageTitle = document.title || '';

      var company = '';
      var position = '';

      // Parse company and position from title
      // Common patterns: "Position at Company", "Position - Company", "Company | Position"
      var titleToParse = title || pageTitle;
      if (titleToParse) {
        // Pattern: "Position at Company - ..."
        var atMatch = titleToParse.match(/^(.+?)\s+at\s+(.+?)(?:\s*[-|–]|$)/i);
        if (atMatch) {
          position = atMatch[1].trim();
          company = atMatch[2].trim();
        }

        // Pattern: "Position - Company - ..." or "Position | Company"
        if (!position) {
          var parts = titleToParse.split(/\s*[-|–]\s*/);
          if (parts.length >= 2) {
            var part1 = parts[0].trim();
            var part2 = parts[1].trim();

            // If part2 is a known ATS/platform name, it's not the company
            if (/\b(careers?|jobs?|greenhouse|lever|workday|icims|smartrecruiters|linkedin|indeed|bamboohr|hiring)\b/i.test(part2)) {
              position = part1;
            } else {
              position = part1;
              company = part2;
            }
          } else if (parts.length === 1) {
            position = parts[0].trim();
          }
        }

        // Clean position: remove trailing company-like suffixes
        if (position) {
          position = position
            .replace(/\s*[-|–]\s*$/, '')
            .replace(/\s+job\s*$/i, '')
            .trim();
        }
      }

      // Prefer og:site_name as company if we didn't find one
      if (siteName && !company) {
        // Only use site_name if it looks like a company (not "LinkedIn" or "Indeed")
        if (!/\b(linkedin|indeed|glassdoor|google|facebook|twitter)\b/i.test(siteName)) {
          company = siteName;
        }
      }

      // Only return if we found something meaningful
      if (!position && !company && !description) return null;

      return {
        data: {
          company: company,
          position: position,
          location: '',
          type: '',
          description: description,
          url: window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: this.layerConfidence,
        layerName: this.name
      };
    },

    // Try multiple meta tag names/properties, return first non-empty content
    _getMeta: function (names) {
      for (var i = 0; i < names.length; i++) {
        var el = document.querySelector(
          'meta[property="' + names[i] + '"],' +
          'meta[name="' + names[i] + '"]'
        );
        if (el) {
          var content = (el.getAttribute('content') || '').trim();
          if (content) return content;
        }
      }
      return '';
    }
  };
})();
