// hiring.cafe panel injector + same-origin API fetch proxy.
//
// The hiring.cafe flow no longer DOM-scrapes the page. Instead the operator
// sets filters in the panel and the service worker drives a page-by-page
// scrape of hiring.cafe's own JSON search API:
//
//   GET /_next/data/<buildId>/index.json?searchState=<json>&page=<N>
//
// hiring.cafe sits behind Cloudflare — a cold server-side fetch gets a 403
// challenge. So the actual fetch MUST run in THIS page's context, where the
// browser already holds the cf_clearance cookie. The SW asks this content
// script (`hcafe-fetch`) to perform each request and relays the result.
//
// Responsibilities:
//   1. Mount the FlashFire panel iframe (sidepanel.html?site=hcafe).
//   2. Proxy `hcafe-fetch` requests — same-origin fetch of the data endpoint.
// jobright.ai is untouched and keeps its own scroll-capture content script.

(() => {
    if (window.__FF_HCAFE_PANEL__) return;
    window.__FF_HCAFE_PANEL__ = true;

    const PANEL_ID = 'ff-jrd-panel';
    const PANEL_W = 420;

    // ---- buildId + API fetch (same-origin, rides the cf_clearance cookie) --

    function readBuildId() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) {
                const id = JSON.parse(el.textContent).buildId;
                if (id) return id;
            }
        } catch { /* fall through */ }
        return '';
    }

    // hcafeFetchPage: fetch one page of search results. Strips the heavy
    // per-user arrays (viewedByUsers / appliedFromUsers / …) before relaying
    // so the message payload stays small. Returns raw-ish hits — the SW
    // normalises them into canonical Job objects.
    async function hcafeFetchPage(searchState, page) {
        const buildId = readBuildId();
        if (!buildId) return { error: 'NO_BUILD_ID' };
        let url = `/_next/data/${buildId}/index.json`
            + `?searchState=${encodeURIComponent(JSON.stringify(searchState || {}))}`;
        if (page > 0) url += `&page=${page}`;
        try {
            const r = await fetch(url, {
                headers: { 'x-nextjs-data': '1' },
                credentials: 'same-origin',
            });
            if (!r.ok) return { error: `HTTP_${r.status}` };
            const data = await r.json();
            const pp = (data && data.pageProps) || {};
            const rawHits = Array.isArray(pp.ssrHits) ? pp.ssrHits : [];
            const hits = rawHits.map((h) => {
                if (h && h.job_information) {
                    // Drop the multi-hundred-entry user arrays — pure bloat.
                    const ji = { ...h.job_information };
                    delete ji.viewedByUsers;
                    delete ji.savedFromUsers;
                    delete ji.appliedFromUsers;
                    delete ji.hiddenFromUsers;
                    return { ...h, job_information: ji };
                }
                return h;
            });
            return {
                hits,
                isLastPage: !!pp.ssrIsLastPage,
                total: pp.ssrTotalCount || 0,
                buildId,
            };
        } catch (e) {
            return { error: 'NETWORK', message: e?.message || String(e) };
        }
    }

    // ---- panel iframe ------------------------------------------------------

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
            #${PANEL_ID} > iframe { width: 100%; height: 100%; border: none; background: #0d1117; }
            #${PANEL_ID} > .ff-jrd-close {
                position: absolute; top: 8px; right: 8px;
                width: 24px; height: 24px; border-radius: 50%;
                background: #30363d; color: #f0f6fc; border: none;
                font-size: 14px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                padding: 0; line-height: 1; z-index: 10;
                opacity: 0.6; transition: opacity 0.15s;
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
            // ?site=hcafe → sidepanel.js renders the hiring.cafe filter UI.
            iframe.src = chrome.runtime.getURL('sidepanel.html') + '?site=hcafe';
        } catch {
            return null;
        }
        iframe.title = 'FlashFire hiring.cafe → Dashboard';
        panel.appendChild(iframe);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ff-jrd-close';
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

    // Auto-mount — operator typically wants the panel open immediately.
    setTimeout(createPanel, 800);

    // ---- message dispatcher ------------------------------------------------

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'hcafe-fetch') {
            hcafeFetchPage(msg.searchState, msg.page || 0)
                .then((r) => sendResponse(r))
                .catch((e) => sendResponse({ error: 'THREW', message: e?.message || String(e) }));
            return true; // async
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
        if (msg.type === 'jrd-content-stats') {
            // hiring.cafe scraping is SW-driven now — answer the health probe
            // so the panel knows the proxy tab is alive.
            sendResponse({
                seen: 0,
                site: 'hiring.cafe',
                captureActive: false,
                cachedPages: [],
                mode: 'api',
                buildId: readBuildId(),
            });
            return true;
        }
        return false;
    });

    console.log('[FF-HCAFE] panel + fetch-proxy ready on', location.href, 'buildId=', readBuildId());
})();
