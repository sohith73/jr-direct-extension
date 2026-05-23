// site-jd-fetcher — open the job's apply URL in a background Chrome window,
// run the ported FlashFire DOM extractors against the rendered DOM, return
// { ok, description, location, method, confidence, sourceHost, durationMs }.
//
// Why in-extension (not Playwright on the scraper backend):
//   - Playwright deploys need lockstep Docker image / npm version pin
//     (we hit "Executable doesn't exist" once already).
//   - The operator already has Chrome open with the right session — a
//     hidden window inherits cookies + handles SPA hydration the same way
//     a real visit would.
//
// Visibility:
//   - We use `chrome.windows.create({ focused:false, state:'minimized' })`
//     so the operator's main window keeps focus and the spawned window
//     drops to the OS dock/taskbar rather than flashing on top.
//
// Lifecycle per call:
//   1. acquire concurrency slot (cap 2)
//   2. create minimized hidden window with the apply URL
//   3. wait for tab `complete` status (or NAV_TIMEOUT)
//   4. per-host settle delay (SPAs need extra time after `load`)
//   5. chrome.scripting.executeScript with extractor files in order
//   6. read window.FFExtract.pipeline.extract() result
//   7. ALWAYS close the window in `finally`
//
// All failure modes return { ok:false, error, message } so callers fall
// back to the JR / hiring.cafe description without raising.

const EXTRACTOR_FILES = [
    'extractors/namespace.js',
    'extractors/confidence.js',
    'extractors/json-ld.js',
    'extractors/meta-tags.js',
    'extractors/generic.js',
    'extractors/site-greenhouse.js',
    'extractors/site-lever.js',
    'extractors/site-ashby.js',
    'extractors/site-workday.js',
    'extractors/site-smartrecruiters.js',
    'extractors/site-bamboohr.js',
    'extractors/site-icims.js',
    'extractors/site-indeed.js',
    'extractors/site-linkedin.js',
    'extractors/site-jobright.js',
    'extractors/pipeline.js',
];

// Per-host settle in ms. SPA frameworks need extra time after `complete`
// for React/Vue hydration to mount the JD body. Empirically tuned.
const HOST_SETTLE_MS = [
    [/workday/i, 5000],
    [/greenhouse/i, 2500],
    [/lever\.co/i, 1500],
    [/ashbyhq/i, 2000],
    [/icims/i, 3000],
    [/smartrecruiters/i, 2500],
    [/bamboohr/i, 2000],
    [/linkedin/i, 3000],
    [/indeed/i, 3000],
];

// Hosts where the in-extension extractor is pointless or blocked.
// LinkedIn requires auth + actively blocks scraping; JR/hcafe are the
// source platforms already; mailto/etc. aren't applicable.
const SKIP_HOSTS = [
    /linkedin\.com/i,
    /jobright\.ai/i,
    /hiring\.cafe/i,
];

const NAV_TIMEOUT_MS = 25000;
const MIN_DESCRIPTION_CHARS = 300;
const MAX_CONCURRENT = 2;

// In-memory result cache keyed by URL. Avoids re-opening a window for the
// same apply URL across re-runs in the same SW lifetime.
const _resultCache = new Map();

// Tiny semaphore — Chrome handles many open windows but we want to keep
// the operator's machine responsive.
let _inFlight = 0;
const _waitQueue = [];
function acquire() {
    if (_inFlight < MAX_CONCURRENT) {
        _inFlight += 1;
        return Promise.resolve();
    }
    return new Promise((res) => _waitQueue.push(res));
}
function release() {
    _inFlight -= 1;
    const next = _waitQueue.shift();
    if (next) { _inFlight += 1; next(); }
}

function isHttpUrl(u) {
    if (!u || typeof u !== 'string') return false;
    try {
        const p = new URL(u);
        return p.protocol === 'http:' || p.protocol === 'https:';
    } catch { return false; }
}
function hostOf(u) {
    try { return new URL(u).hostname; } catch { return ''; }
}
function settleFor(url) {
    const host = hostOf(url);
    for (const [rx, ms] of HOST_SETTLE_MS) if (rx.test(host)) return ms;
    return 1500;
}

// Wait until the given tab's status === 'complete' OR navigation timeout
// elapses. We don't reject on timeout — the page may have rendered enough
// JD even if it's still loading analytics scripts.
function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (reason) => {
            if (done) return;
            done = true;
            try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
            clearTimeout(timer);
            resolve(reason);
        };
        const onUpdated = (id, info) => {
            if (id === tabId && info.status === 'complete') finish('complete');
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
}

