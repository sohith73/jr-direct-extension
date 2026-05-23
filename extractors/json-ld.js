// FlashFire Extraction Engine - Layer 1: JSON-LD (schema.org JobPosting)
// Highest confidence layer. Many job sites include structured data for SEO.
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.jsonLd = {
    name: 'json-ld',
    layerConfidence: 95,

    extract: function () {
      var scripts = ns.utils.qa('script[type="application/ld+json"]');
      var jobPostings = [];

      for (var i = 0; i < scripts.length; i++) {
        try {
          var data = JSON.parse(scripts[i].textContent);
          this._findJobPostings(data, jobPostings);
        } catch (e) {
          // Invalid JSON, skip
        }
      }

      if (jobPostings.length === 0) return null;

      // Pick the most complete JobPosting if multiple exist
      var jp = jobPostings[0];
      if (jobPostings.length > 1) {
        jp = jobPostings.reduce(function (best, current) {
          return Object.keys(current).length > Object.keys(best).length ? current : best;
        });
      }

      var company = this._extractCompany(jp);
      var location = this._extractLocation(jp);
      var type = this._extractType(jp);
      var description = jp.description || '';
      var position = jp.title || jp.name || '';

      // If we got nothing useful, bail
      if (!position && !company && !description) return null;

      return {
        data: {
          company: company,
          position: position,
          location: location,
          type: type,
          description: description,
          url: jp.url || window.location.href,
          scrapedAt: new Date().toISOString()
        },
        layerConfidence: this.layerConfidence,
        layerName: this.name
      };
    },

    // Recursively find all JobPosting objects in JSON-LD data
    _findJobPostings: function (data, result) {
      if (!data || typeof data !== 'object') return;

      if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) {
          this._findJobPostings(data[i], result);
        }
        return;
      }

      // Handle @graph pattern
      if (data['@graph'] && Array.isArray(data['@graph'])) {
        this._findJobPostings(data['@graph'], result);
      }

      // Check if this object is a JobPosting
      var type = data['@type'];
      if (type === 'JobPosting' ||
        (Array.isArray(type) && type.indexOf('JobPosting') !== -1)) {
        result.push(data);
      }
    },

    _extractCompany: function (jp) {
      if (!jp.hiringOrganization) return '';
      var org = jp.hiringOrganization;
      if (typeof org === 'string') return org;
      return org.name || org['@name'] || '';
    },

    _extractLocation: function (jp) {
      var location = '';

      if (jp.jobLocation) {
        var locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation];
        var parts = [];

        for (var i = 0; i < locs.length; i++) {
          var loc = locs[i];
          if (typeof loc === 'string') {
            parts.push(loc);
          } else if (loc.address) {
            var addr = loc.address;
            if (typeof addr === 'string') {
              parts.push(addr);
            } else {
              var addrParts = [
                addr.addressLocality,
                addr.addressRegion,
                addr.addressCountry
              ].filter(Boolean);
              if (addrParts.length) parts.push(addrParts.join(', '));
            }
          } else if (loc.name) {
            parts.push(loc.name);
          }
        }

        location = parts.join(' | ');
      }

      // Handle remote/telecommute
      if (jp.jobLocationType === 'TELECOMMUTE' || jp.applicantLocationRequirements) {
        location = location ? location + ' (Remote)' : 'Remote';
      }

      return location;
    },

    _extractType: function (jp) {
      if (!jp.employmentType) return '';
      var raw = Array.isArray(jp.employmentType)
        ? jp.employmentType.join(', ')
        : String(jp.employmentType);

      return raw
        .replace(/_/g, ' ')
        .replace(/FULL.?TIME/gi, 'Full-time')
        .replace(/PART.?TIME/gi, 'Part-time')
        .replace(/CONTRACT/gi, 'Contract')
        .replace(/INTERN/gi, 'Internship')
        .replace(/TEMPORARY/gi, 'Temporary');
    }
  };
})();
