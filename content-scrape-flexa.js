// Flexa (flexa.careers) scraper. ISOLATED-world content script on flexa.careers.
//
// ── 2026-07 REWRITE — Flexa migrated the jobs page to a Material-UI master/detail
//    layout. The old approach (read the job URL off each card, background-fetch
//    the detail page, parse its JobPosting ld+json) is DEAD, because:
//      • Cards no longer contain a link. A card is now
//            <article data-type="flex-card" data-job-id="<24hex>" data-company-id>
//        holding only a logo, the company name (<p>) and the title (<h2>). There
//        is no href and no slug anywhere on it, so there is nothing to fetch.
//      • The detail page is client-rendered; its initial HTML carries no ld+json
//        and no apply link (both arrive later over an RSC flight that needs the
//        real slug, which the card doesn't expose).
//      • "Load More" is gone. Results are a HORIZONTAL infinite-scroll strip.
//
//    What DID survive is a preview panel:
//        <div data-type="preview-panel" data-job-id="<24hex>">
//    Selecting (clicking) a card swaps this panel to that job and renders, inline
//    and fully, everything we need:
//        • <h1>                    → title
//        • a[href*="/companies/"]  → company (aria-label "View <Company>")
//        • a[data-type="apply-link"] → the ORIGINAL employer apply URL
//              (Lever / Greenhouse / Workday / Pinpoint / company careers site …)
//        • "Location: …" text      → location
//        • the block between "Job Description" and "Other jobs you might like" → JD
//    A programmatic .click() updates the panel WITHOUT moving the operator's
//    viewport (verified via MCP against the live site, 2026-07-28).
//
//    So the new flow is: harvest cards from the horizontal strip → for each new
//    card, click it, wait for the panel to show that job, read the fields off the
//    panel → send. Enrichment is necessarily SEQUENTIAL now (one shared panel),
//    where it used to be 3-way parallel background fetches. Pagination is driven
//    by scrolling the strip to the right until it stops appending cards.
//
// Enriched jobs are sent to the service worker as `jrd-cards` (same message JR +
// Indeed + Reed use), so background.js dedups, AI-judges against the client
// summary, and pushes picks unchanged.