// Friendly source label from the pipeline.extract method name and the
// final host. UI shows this next to the View link.
function friendlySource(method, host) {
    const m = String(method || '').toLowerCase();
    if (m.startsWith('site-')) {
        const name = m.slice(5);
        // Title-case the ATS name (e.g. greenhouse → Greenhouse)
        return name.charAt(0).toUpperCase() + name.slice(1);
    }
    if (m === 'json-ld' || m === 'meta-tags' || m === 'generic') {
        // Layer-based extraction — surface the company host instead.
        if (host) {
            const parts = host.replace(/^www\./, '').split('.');
            const root = parts.length >= 2 ? parts[parts.length - 2] : host;
            return root.charAt(0).toUpperCase() + root.slice(1);
        }
        return 'Site';
    }
    return method || 'Site';
}

// fetchSiteJobDetailInBrowser — main entry point.
// Returns:
//   { ok:true, description, location, method, confidence, sourceLabel, sourceHost, finalUrl, durationMs }
//   { ok:false, error, message, durationMs }
export async function fetchSiteJobDetailInBrowser(applyUrl) {
    const t0 = Date.now();
    if (!isHttpUrl(applyUrl)) {
        return { ok: false, error: 'BAD_INPUT', message: 'http(s) url required', durationMs: 0 };
    }
    const host = hostOf(applyUrl);
    for (const rx of SKIP_HOSTS) {
        if (rx.test(host)) {
            return { ok: false, error: 'SKIPPED_HOST', message: host, durationMs: 0 };
        }
    }
    if (_resultCache.has(applyUrl)) {
        const cached = _resultCache.get(applyUrl);
        return { ok: true, ...cached, cached: true, durationMs: 0 };
    }

    await acquire();
    let windowId = null;
    let tabId = null;
    try {
        // Minimized, unfocused window. The page still loads + scripts run,
        // but the operator's foreground stays intact.
        const win = await chrome.windows.create({
            url: applyUrl,
            focused: false,
            state: 'minimized',
            type: 'normal',
        });
        windowId = win.id;
        tabId = win.tabs?.[0]?.id ?? null;
        if (!tabId) {
            return { ok: false, error: 'NO_TAB', message: 'window opened without a tab', durationMs: Date.now() - t0 };
        }

        await waitForTabComplete(tabId, NAV_TIMEOUT_MS);
        // Per-host settle for SPA hydration.
        await new Promise((r) => setTimeout(r, settleFor(applyUrl)));

        // Inject extractor files in dependency order. Each runs an IIFE
        // that mutates window.FFExtract. ISOLATED world keeps our globals
        // off the page's window object.
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: EXTRACTOR_FILES,
                world: 'ISOLATED',
            });
        } catch (err) {
            return { ok: false, error: 'INJECT_FAILED', message: err?.message || String(err), durationMs: Date.now() - t0 };
        }

        let extracted;
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'ISOLATED',
                func: () => {
                    const ns = self.FFExtract || window.FFExtract;
                    if (!ns || !ns.pipeline) return null;
                    const r = ns.pipeline.extract();
                    if (!r || !r.data) return null;
                    return {
                        data: r.data,
                        confidence: r.confidence,
                        method: r.method,
                        fieldSources: r.fieldSources,
                        extractionTimeMs: r.extractionTimeMs,
                        finalUrl: location.href,
                    };
                },
            });
            extracted = results?.[0]?.result;
        } catch (err) {
            return { ok: false, error: 'EVAL_FAILED', message: err?.message || String(err), durationMs: Date.now() - t0 };
        }

        if (!extracted) {
            return { ok: false, error: 'NO_DATA', message: 'pipeline returned null', durationMs: Date.now() - t0 };
        }

        const desc = String(extracted.data.description || '').trim();
        const loc = String(extracted.data.location || '').trim();
        const finalHost = hostOf(extracted.finalUrl || applyUrl);
        const sourceLabel = friendlySource(extracted.method, finalHost);

        if (desc.length < MIN_DESCRIPTION_CHARS) {
            return {
                ok: false,
                error: 'THIN_CONTENT',
                message: `description ${desc.length} < ${MIN_DESCRIPTION_CHARS}`,
                partial: { description: desc, location: loc, method: extracted.method, sourceLabel },
                durationMs: Date.now() - t0,
            };
        }

        const payload = {
            description: desc,
            location: loc,
            method: extracted.method,
            confidence: extracted.confidence,
            sourceLabel,
            sourceHost: finalHost,
            finalUrl: extracted.finalUrl || applyUrl,
        };
        _resultCache.set(applyUrl, payload);
        return { ok: true, ...payload, durationMs: Date.now() - t0 };
    } catch (err) {
        return { ok: false, error: 'BROWSER_FAILURE', message: err?.message || String(err), durationMs: Date.now() - t0 };
    } finally {
        // Always close. `tabs.remove` is safer than `windows.remove` when
        // Chrome decides to merge the tab into another window on Linux —
        // close the tab and the window cleanup follows.
        if (tabId != null) {
            try { await chrome.tabs.remove(tabId); } catch {}
        }
        if (windowId != null) {
            try { await chrome.windows.remove(windowId); } catch {}
        }
        release();
    }
}
