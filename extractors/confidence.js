// FlashFire Extraction Engine - Confidence Scoring & Field Merging
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.confidence = {
    // Thresholds used by pipeline and panel
    HIGH: 80,
    MEDIUM: 50,
    LOW: 0,

    // Score a single extracted field value (0-100)
    scoreField: function (fieldName, value) {
      if (!value || typeof value !== 'string') return 0;
      var v = value.trim();
      if (!v) return 0;
      if (/^unknown/i.test(v) || v === 'N/A' || v === '-') return 0;

      var score = 40; // Base score for having a non-empty value

      switch (fieldName) {
        case 'company':
          if (v.length >= 2 && v.length <= 100) score += 20;
          if (!/^\d+$/.test(v)) score += 10; // Not purely numeric
          if (/^[A-Z]/.test(v)) score += 10; // Starts with capital
          if (!/[<>{}]/.test(v)) score += 10; // No HTML/code artifacts
          if (v.split(' ').length > 8) score -= 20; // Too sentence-like
          break;

        case 'position':
          if (v.length >= 3 && v.length <= 150) score += 20;
          if (/\b(engineer|developer|manager|analyst|designer|director|lead|senior|junior|intern|specialist|coordinator|consultant|architect|administrator|associate|executive|officer|scientist|researcher|writer|editor|nurse|teacher|accountant|recruiter|sales|marketing|product|data|software|frontend|backend|fullstack|full.stack|devops|sre|qa|test|mobile|cloud|security|network|support|operations|hr|finance|legal)\b/i.test(v)) {
            score += 20;
          }
          if (v.split(' ').length <= 12) score += 10;
          break;

        case 'description':
          if (v.length >= 100) score += 15;
          if (v.length >= 300) score += 10;
          if (v.length >= 800) score += 5;
          if (/\b(requirements?|qualifications?|responsibilities|experience|skills|about|role|position|what you|you will|we are|we're)\b/i.test(v)) {
            score += 15;
          }
          if (/<[a-z][\s\S]*>/i.test(v)) score += 5; // Has HTML structure
          break;

        case 'location':
          if (v.length >= 2 && v.length <= 150) score += 20;
          if (/\b(remote|hybrid|onsite|on-site|office)\b/i.test(v) || /,/.test(v)) {
            score += 20;
          }
          break;

        case 'url':
          if (/^https?:\/\//.test(v)) score += 40;
          break;
      }

      return Math.min(100, Math.max(0, score));
    },

    // Compute aggregate confidence for an extraction result (0-100)
    scoreResult: function (data) {
      if (!data) return 0;

      var weights = {
        company: 25,
        position: 30,
        description: 30,
        location: 10,
        url: 5
      };

      var totalWeight = 0;
      var weightedScore = 0;

      for (var field in weights) {
        if (weights.hasOwnProperty(field)) {
          var fieldScore = this.scoreField(field, data[field]);
          weightedScore += fieldScore * weights[field];
          totalWeight += weights[field];
        }
      }

      return totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
    },

    // Merge multiple extraction results, preferring higher-confidence fields
    // results = [{ data: {...}, layerConfidence: number, layerName: string }, ...]
    mergeResults: function (results) {
      var merged = {
        company: '', position: '', location: '', type: '',
        description: '', url: window.location.href,
        scrapedAt: new Date().toISOString()
      };
      var fieldBestScore = {};
      var layerUsed = {};
      var self = this;

      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (!r || !r.data) continue;

        var fields = ['company', 'position', 'location', 'type', 'description'];
        for (var j = 0; j < fields.length; j++) {
          var field = fields[j];
          var value = r.data[field];
          if (!value || (typeof value === 'string' && !value.trim())) continue;

          // Effective score = field quality * layer trust factor
          var fieldScore = self.scoreField(field, value);
          var effectiveScore = fieldScore * (r.layerConfidence / 100);

          if (!fieldBestScore[field] || effectiveScore > fieldBestScore[field]) {
            fieldBestScore[field] = effectiveScore;
            merged[field] = value;
            layerUsed[field] = r.layerName;
          }
        }

        // Use URL from any layer; prefer canonical job URL, fallback to current page URL
        var layerUrl = (r.data.url || '').trim();
        if (layerUrl && /^https?:\/\//.test(layerUrl)) {
          if (!fieldBestScore['url'] || r.layerConfidence > (fieldBestScore['url'] || 0)) {
            merged.url = layerUrl;
            fieldBestScore['url'] = r.layerConfidence;
          }
        }
      }
      // Always ensure we have a valid URL (current page as final fallback)
      if (!merged.url || !/^https?:\/\//.test(merged.url)) {
        merged.url = window.location.href || '';
      }

      return {
        data: merged,
        confidence: this.scoreResult(merged),
        fieldSources: layerUsed
      };
    }
  };
})();
