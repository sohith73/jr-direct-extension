// FlashFire Extraction Engine - Site: iCIMS
(function () {
  var ns = window.FFExtract;
  if (!ns) return;

  ns.registerSite({
    name: 'icims',
    priority: 85,

    match: function (url) {
      var h = url.hostname;
      return h.indexOf('icims.com') !== -1 ||
        h.indexOf('.icims.') !== -1 ||
        document.querySelector('.iCIMS_MainWrapper') !== null;
    },

    extract: function () {
      var u = ns.utils;

      // --- Position ---
      var position = u.firstText([
        '.iCIMS_Header h1',
        '.jobTitle',
        'h1.iCIMS_JobTitle',
        '.iCIMS_JobHeaderContainer h1',
        'h1'
      ]);

      // --- Company ---
      var company = u.firstText([
        '.iCIMS_CompanyName',
        '.company-name',
        '.iCIMS_Header .company'
      ]);

      // --- Description (HTML) ---
      var description = u.firstHtml([
        '.iCIMS_JobContent',
        '.jobDescription',
        '.iCIMS_InfoMsg_Job',
        '.iCIMS_Expandable_Container'
      ]);

      // --- Location ---
      var location = u.firstText([
        '.iCIMS_JobLocation',
        '.jobLocation',
        '.iCIMS_Header .location'
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
        layerName: 'icims'
      };
    }
  });
})();
