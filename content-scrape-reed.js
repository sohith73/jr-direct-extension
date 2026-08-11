// Reed (reed.co.uk) scraper. ISOLATED-world content script on reed.co.uk.
//
// Mirrors content-scrape-indeed.js. As the operator scrolls the Reed search
// results, a MutationObserver + scroll handler sweep the visible
// `article[data-qa="job-card"]` cards for {jobId, url}. Then for each NEW job
// it does ONE same-origin fetch of the Reed job page and reads everything from
// the embedded Next.js payload:
//   GET https://www.reed.co.uk/jobs/<slug>/<id>
//   → <script id="__NEXT_DATA__"> … props.pageProps.consolidatedJobDetails.jobDetails
// which gives us in one shot:
//   • description            → full job description (HTML → plain text)
//   • title / jobOwner       → title + employer/recruiter name
//   • jobLocation            → location (+ remote flag + country)
//   • jobSalary.displaySalary→ pay
//   • isRedirect / isEasyApply
//        - isRedirect (external apply) → keep; background opens the Reed
//          /apply page in its live session and follows the redirect to the
//          ORIGINAL employer URL (same pattern as Indeed applystart).
//        - isEasyApply (Reed-hosted apply) → flagged easyApply=true so
//          background skips it per operator policy (direct company-site only).
// (Verified 2026-06-26 via MCP against reed.co.uk.)
//
// Enriched jobs are sent to the service worker as `jrd-cards` (the same
// message JR + Indeed use), so background.js dedups, AI-judges against the
// client summary, resolves the employer URL, and pushes picks unchanged.

