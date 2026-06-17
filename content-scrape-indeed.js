// Indeed scraper. ISOLATED-world content script on indeed.com.
//
// Fully self-sufficient — does NOT depend on the MAIN-world injector. As the
// operator scrolls, a MutationObserver + scroll handler sweep the visible
// `div.job_seen_beacon` cards for {jobId, title, company, location}. Then for
// each NEW job it does ONE same-origin fetch:
//   GET <serp>?vjk=<jobId>
// Indeed SSRs that job's detail pane into the returned HTML, which gives us
// EVERYTHING in one shot:
//   • #jobDescriptionText      → full job description
//   • #salaryInfoAndJobType    → pay + employment type
//   • "Apply on company site"  → applystart href (seed) → background SW
//                                resolves it to the ORIGINAL employer URL
//   • Easy-Apply detection     → "Apply on company site" present = keep;
//                                Indeed-hosted "Apply now" = skip per policy
// (Verified 2026-06-04 via MCP — see memory indeed-serp-scrape-structure.)
//
// Enriched jobs are sent to the service worker as `jrd-cards` (the same
// message the JR scraper uses), so background.js dedups, AI-judges against
// the client summary, resolves the employer URL, and pushes picks unchanged.

(() => {
    if (window.__FF_IND_SCRAPER__) return;
    window.__FF_IND_SCRAPER__ = true;

    const JK_RX = /^[a-z0-9]{12,20}$/i;

    const seen = new Set();      // jobIds sent to SW this page load
    const inFlight = new Set();
    const queue = [];
    let activeFetches = 0;
    const MAX_CONCURRENT_JD = 3;
    const JD_MIN_LEN = 80;

    function txt(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

    function cardJk(card) {
        const a = card.querySelector('a[data-jk]');
        if (a) return a.getAttribute('data-jk');
        const t = card.querySelector('[id^="jobTitle-"]');
        if (t) return t.id.replace('jobTitle-', '');
        return '';
    }

    function extractCard(card) {
        const jobId = cardJk(card);
        if (!jobId || !JK_RX.test(jobId)) return null;
        // Visual Easy-Apply badge on the card — cheap early skip.
        if (/easily apply/i.test(card.textContent || '')) return { jobId, easyApply: true };
        const title = txt(card.querySelector('h3.jobTitle span[id^="jobTitle-"], h3.jobTitle, .jcs-JobTitle span'));
        const company = txt(card.querySelector('[data-testid="company-name"]'));
        const location = txt(card.querySelector('[data-testid="text-location"]'));
        return { jobId, title, company, location, easyApply: false };
    }

    function harvestVisible() {
        const cards = document.querySelectorAll('div.job_seen_beacon, #mosaic-provider-jobcards li div.cardOutline');
        for (const card of cards) {
            const jobId = cardJk(card);
            if (!jobId || !JK_RX.test(jobId)) continue;
            if (seen.has(jobId) || inFlight.has(jobId)) continue;
            if (queue.some((q) => q.jobId === jobId)) continue;
            const stub = extractCard(card);
            if (!stub) continue;
            queue.push(stub);
        }
        pump();
    }

    // ---- full detail fetch (same-origin, in-page) -----------------------

    function jdUrl(jobId) {
        const u = new URL(window.location.href);
        u.searchParams.set('vjk', jobId);
        return u.pathname + u.search;
    }

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // Cloudflare interstitial / Indeed bot wall — the fetched HTML carries no
    // JD, just a "Just a moment…" challenge. Detect so we retry instead of
    // shipping an empty description (the "No job description" bug).
    function isChallengeHtml(html) {
        return /just a moment|challenge-platform|cf-browser-verification|_cf_chl_opt/i.test(html);
    }

    // Indeed's detail pane is styled-components: it injects inline <style>
    // blocks whose CSS gets swallowed by .textContent, producing a wall of
    // "--ifl-colors-…" noise. Strip style/script/svg before reading text, and
    // trim to the real JD so the judge gets plain text only.
    function normalizeJd(text) {
        let t = String(text || '');
        // The pane is prefixed with Job details / Pay / Location chrome; the
        // real description starts at "Full job description".
        const idx = t.toLowerCase().lastIndexOf('full job description');
        if (idx !== -1) t = t.slice(idx + 'full job description'.length);
        return t.replace(/ /g, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }
    function cleanFromNode(node) {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('style, script, noscript, svg, link, template').forEach((n) => n.remove());
        return normalizeJd(clone.textContent || '');
    }
    function stripHtml(html) {
        // Add line breaks for block elements so list-heavy JDs stay readable
        // once flattened to text.
        const withBreaks = String(html || '')
            .replace(/<\/(li|p|div|h[1-6]|tr)>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n');
        const tmp = document.createElement('div');
        tmp.innerHTML = withBreaks;
        return cleanFromNode(tmp);
    }

    // Indeed embeds the JD under several keys depending on render path. Scan
    // the raw HTML for whichever one is present (value is an escaped JSON
    // string of HTML).
    const JD_JSON_KEYS = ['sanitizedJobDescription', 'jobDescriptionText', 'jobDescription'];
    function jdFromJson(rawHtml) {
        for (const key of JD_JSON_KEYS) {
            const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
            const m = rawHtml.match(re);
            if (m) {
                try {
                    const s = stripHtml(JSON.parse(`"${m[1]}"`));
                    if (s.length >= JD_MIN_LEN) return s;
                } catch { /* malformed escape — try next key */ }
            }
        }
        return '';
    }

    // The live SERP already renders the *selected* job's full JD into the page
    // DOM. When we're enriching the job that's currently on screen, read it
    // straight from the live DOM — most reliable, no fetch/parse needed.
    function liveDomJd(jobId) {
        try {
            const cur = new URL(window.location.href).searchParams.get('vjk');
            if (cur && cur === jobId) {
                const el = document.querySelector('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]');
                if (el) return cleanFromNode(el);
            }
        } catch { /* ignore */ }
        return '';
    }

    // JD lives in the SSR DOM (#jobDescriptionText) AND in the embedded job
    // JSON. The DOM node is sometimes empty (layout A/B, partial hydration) —
    // the JSON usually carries the full HTML body. Try DOM, then JSON, then
    // the live page DOM for the on-screen job.
    function extractDescription(doc, rawHtml, jobId) {
        const jdEl = doc.querySelector('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"], .jobsearch-JobComponent-description, #jobDescriptionTextWrapper');
        let description = cleanFromNode(jdEl);
        if (description.length >= JD_MIN_LEN) return description;
        const fromJson = jdFromJson(rawHtml);
        if (fromJson.length > description.length) description = fromJson;
        if (description.length < JD_MIN_LEN) {
            const live = liveDomJd(jobId);
            if (live.length > description.length) description = live;
        }
        return description;
    }

    // Indeed's dedicated JD endpoint. Returns { "<jk>": "<html JD>" } — clean,
    // tiny (~2KB vs the 1.2MB SERP), and reliable across sessions/AB-buckets
    // (the SERP only SSRs #jobDescriptionText for SOME buckets, which is why
    // JD came back empty for the operator). This is the primary JD source.
    async function fetchJdViaRpc(jobId, attempt = 0) {
        try {
            const res = await fetch(`${window.location.origin}/rpc/jobdescs?jks=${encodeURIComponent(jobId)}`, {
                credentials: 'include',
                headers: { accept: 'application/json' },
            });
            if (!res.ok) throw new Error('HTTP_' + res.status);
            const json = JSON.parse(await res.text());
            const html = json && json[jobId];
            return html ? stripHtml(html) : '';
        } catch (e) {
            if (attempt < 2) { await delay(500 * (attempt + 1)); return fetchJdViaRpc(jobId, attempt + 1); }
            return '';
        }
    }

    async function fetchJobDetail(jobId, attempt = 0) {
        let res;
        try {
            res = await fetch(jdUrl(jobId), { credentials: 'include' });
        } catch (e) {
            if (attempt < 2) { await delay(600 * (attempt + 1)); return fetchJobDetail(jobId, attempt + 1); }
            return { ok: false, error: 'NETWORK', message: e.message };
        }
        if (!res.ok) {
            if (attempt < 2) { await delay(600 * (attempt + 1)); return fetchJobDetail(jobId, attempt + 1); }
            return { ok: false, error: `HTTP_${res.status}` };
        }
        const rawHtml = await res.text();
        if (isChallengeHtml(rawHtml) && attempt < 2) {
            await delay(800 * (attempt + 1));
            return fetchJobDetail(jobId, attempt + 1);
        }
        let doc;
        try {
            doc = new DOMParser().parseFromString(rawHtml, 'text/html');
        } catch (e) {
            return { ok: false, error: 'PARSE', message: e.message };
        }
        // JD: prefer the dedicated rpc/jobdescs endpoint (reliable + clean);
        // fall back to whatever the SERP SSR carried. Take the longer of the two.
        const serpDesc = extractDescription(doc, rawHtml, jobId);
        const rpcDesc = await fetchJdViaRpc(jobId);
        const description = rpcDesc.length >= serpDesc.length ? rpcDesc : serpDesc;
        if (description.length < JD_MIN_LEN) {
            console.warn('[FF-IND] JD empty', jobId, 'serp', serpDesc.length, 'rpc', rpcDesc.length);
        }
        const salary = txt(doc.querySelector('#salaryInfoAndJobType'));
        const detailTitle = txt(doc.querySelector('h2[data-testid="simpler-jobTitle"], h2.jobsearch-JobInfoHeader-title'));
        const detailCompany = txt(doc.querySelector('[data-company-name="true"], [data-testid="inlineHeader-companyName"]'));

        // Apply button: "Apply on company site" → keep + use its applystart
        // href as the resolve seed. Indeed-hosted "Apply now" → Easy Apply.
        const buttons = [...doc.querySelectorAll('button, a')];
        const companyBtn = buttons.find((b) => /apply on company site/i.test(b.textContent || ''));
        const indeedApplyBtn = buttons.find((b) => /\bapply now\b/i.test(b.textContent || '') && !/company site/i.test(b.textContent || ''));
        const hasIndeedApplyWidget = !!doc.querySelector('[class*="indeedApply"], [data-testid="indeedApplyButton"], #indeedApplyButton');
        const easyApply = !companyBtn && (!!indeedApplyBtn || hasIndeedApplyWidget);
        const applySeed = companyBtn ? (companyBtn.getAttribute('href') || '') : '';

        return { ok: true, description, salary, detailTitle, detailCompany, easyApply, applySeed };
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
            // Card-level Easy-Apply badge — skip without a fetch.
            if (stub.easyApply) { seen.add(stub.jobId); continue; }
            inFlight.add(stub.jobId);
            activeFetches += 1;
            fetchJobDetail(stub.jobId)
                .then((detail) => {
                    if (detail.ok && detail.easyApply) {
                        // Easy Apply (Indeed-hosted) — skip per operator policy.
                        return;
                    }
                    const job = {
                        jobId: stub.jobId,
                        source: 'indeed',
                        title: stub.title || (detail.ok ? detail.detailTitle : '') || '',
                        company: stub.company || (detail.ok ? detail.detailCompany : '') || '',
                        location: stub.location || '',
                        salary: detail.ok ? (detail.salary || '') : '',
                        description: detail.ok ? detail.description : '',
                        // applystart seed → background resolves to employer URL.
                        applyUrl: (detail.ok && detail.applySeed)
                            ? new URL(detail.applySeed, window.location.origin).href
                            : `${window.location.origin}/applystart?jk=${stub.jobId}&from=vj`,
                        easyApply: false,
                        capturedAt: new Date().toISOString(),
                    };
                    if (!job.title || !job.company) {
                        console.warn('[FF-IND] missing title/company', stub.jobId);
                    }
                    if (!job.description || job.description.length < JD_MIN_LEN) {
                        console.warn('[FF-IND] thin/empty JD', stub.jobId, detail.error || (detail.description || '').length);
                    }
                    send(job);
                })
                .catch((e) => console.warn('[FF-IND] detail fetch threw', stub.jobId, e?.message))
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
        const root = document.querySelector('#mosaic-provider-jobcards')
            || document.querySelector('#resultsCol')
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

    // ---- optional auto-advance pagination -------------------------------
    let autoAdvance = false;
    setInterval(() => {
        if (!autoAdvance || queue.length || activeFetches > 0) return;
        const next = document.querySelector('a[data-testid="pagination-page-next"]');
        if (next) { setTimeout(() => next.click(), 800); }
    }, 2500);

    // ---- panel injection (iframe loads sidepanel.html) ------------------
    const PANEL_ID = 'ff-ind-panel';
    const PANEL_W = 420;

    function ensurePanelStyles() {
        if (document.getElementById('ff-ind-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'ff-ind-panel-style';
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
            #${PANEL_ID} > .ff-ind-close {
                position: absolute; top: 8px; right: 8px;
                width: 24px; height: 24px; border-radius: 50%;
                background: #30363d; color: #f0f6fc; border: none;
                font-size: 14px; cursor: pointer; display: flex;
                align-items: center; justify-content: center;
                padding: 0; line-height: 1; z-index: 10;
                opacity: 0.6; transition: opacity 0.15s;
            }
            #${PANEL_ID} > .ff-ind-close:hover { opacity: 1; }
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
        iframe.title = 'FlashFire Indeed → Dashboard';
        panel.appendChild(iframe);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ff-ind-close';
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
            sendResponse({ ok: true });
            return true;
        }
        if (msg.type === 'jrd-content-stats') { sendResponse({ seen: seen.size }); return true; }
        if (msg.type === 'jrd-toggle-panel') { togglePanel(); sendResponse({ ok: true }); return true; }
        if (msg.type === 'jrd-open-panel') { openPanel(); sendResponse({ ok: true }); return true; }
        if (msg.type === 'jrd-set-auto-advance') {
            autoAdvance = !!msg.enabled;
            sendResponse({ ok: true, autoAdvance });
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
