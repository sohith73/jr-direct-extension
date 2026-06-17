// MAIN-world script. Runs at document_start before JR's bundle. Patches
// window.fetch + XMLHttpRequest so we can read /swan/recommend/list/jobs
// response bodies and pull the real applyLink per jobId.
//
// We forward {jobId, applyLink, originalUrl} pairs via window.postMessage
// to the ISOLATED-world content script (content-scrape.js), which keeps
// the map in memory and uses it to (a) override the JR-info applyUrl with
// the actual employer URL, and (b) skip LinkedIn-hosted jobs.

(() => {
    if (window.__FF_JRD_INJECT__) return;
    window.__FF_JRD_INJECT__ = true;

    // Match ANY /swan/ endpoint on jobright. We deep-scan the response
    // body for {jobId, applyLink/originalUrl} pairs so we catch list +
    // saved + applied + detail + any future endpoint without code edits.
    const ENDPOINT_RX = /\/swan\//;

    // Shared buffer across MAIN ↔ ISOLATED worlds. ISOLATED-world content
    // script attaches its postMessage listener at document_idle, but MAIN
    // world has already captured the first /swan/recommend/list/jobs call
    // by then — those early entries get dropped without this buffer.
    if (!window.__FF_JRD_BUFFER__) window.__FF_JRD_BUFFER__ = [];

    function dispatch(jobs) {
        if (!Array.isArray(jobs) || jobs.length === 0) return;
        // Always retain in the shared buffer so ISOLATED can drain
        // whatever it missed before its listener attached.
        try { window.__FF_JRD_BUFFER__.push(...jobs); } catch {}
        try {
            window.postMessage({ source: 'FF_JRD_API', jobs }, '*');
        } catch {
            /* ignore */
        }
    }

    // JR object-id pattern (24-hex Mongo).
    const ID_RX = /^[a-f0-9]{24}$/;

    // composeJrDescription: JobRight ships the JD pre-split across summary +
    // responsibilities + must/nice-have + skills + benefits on the SAME
    // jobResult object we already intercept for applyLink. Concatenate them
    // into one plain-text JD so the first-stage judge can score on JobRight's
    // OWN description — no employer-site scrape, no extra network, never hangs.
    // Mirrors scraper/src/adapters/jobright.js → composeDescription.
    const jrStr = (v) => (typeof v === 'string' ? v : '');
    const jrArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
    const jrBullet = (list) => jrArr(list).map((s) => `• ${s.trim()}`).join('\n');
    function composeJrDescription(jr) {
        if (!jr || typeof jr !== 'object') return '';
        const parts = [];
        const summary = jrStr(jr.jobSummary).trim();
        if (summary) parts.push(summary);
        const resp = jrArr(jr.coreResponsibilities);
        if (resp.length) parts.push(`Responsibilities:\n${jrBullet(resp)}`);
        const must = jrArr(jr.qualifications?.mustHave);
        if (must.length) parts.push(`Must have:\n${jrBullet(must)}`);
        const pref = jrArr(jr.qualifications?.preferredHave);
        if (pref.length) parts.push(`Nice to have:\n${jrBullet(pref)}`);
        const skills = jrArr(jr.skillSummaries);
        if (skills.length) parts.push(`Key skills:\n${jrBullet(skills)}`);
        const benefits = jrArr(jr.benefitsSummaries);
        if (benefits.length) parts.push(`Benefits:\n${jrBullet(benefits)}`);
        const why = jrStr(jr.whyJoinUs).trim();
        if (why) parts.push(`Why join us:\n${why}`);
        return parts.join('\n\n').trim();
    }

    // deepWalkForApply: recursively scan an arbitrary JSON tree for any
    // object that has BOTH a 24-hex `jobId` AND at least one of
    // `applyLink`/`originalUrl`. Returns deduped array.
    function deepWalkForApply(node, out, seen, depth) {
        if (depth > 8 || !node) return;
        if (Array.isArray(node)) {
            for (const x of node) deepWalkForApply(x, out, seen, depth + 1);
            return;
        }
        if (typeof node !== 'object') return;
        // Direct JR shape: jobResult { jobId, applyLink, ... }
        const jr = node.jobResult;
        if (jr && typeof jr === 'object' && typeof jr.jobId === 'string' && ID_RX.test(jr.jobId)) {
            if (!seen.has(jr.jobId)) {
                seen.add(jr.jobId);
                out.push({
                    jobId: jr.jobId,
                    applyLink: typeof jr.applyLink === 'string' ? jr.applyLink : '',
                    originalUrl: typeof jr.originalUrl === 'string' ? jr.originalUrl : '',
                    // JobRight's own composed JD — used by the first-stage judge.
                    description: composeJrDescription(jr),
                });
            }
        }
        // Bare shape (e.g. SSR pageProps.dataSource): { jobId, applyLink, ... }
        if (
            typeof node.jobId === 'string'
            && ID_RX.test(node.jobId)
            && (typeof node.applyLink === 'string' || typeof node.originalUrl === 'string' || node.jobSummary)
            && !seen.has(node.jobId)
        ) {
            seen.add(node.jobId);
            out.push({
                jobId: node.jobId,
                applyLink: typeof node.applyLink === 'string' ? node.applyLink : '',
                originalUrl: typeof node.originalUrl === 'string' ? node.originalUrl : '',
                description: composeJrDescription(node),
            });
        }
        // Recurse into every child value.
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') deepWalkForApply(v, out, seen, depth + 1);
        }
    }

    function extractApplyLinks(payloadBody) {
        if (!payloadBody || typeof payloadBody !== 'object') return [];
        const out = [];
        deepWalkForApply(payloadBody, out, new Set(), 0);
        // Drop entries with no usable URL AND no description (avoid clobbering
        // a real one with a blank entry from a related side-call).
        return out.filter((j) => j.applyLink || j.originalUrl || j.description);
    }

    // ---- SSR / __NEXT_DATA__ harvest ------------------------------------
    // Detail pages (/jobs/info/<id>) ship the job in __NEXT_DATA__ with
    // applyLink + originalUrl populated. Scrape it on every nav.
    function harvestNextData() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return;
            const data = JSON.parse(el.textContent || '{}');
            const found = extractApplyLinks(data);
            if (found.length) dispatch(found);
        } catch { /* ignore */ }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', harvestNextData, { once: true });
    } else {
        harvestNextData();
    }
    // Re-harvest when JR client-side routes (Next.js soft-nav).
    let lastHref = location.href;
    setInterval(() => {
        if (location.href !== lastHref) {
            lastHref = location.href;
            setTimeout(harvestNextData, 500);
        }
    }, 1000);

    // ---- fetch patch ----------------------------------------------------
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
        window.fetch = async function patchedFetch(...args) {
            const res = await origFetch.apply(this, args);
            try {
                let url = '';
                if (typeof args[0] === 'string') url = args[0];
                else if (args[0] && typeof args[0].url === 'string') url = args[0].url;
                if (url && ENDPOINT_RX.test(url)) {
                    res.clone().json().then((body) => {
                        dispatch(extractApplyLinks(body));
                    }).catch(() => {});
                }
            } catch { /* never break the page */ }
            return res;
        };
    }

    // ---- XHR patch ------------------------------------------------------
    const OrigXHR = window.XMLHttpRequest;
    if (typeof OrigXHR === 'function') {
        const origOpen = OrigXHR.prototype.open;
        const origSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function patchedOpen(method, url, ...rest) {
            try { this.__ff_jrd_url__ = url; } catch {}
            return origOpen.call(this, method, url, ...rest);
        };
        OrigXHR.prototype.send = function patchedSend(...args) {
            try {
                this.addEventListener('load', () => {
                    try {
                        const u = this.__ff_jrd_url__ || '';
                        if (!u || !ENDPOINT_RX.test(u)) return;
                        const body = JSON.parse(this.responseText || '{}');
                        dispatch(extractApplyLinks(body));
                    } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            return origSend.apply(this, args);
        };
    }
})();