(() => {
    if (window.__FF_REED_SCRAPER__) return;
    window.__FF_REED_SCRAPER__ = true;

    const REED_ID_RX = /^\d{5,12}$/;

    const seen = new Set();      // jobIds sent to SW this page load
    const inFlight = new Set();
    const queue = [];
    let activeFetches = 0;
    const MAX_CONCURRENT_JD = 3;
    const JD_MIN_LEN = 80;

    function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // jobId lives in the card's data-id ("job56966105") and again on the title
    // anchor's data-id ("56966105"). Strip the "job" prefix.
    function cardId(card) {
        const raw = String(card.getAttribute('data-id') || '').replace(/^job/i, '').trim();
        return raw;
    }
    // Canonical Reed job URL (query stripped) from the card's title link.
    function cardUrl(card) {
        const a = card.querySelector('a[data-qa="job-card-title"], a.gtmJobTitleClickResponsive');
        const href = a ? a.getAttribute('href') : '';
        if (!href) return '';
        try { return new URL(href, window.location.origin).href.replace(/[?#].*$/, ''); }
        catch { return ''; }
    }

    // Harvest a list of card <article> nodes — works for the live DOM AND for
    // pages fetched in the background (DOMParser nodes support querySelector +
    // getAttribute identically).
    function harvestCards(cards) {
        for (const card of cards) {
            const jobId = cardId(card);
            if (!jobId || !REED_ID_RX.test(jobId)) continue;
            if (seen.has(jobId) || inFlight.has(jobId)) continue;
            if (queue.some((q) => q.jobId === jobId)) continue;
            const url = cardUrl(card);
            if (!url) continue;
            queue.push({
                jobId,
                url,
                title: txt(card.querySelector('a[data-qa="job-card-title"]')),
                company: txt(card.querySelector('[data-element="recruiter"]')),
                location: txt(card.querySelector('[data-qa="job-metadata-location"]')),
                salary: txt(card.querySelector('[data-qa="job-metadata-salary"]')),
            });
        }
        pump();
    }
    function harvestVisible() {
        harvestCards(document.querySelectorAll('article[data-qa="job-card"]'));
    }

    // ---- full detail fetch (same-origin, in-page) -----------------------

    // Cloudflare interstitial / bot wall — the fetched HTML carries no payload.
    function isChallengeHtml(html) {
        return /just a moment|challenge-platform|cf-browser-verification|_cf_chl_opt/i.test(html);
    }

    function normalizeJd(text) {
        return String(text || '')
            .replace(/&nbsp;| /g, ' ')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    // Reed's `description` is an HTML string. Flatten to readable plain text.
    function stripHtml(html) {
        const withBreaks = String(html || '')
            .replace(/<\/(li|p|div|h[1-6]|tr)>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n');
        const tmp = document.createElement('div');
        tmp.innerHTML = withBreaks;
        tmp.querySelectorAll('style, script, noscript, svg, link, template').forEach((n) => n.remove());
        return normalizeJd(tmp.textContent || '');
    }

    function parseNextData(rawHtml) {
        const m = rawHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!m) return null;
        try { return JSON.parse(m[1]); } catch { return null; }
    }

    function buildLocation(loc) {
        const parts = [];
        if (loc?.isRemoteJob) parts.push('Remote');
        if (loc?.locationName) parts.push(loc.locationName);
        if (loc?.countryName && !parts.includes(loc.countryName)) parts.push(loc.countryName);
        return parts.join(', ');
    }

    async function fetchJobDetail(url, attempt = 0) {
        let res;
        try {
            res = await fetch(url, { credentials: 'include' });
        } catch (e) {
            if (attempt < 2) { await delay(600 * (attempt + 1)); return fetchJobDetail(url, attempt + 1); }
            return { ok: false, error: 'NETWORK', message: e.message };
        }
        if (!res.ok) {
            if (attempt < 2) { await delay(600 * (attempt + 1)); return fetchJobDetail(url, attempt + 1); }
            return { ok: false, error: `HTTP_${res.status}` };
        }
        const rawHtml = await res.text();
        if (isChallengeHtml(rawHtml) && attempt < 2) {
            await delay(800 * (attempt + 1));
            return fetchJobDetail(url, attempt + 1);
        }
        const nd = parseNextData(rawHtml);
        const jd = nd?.props?.pageProps?.consolidatedJobDetails?.jobDetails;
        if (!jd) return { ok: false, error: 'NO_NEXT_DATA' };
        return {
            ok: true,
            title: String(jd.title || '').trim(),
            company: String(jd.jobOwner?.profileName || '').trim(),
            location: buildLocation(jd.jobLocation),
            salary: String(jd.jobSalary?.displaySalary || '').trim(),
            description: stripHtml(jd.description),
            // isRedirect = external apply (resolve to employer). isEasyApply =
            // Reed-hosted apply (skip per policy, like Indeed Easy Apply).
            easyApply: jd.isEasyApply === true && jd.isRedirect !== true,
        };
    }

    function send(job) {
        try {
            chrome.runtime.sendMessage({ type: 'jrd-cards', jobs: [job] }).catch(() => {});
        } catch { /* extension reloaded mid-page */ }
    }

    function pump() {
        while (activeFetches < MAX_CONCURRENT_JD && queue.length) {
            const stub = queue.shift();
            if (!stub || seen.has(stub.jobId) || inFlight.has(stub.jobId)) continue;
            inFlight.add(stub.jobId);
            activeFetches += 1;
            fetchJobDetail(stub.url)
                .then((detail) => {
                    if (detail.ok && detail.easyApply) {
                        // Reed-hosted Easy Apply — no external employer URL; skip
                        // per operator policy (background also drops easyApply).
                        return;
                    }
                    const job = {
                        jobId: stub.jobId,
                        source: 'reed',
                        title: (detail.ok ? detail.title : '') || stub.title || '',
                        company: (detail.ok ? detail.company : '') || stub.company || '',
                        location: (detail.ok ? detail.location : '') || stub.location || '',
                        salary: (detail.ok ? detail.salary : '') || stub.salary || '',
                        description: detail.ok ? detail.description : '',
                        // Canonical Reed job URL. Background opens <url>/apply in
                        // the operator's live session and follows the redirect to
                        // the ORIGINAL employer URL before pushing.
                        applyUrl: stub.url,
                        easyApply: false,
                        capturedAt: new Date().toISOString(),
                    };
                    if (!job.title || !job.company) {
                        console.warn('[FF-REED] missing title/company', stub.jobId, detail.error || '');
                    }
                    if (!job.description || job.description.length < JD_MIN_LEN) {
                        console.warn('[FF-REED] thin/empty JD', stub.jobId, detail.error || (detail.description || '').length);
                    }
                    send(job);
                })
                .catch((e) => console.warn('[FF-REED] detail fetch threw', stub.jobId, e?.message))
                .finally(() => {
                    seen.add(stub.jobId);
                    inFlight.delete(stub.jobId);
                    activeFetches -= 1;
                    pump();
                });
        }
    }

    // ---- observers (scroll + DOM mutation) ------------------------------

    function startObservers() {
        harvestVisible();
        const root = document.querySelector('[data-qa="job-card-list"]')
            || document.querySelector('main')
            || document.body;
        let pending = false;
        const obs = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; harvestVisible(); });
        });
        obs.observe(root, { childList: true, subtree: true });

        let scrollTimer = null;
        document.addEventListener('scroll', () => {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(harvestVisible, 200);
        }, { capture: true, passive: true });

        // Safety re-sweep every few seconds (covers late hydration).
        setInterval(harvestVisible, 3000);
    }

    // ---- auto-pagination (Reed is strictly page-based) ------------------
    // Reed renders 26 cards per page and NEVER lazy-loads on scroll — the only
    // way to see more jobs is ?pageno=N. So while a capture is active we fetch
    // the next pages in-page (same-origin, the operator's search + filters are
    // preserved from window.location) and harvest their cards straight into the
    // queue. No tab navigation, no panel flicker — the operator just sits on
    // page 1 and the buffer fills page by page (background enforces the cap).
    let autoPaging = true;
    // Start one past whatever page the operator is on (handles deep-linked SERPs).
    let nextPageNo = (() => {
        const p = parseInt(new URL(window.location.href).searchParams.get('pageno'), 10);
        return (p && p > 0 ? p : 1) + 1;
    })();
    let pagesFetched = 0;
    const MAX_AUTO_PAGES = 100; // safety ceiling (~2600 jobs); the SW cap (buffer / client target) normally stops paging first via atCap
    let pagingBusy = false;

    // Pull capture state from the SW — only auto-page while a capture is active
    // AND the buffer/client cap isn't reached. Otherwise a plain reed.co.uk
    // visit would fire hundreds of fetches, or paging would run past the cap.
    function captureState() {
        return new Promise((resolve) => {
            try { chrome.runtime.sendMessage({ type: 'jrd-is-capturing' }, (r) => resolve(r || {})); }
            catch { resolve({}); }
        });
    }
    // Surface paging progress in the panel so the operator sees it working.
    function reportStatus(text) {
        try { chrome.runtime.sendMessage({ type: 'jrd-reed-status', text }).catch(() => {}); } catch { /* reloaded */ }
    }

    async function fetchSerpPage(pageNo) {
        const u = new URL(window.location.href);
        u.searchParams.set('pageno', String(pageNo));
        try {
            const res = await fetch(u.pathname + u.search, { credentials: 'include' });
            if (!res.ok) return null;
            const html = await res.text();
            if (isChallengeHtml(html)) return null;
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.querySelectorAll('article[data-qa="job-card"]');
        } catch { return null; }
    }

    async function maybePage() {
        if (!autoPaging || pagingBusy) return;
        if (pagesFetched >= MAX_AUTO_PAGES) { autoPaging = false; return; }
        // Let the current backlog drain first so we don't front-load 200 fetches.
        if (queue.length > 6 || activeFetches > 0) return;
        // Claim the single-flight lock BEFORE any await so two interval ticks
        // can't both pass the guard and double-fetch the same page.
        pagingBusy = true;
        try {
            const st = await captureState();
            if (!st.active) return;
            if (st.atCap) { autoPaging = false; reportStatus('Reed: capture cap reached — auto-paging stopped.'); return; }
            reportStatus(`Reed: fetching page ${nextPageNo} — auto-capturing in background, please wait…`);
            const cards = await fetchSerpPage(nextPageNo);
            if (!cards || !cards.length) {
                autoPaging = false;
                reportStatus(`Reed: reached the last results page (${nextPageNo - 1} pages scanned).`);
                return;
            }
            pagesFetched += 1;
            nextPageNo += 1;
            harvestCards(cards);
        } finally {
            pagingBusy = false;
        }
    }
    setInterval(maybePage, 2500);

    // ---- panel injection (iframe loads sidepanel.html) ------------------
    const PANEL_ID = 'ff-reed-panel';
    const PANEL_W = 420;

    function ensurePanelStyles() {
        if (document.getElementById('ff-reed-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'ff-reed-panel-style';
        style.textContent = `
            #${PANEL_ID} {
                position: fixed; top: 0; right: 0;
                width: ${PANEL_W}px; height: 100vh;
                background: #0d1117; z-index: 2147483647;
                box-shadow: -2px 0 12px rgba(0,0,0,0.5);
                overflow: hidden; display: none;
                border-left: 1px solid #30363d;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            }
            #${PANEL_ID}.open { display: block; }
            #${PANEL_ID} > iframe { width: 100%; height: 100%; border: none; background: #0d1117; }
            #${PANEL_ID} > .ff-reed-close {
                position: absolute; top: 8px; right: 8px;
                width: 24px; height: 24px; border-radius: 50%;
                background: #30363d; color: #f0f6fc; border: none;
                font-size: 14px; cursor: pointer; display: flex;
                align-items: center; justify-content: center;
                padding: 0; line-height: 1; z-index: 10;
                opacity: 0.6; transition: opacity 0.15s;
            }
            #${PANEL_ID} > .ff-reed-close:hover { opacity: 1; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
        ensurePanelStyles();
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        const iframe = document.createElement('iframe');
        try { iframe.src = chrome.runtime.getURL('sidepanel.html'); } catch { return null; }
        iframe.title = 'FlashFire Reed → Dashboard';
        panel.appendChild(iframe);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ff-reed-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close panel';
        closeBtn.addEventListener('click', () => panel.classList.remove('open'));
        panel.appendChild(closeBtn);
        (document.body || document.documentElement).appendChild(panel);
        return panel;
    }

    function togglePanel() {
        const panel = document.getElementById(PANEL_ID) || createPanel();
        if (panel) panel.classList.toggle('open');
    }
    function openPanel() {
        const panel = document.getElementById(PANEL_ID) || createPanel();
        if (panel) panel.classList.add('open');
    }

    setTimeout(createPanel, 800);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'jrd-reset-content-cache') {
            seen.clear(); inFlight.clear(); queue.length = 0;
            // Re-arm the pager so a fresh Start re-pages from page 1's neighbour.
            autoPaging = true;
            pagesFetched = 0;
            nextPageNo = (() => {
                const p = parseInt(new URL(window.location.href).searchParams.get('pageno'), 10);
                return (p && p > 0 ? p : 1) + 1;
            })();
            sendResponse({ ok: true });
            return true;
        }
        if (msg.type === 'jrd-content-stats') { sendResponse({ seen: seen.size }); return true; }
        if (msg.type === 'jrd-toggle-panel') { togglePanel(); sendResponse({ ok: true }); return true; }
        if (msg.type === 'jrd-open-panel') { openPanel(); sendResponse({ ok: true }); return true; }
        if (msg.type === 'jrd-set-auto-advance') {
            autoPaging = !!msg.enabled;
            sendResponse({ ok: true, autoAdvance: autoPaging });
            return true;
        }
        return false;
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObservers, { once: true });
    } else {
        startObservers();
    }
})();
