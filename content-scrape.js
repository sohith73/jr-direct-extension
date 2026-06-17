// JR DOM scraper. Runs as content script on jobright.ai. Watches the
// recommendations list for new card elements as the operator scrolls (the
// list is virtualised — react-window-style — so cards mount/unmount on
// scroll), extracts visible fields, and forwards to the service worker.
//
// Selector strategy (validated 2026-04-28 via MCP):
//   • Card root          div.index_job-card__oqX1M  (id attribute = JR jobId)
//   • Card-wrapping link a[href^="/jobs/info/<jobId>"]
//   • Title              h2 inside the link
//   • Field rows         img[alt="position|time|money|remote|seniority|date"]
//                        + sibling div  (location/employment/salary/work/seniority/exp)
//   • Match score        progressbar text
//   • Why-this-matches   div following "Why this job is a match" header
//   • Tags               "FAIR MATCH" / "STRONG MATCH" / "H1B Sponsor Likely" / "No H1B"
//
// Extracts only what's visible — apply URL is JR's `/jobs/info/<jobId>`
// detail page; the operator follows it to actually apply (JR controls the
// final redirect to the employer's site).

(() => {
    if (window.__FF_JRD_SCRAPER__) return;
    window.__FF_JRD_SCRAPER__ = true;

    const JR_BASE = 'https://jobright.ai';
    const JOB_ID_RX = /^[a-f0-9]{24}$/;

    // Cache of jobIds we've already reported THIS session — content script
    // is the second line of dedup (background does the auth one).
    const seen = new Set();
    // jobIds already re-emitted with a non-empty JobRight description, so a
    // late-arriving JD (API response landed after the card was first sent) is
    // pushed to background exactly once.
    const descSent = new Set();

    // Map<jobId, {applyLink, originalUrl}> — populated by the MAIN-world
    // injector that intercepts /swan/recommend/list/jobs. Used to:
    //   1. replace JR's `/jobs/info/<id>` URL with the real employer URL.
    //   2. skip LinkedIn-hosted jobs entirely (operator + dashboard
    //      tracker prefer direct employer career-site links).
    const apiApplyLinks = new Map();
    const linkedInSkipped = new Set();

    function isLinkedInUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            return /(^|\.)linkedin\.com$/i.test(u.hostname);
        } catch {
            return /linkedin\.com/i.test(url);
        }
    }

    function ingestApiJobs(jobs) {
        if (!Array.isArray(jobs)) return 0;
        let added = 0;
        const newlyLinkedin = [];
        for (const j of jobs) {
            if (!j?.jobId) continue;
            const had = apiApplyLinks.has(j.jobId);
            // Merge — a later /swan/ side-call may carry only the URL or only
            // the JD; never clobber a value we already have with a blank.
            const prev = apiApplyLinks.get(j.jobId) || {};
            apiApplyLinks.set(j.jobId, {
                applyLink: j.applyLink || prev.applyLink || '',
                originalUrl: j.originalUrl || prev.originalUrl || '',
                description: j.description || prev.description || '',
            });
            if (isLinkedInUrl(j.applyLink) || isLinkedInUrl(j.originalUrl)) {
                if (!linkedInSkipped.has(j.jobId)) {
                    linkedInSkipped.add(j.jobId);
                    newlyLinkedin.push({ jobId: j.jobId, applyLink: j.applyLink || j.originalUrl });
                }
                if (seen.has(j.jobId)) {
                    try { chrome.runtime.sendMessage({ type: 'jrd-drop-job', jobId: j.jobId, reason: 'linkedin' }).catch(() => {}); } catch {}
                }
            }
            if (!had) added += 1;
        }
        if (newlyLinkedin.length) {
            try {
                chrome.runtime.sendMessage({
                    type: 'jrd-linkedin-skipped',
                    jobs: newlyLinkedin,
                }).catch(() => {});
            } catch {}
        }
        return added;
    }

    // Drain whatever the MAIN-world injector captured BEFORE this listener
    // attached (race window between document_start and document_idle).
    try {
        const buf = window.__FF_JRD_BUFFER__;
        if (Array.isArray(buf) && buf.length) {
            ingestApiJobs(buf);
            console.log('[FF-JRD] drained', buf.length, 'pre-attached API entries');
        }
    } catch {}

    // Listen for the MAIN-world injector's postMessages.
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'FF_JRD_API' || !Array.isArray(data.jobs)) return;
        const added = ingestApiJobs(data.jobs);
        if (added > 0) requestAnimationFrame(harvestVisible);
    });

    function pickField(card, alt) {
        const img = card.querySelector(`img[alt="${alt}"]`);
        if (!img) return '';
        const sib = img.nextElementSibling;
        if (!sib) return '';
        return (sib.textContent || '').trim();
    }

    function pickMatchPercent(card) {
        // The card's match-score progressbar is rendered inside the side
        // "FAIR MATCH" / "STRONG MATCH" link. Look for any progressbar
        // descendant — text is `<n>%` shape.
        const bars = card.querySelectorAll('[role="progressbar"]');
        for (const bar of bars) {
            const txt = (bar.textContent || '').trim();
            // Match the FIRST percent that's distinct from the sub-bars
            // (Experience Level / Skills / Industry — those also show %).
            const m = txt.match(/^(\d{1,3})%?$/);
            if (m) return Number(m[1]);
        }
        return 0;
    }

    function pickWhyMatch(card) {
        // The "Why this job is a match" header is followed by a sibling div
        // containing the match summary text.
        const hdrs = [...card.querySelectorAll('div, span')].filter(
            (e) => e.textContent && e.textContent.trim() === 'Why this job is a match',
        );
        for (const hdr of hdrs) {
            const sib = hdr.nextElementSibling;
            if (sib && sib.textContent) return sib.textContent.trim();
        }
        return '';
    }

    function pickTags(card) {
        // Collect signals from three places JR scatters them:
        //   • ant-tag spans (publish time, "school alumni work here")
        //   • side fit-summary link's job-check rows (Comp. & Benefits, H1B Sponsor Likely)
        //   • plain div/span leaves with known signal text ("No H1B", "Be an early applicant")
        const tags = new Set();
        card.querySelectorAll('span.ant-tag, [class*="ant-tag"]').forEach((e) => {
            const t = (e.textContent || '').trim();
            if (t) tags.add(t);
        });
        card.querySelectorAll('img[alt="job-check"]').forEach((img) => {
            const sib = img.nextElementSibling;
            if (sib) {
                const t = (sib.textContent || '').trim();
                if (t) tags.add(t);
            }
        });
        const SIGNAL_RX =
            /^(No H1B|H1B Sponsor Likely|Comp\. & Benefits|Citizens Only|Clearance Required|Be an early applicant|Active Hiring|Sponsor Required)$/i;
        card.querySelectorAll('div, span').forEach((e) => {
            if (e.children.length !== 0) return;
            const t = (e.textContent || '').trim();
            if (SIGNAL_RX.test(t)) tags.add(t);
        });
        return [...tags];
    }

    function pickFitFlag(card) {
        // "FAIR MATCH" / "STRONG MATCH" / "WEAK MATCH" — sibling text near
        // the percent. Cheap regex over card text.
        const t = (card.textContent || '').toUpperCase();
        const m = t.match(/(STRONG|GREAT|GOOD|FAIR|WEAK)\s+MATCH/);
        return m ? `${m[1]} MATCH` : '';
    }

    function pickCompany(card) {
        // The desc block holds "Company / Industries · Stage". The first
        // child of the third row is the company name.
        const desc = card.querySelector('[class*="index_desc__"]');
        if (!desc) return '';
        const thirdRow = desc.querySelector('[class*="index_third-row__"]');
        if (!thirdRow) return '';
        const first = thirdRow.firstElementChild;
        return first ? (first.textContent || '').trim() : '';
    }

    function pickIndustries(card) {
        const desc = card.querySelector('[class*="index_desc__"]');
        if (!desc) return '';
        const thirdRow = desc.querySelector('[class*="index_third-row__"]');
        if (!thirdRow) return '';
        // Pattern: <company> / <industries · stage>
        const parts = (thirdRow.textContent || '').split(/\s*\/\s*/);
        return parts.length > 1 ? parts.slice(1).join(' / ').trim() : '';
    }

    function pickPublishedAt(card) {
        const tag = card.querySelector('[class*="index_publish-time__"]');
        return tag ? (tag.textContent || '').trim() : '';
    }

    function extractCard(cardEl) {
        const jobId = cardEl.id;
        if (!jobId || !JOB_ID_RX.test(jobId)) return null;
        // Hard skip: LinkedIn-hosted jobs (per operator policy).
        if (linkedInSkipped.has(jobId)) return null;
        const link = cardEl.querySelector(`a[href^="/jobs/info/${jobId}"]`)
            || cardEl.querySelector('a[href^="/jobs/info/"]');
        const title = (cardEl.querySelector('h2')?.textContent || '').trim();
        if (!title) return null;
        const company = pickCompany(cardEl);
        if (!company) return null;
        // Resolve apply URL: prefer real employer applyLink from API capture,
        // fall back to JR's detail page.
        const apiInfo = apiApplyLinks.get(jobId);
        const realApply = apiInfo?.applyLink || apiInfo?.originalUrl || '';
        if (realApply && isLinkedInUrl(realApply)) {
            // Belt-and-suspenders — skip even if linkedInSkipped didn't fire.
            linkedInSkipped.add(jobId);
            return null;
        }
        const applyUrl = realApply || `${JR_BASE}/jobs/info/${jobId}`;
        return {
            jobId,
            source: 'jobright',
            title,
            company,
            industries: pickIndustries(cardEl),
            location: pickField(cardEl, 'position'),
            employmentType: pickField(cardEl, 'time'),
            salary: pickField(cardEl, 'money'),
            workModel: pickField(cardEl, 'remote'),
            seniority: pickField(cardEl, 'seniority'),
            experienceYears: pickField(cardEl, 'date'),
            publishedAt: pickPublishedAt(cardEl),
            matchPercent: pickMatchPercent(cardEl),
            matchSummary: pickWhyMatch(cardEl),
            fitFlag: pickFitFlag(cardEl),
            tags: pickTags(cardEl),
            applyUrl,
            // JobRight's OWN composed JD, pulled from the intercepted /swan API
            // response (content-inject). The first-stage judge scores on this —
            // no employer-site scrape, so capture never hangs on a slow site.
            description: apiInfo?.description || '',
            jrLink: link ? `${JR_BASE}${link.getAttribute('href')}` : `${JR_BASE}/jobs/info/${jobId}`,
            capturedAt: new Date().toISOString(),
        };
    }

    function harvestVisible() {
        const cards = document.querySelectorAll('div.job-card-flag-classname[id], div[class*="index_job-card__"][id]');
        const fresh = [];
        const updated = [];
        for (const cardEl of cards) {
            if (!cardEl.id) continue;
            const job = extractCard(cardEl);
            if (!job) continue;
            const jrUrl = `${JR_BASE}/jobs/info/${job.jobId}`;
            const hasRealUrl = job.applyUrl && job.applyUrl !== jrUrl;
            const hasNewDesc = !!job.description && !descSent.has(job.jobId);
            if (job.description) descSent.add(job.jobId);
            if (seen.has(job.jobId)) {
                // Already sent. Re-emit so background overwrites when the API
                // enriched the card after first emit with either the real
                // employer URL or JobRight's own JD.
                if (hasRealUrl || hasNewDesc) updated.push(job);
                continue;
            }
            seen.add(job.jobId);
            fresh.push(job);
        }
        try {
            if (fresh.length) {
                chrome.runtime
                    .sendMessage({ type: 'jrd-cards', jobs: fresh })
                    .catch(() => {});
            }
            if (updated.length) {
                chrome.runtime
                    .sendMessage({ type: 'jrd-update-jobs', jobs: updated })
                    .catch(() => {});
            }
        } catch { /* extension reloaded mid-page */ }
    }

    function startObservers() {
        // Initial sweep — page may already have a few cards rendered.
        harvestVisible();

        // Watch the entire main column. Virtualised list mounts/unmounts
        // cards as scroll progresses, so a debounced sweep on each batch
        // of mutations is cheaper than per-node hooks.
        const root = document.querySelector('#jobs-page-main-content') || document.body;
        let pending = false;
        const obs = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                harvestVisible();
            });
        });
        obs.observe(root, { childList: true, subtree: true });

        // Also catch scrolls in case mutations don't fire on identical-shape
        // remounts; cheap re-sweep.
        let scrollTimer = null;
        document.addEventListener(
            'scroll',
            () => {
                clearTimeout(scrollTimer);
                scrollTimer = setTimeout(harvestVisible, 200);
            },
            { capture: true, passive: true },
        );
    }

    // ---- panel injection (iframe loads sidepanel.html) -----------------
    const PANEL_ID = 'ff-jrd-panel';
    const PANEL_W = 420;

    function ensurePanelStyles() {
        if (document.getElementById('ff-jrd-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'ff-jrd-panel-style';
        style.textContent = `
            #${PANEL_ID} {
                position: fixed;
                top: 0; right: 0;
                width: ${PANEL_W}px;
                height: 100vh;
                background: #0d1117;
                z-index: 2147483647;
                box-shadow: -2px 0 12px rgba(0,0,0,0.5);
                overflow: hidden;
                display: none;
                border-left: 1px solid #30363d;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            }
            #${PANEL_ID}.open { display: block; }
            #${PANEL_ID} > iframe {
                width: 100%; height: 100%;
                border: none;
                background: #0d1117;
            }
            #${PANEL_ID} > .ff-jrd-close {
                position: absolute;
                top: 8px; right: 8px;
                width: 24px; height: 24px;
                border-radius: 50%;
                background: #30363d;
                color: #f0f6fc;
                border: none;
                font-size: 14px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                line-height: 1;
                z-index: 10;
                opacity: 0.6;
                transition: opacity 0.15s;
            }
            #${PANEL_ID} > .ff-jrd-close:hover { opacity: 1; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
        ensurePanelStyles();
        const panel = document.createElement('div');
        panel.id = PANEL_ID;

        const iframe = document.createElement('iframe');
        try {
            iframe.src = chrome.runtime.getURL('sidepanel.html');
        } catch {
            return null;
        }
        iframe.title = 'FlashFire JR → Dashboard';
        panel.appendChild(iframe);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ff-jrd-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close panel';
        closeBtn.addEventListener('click', () => {
            panel.classList.remove('open');
        });
        panel.appendChild(closeBtn);

        (document.body || document.documentElement).appendChild(panel);
        return panel;
    }

    function togglePanel() {
        const panel = document.getElementById(PANEL_ID) || createPanel();
        if (!panel) return;
        panel.classList.toggle('open');
    }

    function openPanel() {
        const panel = document.getElementById(PANEL_ID) || createPanel();
        if (panel) panel.classList.add('open');
    }

    // Auto-mount the panel on first load of /jobs/recommend so it's ready.
    if (location.pathname.startsWith('/jobs/')) {
        // Defer slightly so JR's own UI has time to lay itself out.
        setTimeout(createPanel, 800);
    }

    // chrome.runtime messages from sidepanel → content
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'jrd-reset-content-cache') {
            seen.clear();
            sendResponse({ ok: true });
            return true;
        }
        if (msg.type === 'jrd-content-stats') {
            sendResponse({ seen: seen.size });
            return true;
        }
        if (msg.type === 'jrd-toggle-panel') {
            togglePanel();
            sendResponse({ ok: true });
            return true;
        }
        if (msg.type === 'jrd-open-panel') {
            openPanel();
            sendResponse({ ok: true });
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
