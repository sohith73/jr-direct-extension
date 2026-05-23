// FlashFire Extraction Engine - Pipeline Orchestrator
// Runs all extraction layers, merges results with confidence-weighted field selection.
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.pipeline = {
    // Main extraction entry point.
    // Returns: { data, confidence, method, fieldSources, extractionTimeMs }
    extract: function () {
      var startTime = Date.now();
      var results = [];
      var primaryMethod = 'none';

      // Layer 1: JSON-LD (fastest, highest confidence)
      try {
        if (ns.jsonLd) {
          var jsonLdResult = ns.jsonLd.extract();
          if (jsonLdResult) {
            results.push(jsonLdResult);
            primaryMethod = 'json-ld';
          }
        }
      } catch (e) {
        console.warn('[FFExtract] JSON-LD extraction error:', e.message);
      }

      // Layer 2: Meta tags
      try {
        if (ns.metaTags) {
          var metaResult = ns.metaTags.extract();
          if (metaResult) {
            results.push(metaResult);
            if (primaryMethod === 'none') primaryMethod = 'meta-tags';
          }
        }
      } catch (e) {
        console.warn('[FFExtract] Meta tag extraction error:', e.message);
      }

      // Layer 3: Site-specific (try matching extractors)
      try {
        var url = new URL(window.location.href);
        for (var i = 0; i < ns.siteExtractors.length; i++) {
          var extractor = ns.siteExtractors[i];
          try {
            if (extractor.match(url)) {
              var siteResult = extractor.extract(document);
              if (siteResult) {
                results.push(siteResult);
                if (primaryMethod === 'none') primaryMethod = extractor.name;
              }
              break; // Only use the first matching site extractor
            }
          } catch (e) {
            console.warn('[FFExtract] Site extractor "' + extractor.name + '" error:', e.message);
          }
        }
      } catch (e) {
        console.warn('[FFExtract] Site extraction error:', e.message);
      }

      // Layer 4: Generic heuristic (always run as supplement)
      try {
        if (ns.generic) {
          var genericResult = ns.generic.extract();
          if (genericResult) {
            results.push(genericResult);
            if (primaryMethod === 'none') primaryMethod = 'generic';
          }
        }
      } catch (e) {
        console.warn('[FFExtract] Generic extraction error:', e.message);
      }

      // No results from any layer
      if (results.length === 0) {
        return {
          data: null,
          confidence: 0,
          method: 'none',
          fieldSources: {},
          extractionTimeMs: Date.now() - startTime
        };
      }

      // Merge all results using confidence-weighted field selection
      var merged = ns.confidence.mergeResults(results);

      // Cache successful patterns for this domain
      var domain = window.location.hostname;
      if (merged.confidence >= 70 && primaryMethod !== 'generic') {
        ns.cachePattern(domain, { method: primaryMethod });
      }

      return {
        data: merged.data,
        confidence: merged.confidence,
        method: primaryMethod,
        fieldSources: merged.fieldSources,
        extractionTimeMs: Date.now() - startTime
      };
    },

    // Lightweight extraction for scanJobFields (just company + position)
    quickScan: function () {
      var full = this.extract();
      if (!full.data) return { company: null, position: null };
      return {
        company: full.data.company || null,
        position: full.data.position || null,
        confidence: full.confidence
      };
    },

    // Focused content extraction for AI fallback.
    // Returns cleaned, minimal text (not full page HTML).
    extractForAI: function () {
      var textContent = '';

      // First, include whatever structured data we already have as context
      var pipelineResult = this.extract();
      if (pipelineResult.data && pipelineResult.confidence >= 20) {
        var d = pipelineResult.data;
        if (d.position) textContent += 'Job Title: ' + d.position + '\n';
        if (d.company) textContent += 'Company: ' + d.company + '\n';
        if (d.location) textContent += 'Location: ' + d.location + '\n';
        if (d.type) textContent += 'Job Type: ' + d.type + '\n';
        textContent += '\n';
      }

      // Find the most relevant container to extract text from
      var descSelectors = [
        '[itemprop="description"]',
        '[class*="job-description"]', '[class*="jobDescription"]',
        '#job-details', '#jobDescriptionText',
        '.posting-description', '.job-description',
        '.jobs-description__content',
        'main', '[role="main"]', 'article'
      ];

      var focusedEl = null;
      for (var i = 0; i < descSelectors.length; i++) {
        try {
          focusedEl = document.querySelector(descSelectors[i]);
          if (focusedEl && (focusedEl.textContent || '').length >= 100) break;
          focusedEl = null;
        } catch (e) {
          focusedEl = null;
        }
      }

      if (focusedEl) {
        // Use description-only extraction (no a, img, forms) then get plain text
        var safeHtml = ns.utils.extractDescriptionHtml(focusedEl);
        if (safeHtml) {
          var tmp = document.createElement('div');
          tmp.innerHTML = safeHtml;
          textContent += (tmp.innerText || tmp.textContent || '').trim();
        }
        if (!textContent.trim()) {
          textContent += (focusedEl.innerText || focusedEl.textContent || '');
        }
      } else {
        textContent += (document.body.innerText || document.body.textContent || '');
      }

      // Cap at 6000 chars (matching existing behavior for API cost control)
      var maxLen = 6000;
      var trimmed = textContent.trim();
      return trimmed.length > maxLen
        ? trimmed.substring(0, maxLen) + '\n[...truncated]'
        : trimmed;
    }
  };
})();