(() => {
    if (window.__FF_FLEXA_SCRAPER__) return;
    window.__FF_FLEXA_SCRAPER__ = true;

    // Job id = the 24-hex Mongo ObjectId Flexa keys every job on.
    const FLEXA_ID_RX = /^[a-f0-9]{24}$/i;

    const seen = new Set();      // jobIds already sent to the SW this page load
    const inFlight = new Set();  // jobIds currently being enriched
    const queue = [];            // {jobId, cardTitle, cardCompany} awaiting enrichment
    const JD_MIN_LEN = 80;
    const PANEL_WAIT_MS = 3000;  // max wait for the preview panel to load a clicked job
    const ENRICH_GAP_MS = 250;   // small gap between jobs so the panel/app settle

    function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    function normalizeJd(text) {
        return String(text || '')
            .replace(/&nbsp;| /g, ' ')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ---- card harvesting (horizontal strip) -----------------------------
    // The list cards are <article data-type="flex-card">. The SAME markup also
    // appears INSIDE the preview panel as the "Other jobs you might like" rail —
    // exclude those, or we'd enrich recommendations instead of search results.
    function listCards() {
        return [...document.querySelectorAll('article[data-type="flex-card"][data-job-id]')]
            .filter((c) => !c.closest('[data-type="preview-panel"]'));
    }

    function harvestVisible() {
        for (const card of listCards()) {
            const jobId = String(card.getAttribute('data-job-id') || '').trim();
            if (!FLEXA_ID_RX.test(jobId)) continue;
            if (seen.has(jobId) || inFlight.has(jobId)) continue;
            if (queue.some((q) => q.jobId === jobId)) continue;
            // The card carries a usable title/company even before we open the
            // panel — keep them as a fallback if the panel read comes up short.
            queue.push({
                jobId,
                cardCompany: txt(card.querySelector('p')),
                cardTitle: txt(card.querySelector('h2')),
            });
        }
        pump();
    }

    function findCardEl(jobId) {
        return listCards().find((c) => c.getAttribute('data-job-id') === jobId) || null;
    }

    // ---- preview-panel reading ------------------------------------------

    function panelEl() { return document.querySelector('div[data-type="preview-panel"]'); }

    // Wait until the preview panel is showing `jobId` (i.e. our click landed and
    // the app finished swapping the panel content).
    async function waitForPanel(jobId, timeoutMs = PANEL_WAIT_MS) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const pp = panelEl();
            if (pp && pp.getAttribute('data-job-id') === jobId) {
                // apply-link is the last thing to hydrate; give it a beat if absent.
                if (pp.querySelector('a[data-type="apply-link"][href]')) return pp;
            }
            await delay(120);
        }
        const pp = panelEl();
        return (pp && pp.getAttribute('data-job-id') === jobId) ? pp : null;
    }

    function isFlexaHost(href) {
        try { return /(^|\.)flexa\.careers$/i.test(new URL(href, location.origin).hostname); }
        catch { return true; }
    }
    // A real external apply target: absolute, off flexa.careers, and not one of
    // flexa's own funnels (signup / quiz / login). Anything else → not an apply URL.
    function isExternalApply(href) {
        if (!/^https?:\/\//i.test(href || '')) return false;
        if (isFlexaHost(href)) return false;
        return true;
    }

    function readPanel(pp, stub) {
        const title = txt(pp.querySelector('h1')) || stub.cardTitle || '';

        // Company: the "/companies/<slug>" link is a logo with no text, but its
        // aria-label is "View <Company Name>". Fall back to the card's company.
        let company = '';
        const cl = pp.querySelector('a[href*="/companies/"][aria-label]');
        if (cl) company = (cl.getAttribute('aria-label') || '').replace(/^\s*view\s+/i, '').trim();
        if (!company) company = stub.cardCompany || '';

        // Apply URL: the panel's apply-link is the original employer URL. If it's
        // missing or flexa-internal, fall back to the id-resolvable Flexa job page
        // (Flexa resolves /in/jobs/<id> by id regardless of slug).
        const applyA = pp.querySelector('a[data-type="apply-link"][href]');
        const rawApply = applyA ? applyA.getAttribute('href') : '';
        // NB: window.location (not bare `location`) — a local named `location`
        // below would otherwise shadow the global for this whole function scope
        // and make this line throw a temporal-dead-zone ReferenceError.
        const applyUrl = isExternalApply(rawApply)
            ? new URL(rawApply, window.location.origin).href
            : `https://flexa.careers/in/jobs/${stub.jobId}`;

        // innerText (not textContent) so the JD keeps its line breaks.
        const panelText = pp.innerText || pp.textContent || '';

        let jobLocation = '';
        const locM = panelText.match(/Location:\s*(.+?)(?:\n|Location flexibility|Apply\b|Save job|$)/i);
        if (locM) jobLocation = locM[1].trim();

        let salary = '';
        const salM = panelText.match(/Salary:\s*(.+?)(?:\n|$)/i);
        if (salM) salary = salM[1].trim();

        // JD = everything between the "Job Description" heading and the
        // "Other jobs you might like" rail.
        let jd = panelText;
        const start = jd.search(/Job Description/i);
        if (start >= 0) jd = jd.slice(start + 'Job Description'.length);
        const end = jd.search(/Other jobs you might like/i);
        if (end >= 0) jd = jd.slice(0, end);
        jd = normalizeJd(jd);

        return { title, company, applyUrl, location: jobLocation, salary, description: jd };
    }

    function send(job) {
        try {
            chrome.runtime.sendMessage({ type: 'jrd-cards', jobs: [job] }).catch(() => {});
        } catch { /* extension reloaded mid-page */ }
    }

    // ---- sequential enrichment ------------------------------------------
    // Only ONE job can be enriched at a time: all jobs share the single preview
    // panel, so clicking a second card would clobber the first read. `pumping`
    // guards that single-flight.
    let pumping = false;

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (queue.length) {
                const stub = queue.shift();
                if (!stub || seen.has(stub.jobId) || inFlight.has(stub.jobId)) continue;
                inFlight.add(stub.jobId);
                try {
                    const card = findCardEl(stub.jobId);
                    let detail = null;
                    if (card) {
                        // Pure .click() — updates the panel, does NOT move the
                        // operator's viewport (verified). No scrollIntoView.
                        card.click();
                        const pp = await waitForPanel(stub.jobId);
                        if (pp) detail = readPanel(pp, stub);
                    }
                    const job = {
                        jobId: stub.jobId,
                        source: 'flexa',
                        title: (detail?.title) || stub.cardTitle || '',
                        company: (detail?.company) || stub.cardCompany || '',
                        location: detail?.location || '',
                        salary: detail?.salary || '',
                        description: detail?.description || '',
                        applyUrl: detail?.applyUrl || `https://flexa.careers/in/jobs/${stub.jobId}`,
                        easyApply: false,
                        capturedAt: new Date().toISOString(),
                    };
                    if (!job.title || !job.company) {
                        console.warn('[FF-FLEXA] missing title/company', stub.jobId, detail ? '' : 'panel-timeout');
                    }
                    if (!job.description || job.description.length < JD_MIN_LEN) {
                        console.warn('[FF-FLEXA] thin/empty JD', stub.jobId, (job.description || '').length);
                    }
                    send(job);
                } catch (e) {
                    console.warn('[FF-FLEXA] enrich threw', stub.jobId, e?.message);
                } finally {
                    seen.add(stub.jobId);
                    inFlight.delete(stub.jobId);
                }
                await delay(ENRICH_GAP_MS);
            }
        } finally {
            pumping = false;
        }
    }

    // ---- observers ------------------------------------------------------

    function startObservers() {
        harvestVisible();
        const root = document.querySelector('main') || document.body;
        let pending = false;
        const obs = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; harvestVisible(); });
        });
        obs.observe(root, { childList: true, subtree: true });

        // The strip scrolls horizontally; harvest on any scroll (its own or the
        // page's) so late-appended cards are picked up promptly.
        let scrollTimer = null;
        document.addEventListener('scroll', () => {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(harvestVisible, 200);
        }, { capture: true, passive: true });

        setInterval(harvestVisible, 3000); // safety re-sweep for late hydration
    }

    // ---- auto-pagination (horizontal infinite scroll) -------------------
    // Flexa replaced the "Load More" button with a horizontally-scrolling strip
    // that appends more cards as it nears its right edge. So while a capture is
    // active we nudge the strip's scrollLeft to the far right; the app appends the
    // next batch and the MutationObserver harvests them. Stops when scrolling
    // stops producing new cards (end of results) or the SW says the cap is hit.
    let autoPaging = true;
    let scrolls = 0;
    let stalls = 0;
    const MAX_STALLS = 3;        // consecutive scrolls that appended no new cards
    const MAX_AUTO_SCROLLS = 200; // safety ceiling; the SW cap normally stops us first
    let pagingBusy = false;

    // The scroll container is the nearest ancestor of a card that actually scrolls
    // horizontally. Found structurally (never by MUI's volatile hashed class).
    let cachedScroller = null;
    function findScroller() {
        if (cachedScroller && document.contains(cachedScroller)) return cachedScroller;
        const card = listCards()[0];
        if (!card) return null;
        let el = card.parentElement;
        while (el && el !== document.body) {
            const ox = getComputedStyle(el).overflowX;
            if (/(auto|scroll)/.test(ox) && el.scrollWidth > el.clientWidth + 40) {
                cachedScroller = el;
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    function captureState() {
        return new Promise((resolve) => {
            try { chrome.runtime.sendMessage({ type: 'jrd-is-capturing' }, (r) => resolve(r || {})); }
            catch { resolve({}); }
        });
    }
    function reportStatus(text) {
        try { chrome.runtime.sendMessage({ type: 'jrd-flexa-status', text }).catch(() => {}); } catch { /* reloaded */ }
    }

    async function maybePage() {
        if (!autoPaging || pagingBusy) return;
        if (scrolls >= MAX_AUTO_SCROLLS) { autoPaging = false; return; }
        // Let the enrichment backlog drain first so we don't race ahead of it.
        if (queue.length > 8 || inFlight.size > 0) return;
        pagingBusy = true;
        try {
            const st = await captureState();
            if (!st.active) return;
            if (st.atCap) { autoPaging = false; reportStatus('Flexa: capture cap reached — auto-loading stopped.'); return; }
            const scroller = findScroller();
            if (!scroller) return; // cards not mounted yet; try again next tick
            const before = listCards().length;
            reportStatus(`Flexa: loading more jobs (scroll ${scrolls + 1}) — auto-capturing in background, please wait…`);
            // Nudge to the far right; the app appends the next batch. This moves
            // only the strip's internal scroll, not the operator's page position.
            scroller.scrollLeft = scroller.scrollWidth;
            scrolls += 1;
            await delay(1600);
            harvestVisible();
            if (listCards().length <= before) {
                stalls += 1;
                if (stalls >= MAX_STALLS) {
                    autoPaging = false;
                    reportStatus(`Flexa: reached the last results (${scrolls} scrolls, no new jobs after ${stalls} tries).`);
                }
            } else {
                stalls = 0;
            }
        } finally {
            pagingBusy = false;
        }
    }
    setInterval(maybePage, 3000);

    // ---- panel injection (iframe loads sidepanel.html) ------------------
    const PANEL_ID = 'ff-flexa-panel';
    const PANEL_W = 420;

    function ensurePanelStyles() {
        if (document.getElementById('ff-flexa-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'ff-flexa-panel-style';
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
            #${PANEL_ID} > .ff-flexa-close {
                position: absolute; top: 8px; right: 8px;
                width: 24px; height: 24px; border-radius: 50%;
                background: #30363d; color: #f0f6fc; border: none;
                font-size: 14px; cursor: pointer; display: flex;
                align-items: center; justify-content: center;
                padding: 0; line-height: 1; z-index: 10;
                opacity: 0.6; transition: opacity 0.15s;
            }
            #${PANEL_ID} > .ff-flexa-close:hover { opacity: 1; }
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
        iframe.title = 'FlashFire Flexa → Dashboard';
        panel.appendChild(iframe);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ff-flexa-close';
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
            // Re-arm the pager so a fresh Start re-loads from the top.
            autoPaging = true;
            scrolls = 0;
            stalls = 0;
            cachedScroller = null;
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
