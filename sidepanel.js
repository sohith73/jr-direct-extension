// Side panel controller. Three views:
//   1. login-view  — email + password client login
//   2. code-view   — operator enters 5-digit extension code
//   3. main-view   — capture + auto-pipeline for that client
//
// Backend URLs are baked into exports.js — no operator-side configuration.
// Settings panel only exposes auto-pipeline cadence.

import { API_URLS, API_BASE_URL } from './exports.js';

const $ = (id) => document.getElementById(id);

const els = {
    // login view
    loginView: $('login-view'),
    loginForm: $('login-form'),
    loginEmail: $('login-email'),
    loginPassword: $('login-password'),
    loginMessage: $('login-message'),
    loginSubmit: $('login-submit'),

    // code view (5-digit operator code)
    codeView: $('code-view'),
    codeForm: $('code-form'),
    codeInput: $('code-input'),
    codeMessage: $('code-message'),
    codeSubmit: $('code-submit'),
    codeBack: $('code-back'),

    // main view
    mainView: $('main-view'),
    clientName: $('client-name'),
    clientEmail: $('client-email'),
    logout: $('logout'),

    // live activity bar
    liveBar: $('live-bar'),
    liveStage: $('live-stage'),
    liveDetail: $('live-detail'),
    liveCounts: $('live-counts'),

    // (TODAY card removed — admin sees the same data in Clients-Tracking
    //  via the per-operator card backed by ExtensionSessionStat.)

    // settings (minimal — only cadence, threshold, auto toggle)
    aiThreshold: $('ai-threshold'),
    autoMode: $('auto-mode'),
    autoBatchSize: $('auto-batch-size'),
    shortcutsEnabled: $('shortcuts-enabled'),
    saveConfig: $('save-config'),
    configDetails: $('config-details'),

    // preferred + summary
    preferredRoles: $('preferred-roles'),
    summarySection: $('summary-section'),
    summaryStatus: $('summary-status'),
    summaryBody: $('summary-body'),

    // actions
    start: $('start'),
    judge: $('judge'),
    reset: $('reset'),

    // stats
    count: $('count'),
    captureCap: $('capture-cap'),
    picksCount: $('picks-count'),
    pushedCount: $('pushed-count'),
    clientCapStat: $('client-cap-stat'),
    capRemaining: $('cap-remaining'),
    capTotal: $('cap-total'),
    linkedinSkippedCount: $('linkedin-skipped-count'),
    activeState: $('active-state'),
    phase: $('phase'),
    batchInfo: $('batch-info'),
    statusDot: $('status-dot'),

    // progress
    progressSection: $('progress-section'),
    progressFill: $('progress-fill'),
    progressText: $('progress-text'),
    activityTicker: $('activity-ticker'),

    // message + outcomes
    message: $('message'),
    outcomesRow: $('outcomes-row'),
    chipPushed: $('chip-pushed'),
    chipDup: $('chip-dup'),
    chipBlocked: $('chip-blocked'),
    chipErrors: $('chip-errors'),

    // decisions
    decisionsSection: $('decisions-section'),
    decisionsList: $('decisions-list'),
    tabCountAll: $('tab-count-all'),
    tabCountPick: $('tab-count-pick'),
    tabCountSkip: $('tab-count-skip'),
    tabs: document.querySelectorAll('.tab'),

    // footer
    processingWarn: $('processing-warn'),
};

let cfg = {
    aiThreshold: 50,
    autoMode: true,
    autoBatchSize: 8,
    shortcutsEnabled: false,
    authToken: '',
    authEmail: '',
    authName: '',
    authProfile: null,
    extensionCode: '',
    operatorName: '',
    openaiKey: '',
};
// Capture cap mirrors background.js MAX_CAPTURES so labels stay in sync.
const CAPTURE_CAP = 100;

let captureCount = 0;
let linkedinSkippedCount = 0;
let captureActive = false;
// Mirrors background.state.auto.running. Disables Stop & push during auto-
// batch judging so the operator can't click mid-batch + see stale stats.
let autoRunning = false;
let isProcessing = false;
let isJudged = false;
let isResolving = false;
// Server-side client cap state. Mirrors background.js state.auto.{capHit,capInfo}.
// When true the panel disables Start, paints a sticky banner, and refuses to
// kick fresh capture sessions — pushes would 403 anyway.
let capHit = false;
let capInfoCache = null;
// Summary fetch state — purely cosmetic; lets renderSummarySection paint a
// "Refreshing…" placeholder while /get-profile is in flight on every panel open.
let summaryRefreshing = false;
let currentFilter = 'all';

const decisionsMap = new Map();

// ---- helpers -------------------------------------------------------------

function setMessage(text, kind = '') {
    els.message.className = `message ${kind}`;
    els.message.textContent = text || '';
}

function setLoginMessage(text, kind = '') {
    els.loginMessage.className = `login-msg ${kind}`;
    els.loginMessage.textContent = text || '';
}

// Eye toggle for password field
(function wireEye() {
    const btn = document.getElementById('toggle-password');
    const input = document.getElementById('login-password');
    const on = btn?.querySelector('.eye-on');
    const off = btn?.querySelector('.eye-off');
    if (!btn || !input || !on || !off) return;
    btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        on.hidden = !showing;
        off.hidden = showing;
        btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
})();

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function setProcessing(on, label = '') {
    isProcessing = on;
    els.processingWarn.hidden = !on;
    if (on) {
        els.progressSection.hidden = false;
        if (label) els.progressText.innerHTML = label;
    }
}

function pushTickerLine(text, kind = '') {
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    el.textContent = text;
    els.activityTicker.prepend(el);
    while (els.activityTicker.children.length > 30) {
        els.activityTicker.removeChild(els.activityTicker.lastChild);
    }
}

function setProgress(percent, label) {
    els.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (label) els.progressText.innerHTML = label;
}

function sendOnce(type, payload = {}) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
                const lastErr = chrome.runtime.lastError;
                if (lastErr) {
                    resolve({
                        ok: false,
                        error: 'SW_CHANNEL',
                        message: lastErr.message || 'service worker unreachable',
                    });
                    return;
                }
                if (resp === undefined) {
                    resolve({
                        ok: false,
                        error: 'SW_NO_RESPONSE',
                        message: 'service worker handler returned no response (likely threw or evicted mid-request — check SW console)',
                    });
                    return;
                }
                resolve(resp);
            });
        } catch (e) {
            resolve({ ok: false, error: 'SW_THROW', message: e?.message || 'sendMessage threw' });
        }
    });
}

// MV3 has a race window where a freshly-woken SW occasionally drops the
// FIRST message before its onMessage listener is fully attached. The
// caller sees "message port closed before a response was received".
// Retry once after a short pause — by then the SW is fully up.
async function send(type, payload = {}) {
    // Wake the SW first via a no-op ping so we don't race the wake on
    // the real call. Cheap when SW is already alive.
    if (!keepalivePort) {
        try { openKeepalive(); } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    let r = await sendOnce(type, payload);
    const TRANSIENT = ['SW_CHANNEL', 'SW_NO_RESPONSE', 'SW_THROW'];
    let attempt = 1;
    while (r && !r.ok && TRANSIENT.includes(r.error) && attempt < 3) {
        console.warn('[FF-JRD] send', type, 'transient', r.error, '— retry', attempt);
        // Ensure keepalive is open so next message keeps SW resident.
        if (!keepalivePort) try { openKeepalive(); } catch {}
        await new Promise((rs) => setTimeout(rs, 300 * attempt));
        r = await sendOnce(type, payload);
        attempt += 1;
    }
    if (r && !r.ok && TRANSIENT.includes(r.error)) {
        console.error('[FF-JRD] send', type, 'gave up after', attempt, 'attempts:', r.message);
    }
    return r;
}

// Keep the service worker alive while the panel is open. MV3 evicts SW
// after ~30s idle even when async handlers are pending. A periodic ping
// keeps the worker's idle timer reset so login + judge + push don't
// silently lose their async response.
let keepalivePort = null;
function openKeepalive() {
    try {
        keepalivePort = chrome.runtime.connect({ name: 'jrd-keepalive' });
        keepalivePort.onDisconnect.addListener(() => {
            keepalivePort = null;
            // Reconnect on next interval tick — helps survive SW restarts.
        });
    } catch (e) {
        console.warn('[FF-JRD] keepalive connect failed:', e?.message);
    }
}
openKeepalive();
setInterval(() => {
    if (!keepalivePort) openKeepalive();
    try { keepalivePort?.postMessage({ ping: Date.now() }); } catch {}
}, 20_000);

// ---- view switching -----------------------------------------------------

function showLogin() {
    els.loginView.hidden = false;
    if (els.codeView) els.codeView.hidden = true;
    els.mainView.hidden = true;
    els.loginEmail.value = '';
    els.loginPassword.value = '';
    setLoginMessage('');
}

function showCodeEntry() {
    els.loginView.hidden = true;
    if (els.codeView) els.codeView.hidden = false;
    els.mainView.hidden = true;
    if (els.codeInput) {
        els.codeInput.value = '';
        setTimeout(() => els.codeInput.focus(), 30);
    }
    setCodeMessage('');
}

function showMain() {
    els.loginView.hidden = true;
    if (els.codeView) els.codeView.hidden = true;
    els.mainView.hidden = false;
    applyState();
    renderClientBar();
    renderPreferredRoles();
    renderSummarySection();
    renderCapHitBanner();
    // Pull today's count + 14-day sparkline. Fire-and-forget — UI shows
    // a friendly skeleton while it loads.
    loadDailyStats().catch((e) => console.warn('[FF-JRD] loadDailyStats failed', e?.message));
    // Always-fresh profile (and therefore aiSummary). The cached authProfile
    // can be stale: the operator may have rebuilt the summary in the
    // clients-tracking portal between sessions, or another teammate may have
    // edited the profile. Fetch on every panel open + refuse to grade against
    // stale text.
    refreshProfileFromServer().catch((e) =>
        console.warn('[FF-JRD] refreshProfileFromServer failed', e?.message)
    );
    // Re-sync cap state on every open in case the operator pushed from another
    // device / the dashboard cap got raised.
    send('jrd-refresh-cap').then((r) => {
        if (r?.ok) {
            capInfoCache = r.capInfo || null;
            capHit = !!(capInfoCache && Number.isFinite(capInfoCache.remaining) && capInfoCache.remaining <= 0);
            renderCapHitBanner();
            applyState();
        }
    }).catch(() => {});
}

// refreshProfileFromServer: pulls the live profile (and therefore aiSummary)
// from the dashboard backend so the panel never grades against a cached
// summary. Uses background's reloadProfile which writes to chrome.storage +
// state.config.authProfile. Updates local cfg + repaints both summary +
// preferred-roles sections.
async function refreshProfileFromServer() {
    if (!cfg.authEmail) return;
    summaryRefreshing = true;
    renderSummarySection();
    const r = await send('jrd-reload-profile').catch((e) => ({ ok: false, error: 'NETWORK', message: e?.message }));
    summaryRefreshing = false;
    if (!r || !r.ok) {
        console.warn('[FF-JRD] reload-profile failed:', r?.error, r?.message);
        renderSummarySection();
        return;
    }
    cfg.authProfile = r.profile || cfg.authProfile;
    try { await chrome.storage.local.set({ authProfile: cfg.authProfile }); } catch {}
    renderClientBar();
    renderPreferredRoles();
    renderSummarySection();
}

// Quick-bump amount when operator clicks "+10 cap" on the banner. Big enough
// to clear a typical day's pipeline; small enough that an accidental click
// can't blow past the operator's intent.
const CAP_BUMP_DEFAULT = 10;

function renderCapHitBanner() {
    let bar = $('cap-hit-banner');
    if (!capHit) {
        if (bar) bar.remove();
        return;
    }
    // Prefer effectiveCap (incl. server-side default of 30) over the explicit
    // targetJobCount which is null for clients without an admin-set value.
    const total = capInfoCache?.effectiveCap ?? capInfoCache?.targetJobCount ?? '?';
    const isDefault = capInfoCache?.isDefaultCap === true;
    const current = capInfoCache?.currentOps ?? '?';
    const capLabel = isDefault ? `${total} (default)` : total;
    const text = `Daily cap reached — ${current} of ${capLabel} pushed today (resets 00:00 IST).`;
    const bumpTo = Number.isFinite(Number(total)) ? Number(total) + CAP_BUMP_DEFAULT : CAP_BUMP_DEFAULT;
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'cap-hit-banner';
        bar.className = 'cap-hit-banner';
        const main = els.mainView;
        if (main) main.insertBefore(bar, main.firstChild?.nextSibling || null);
    }
    bar.innerHTML = `
        <span class="cap-hit-icon">⛔</span>
        <span class="cap-hit-text">${escapeHtml(text)}</span>
        <button type="button" class="cap-bump-btn" id="cap-bump-btn" title="Raise cap to ${bumpTo} and resume">
            +${CAP_BUMP_DEFAULT} cap → ${bumpTo}
        </button>
        <div class="cap-bump-msg" id="cap-bump-msg" hidden></div>`;
    const btn = bar.querySelector('#cap-bump-btn');
    if (btn) btn.addEventListener('click', () => bumpCap(bumpTo));
}

// bumpCap: hits dashboard /update-target-jobs to raise the client's cap by
// CAP_BUMP_DEFAULT. On success, clears local capHit + refreshes capInfo so
// Start re-enables and the banner disappears. Fires inline error message
// otherwise (network down, cap too high, etc).
async function bumpCap(newCap) {
    if (!cfg.authEmail) return;
    const btn = $('cap-bump-btn');
    const msg = $('cap-bump-msg');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (msg) { msg.hidden = true; msg.textContent = ''; }
    let res;
    try {
        res = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}/update-target-jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: cfg.authEmail, targetJobCount: newCap }),
        });
    } catch (e) {
        if (msg) { msg.hidden = false; msg.textContent = `Network error: ${e.message}`; }
        if (btn) { btn.disabled = false; btn.textContent = `+${CAP_BUMP_DEFAULT} cap → ${newCap}`; }
        return;
    }
    let body = null; try { body = await res.json(); } catch {}
    if (!res.ok || !body?.success) {
        const m = body?.message || `HTTP ${res.status}`;
        if (msg) { msg.hidden = false; msg.textContent = `Failed: ${m}`; }
        if (btn) { btn.disabled = false; btn.textContent = `+${CAP_BUMP_DEFAULT} cap → ${newCap}`; }
        return;
    }
    // Server saved. Clear the gate locally + re-sync from /push-history so
    // the daily card + tile reflect the new remaining count immediately.
    capHit = false;
    capInfoCache = null;
    renderCapHitBanner();
    applyState();
    setMessage(`Cap raised to ${newCap}. Pipeline resumed.`, 'ok');
    pushTickerLine(`✓ cap raised to ${newCap}`, 'push');
    // Tell SW to re-pull push-history so its capInfo + capHit flag clear.
    send('jrd-refresh-cap').catch(() => {});
    loadDailyStats().catch(() => {});
}

// loadDailyStats: GET /push-history?email=X&days=14, paint today's count,
// cap progress, and 14-day sparkline. Refreshed on showMain + after every
// successful push. Server-truth, not local — survives SW eviction + dedup
// edge-cases.
// Live activity bar — single source of "what's happening right now".
// Hides when idle, shows during auto-batch / judging / pushing. Counts
// pill aggregate per-batch outcomes so operator sees rolling totals.
const liveCounts = { pushed: 0, dupes: 0, blocked: 0 };
let _liveResetTimer = null;
function setLive(stage, detail, kind = 'active') {
    if (!els.liveBar) return;
    els.liveBar.hidden = false;
    els.liveBar.classList.remove('success', 'error');
    if (kind === 'success') els.liveBar.classList.add('success');
    else if (kind === 'error') els.liveBar.classList.add('error');
    if (els.liveStage) els.liveStage.textContent = stage || 'Working';
    if (els.liveDetail) els.liveDetail.textContent = detail || '';
    renderLiveCounts();
    if (_liveResetTimer) { clearTimeout(_liveResetTimer); _liveResetTimer = null; }
}
function hideLive(delayMs = 0) {
    if (!els.liveBar) return;
    if (_liveResetTimer) clearTimeout(_liveResetTimer);
    _liveResetTimer = setTimeout(() => {
        els.liveBar.hidden = true;
        els.liveBar.classList.remove('success', 'error');
    }, delayMs);
}
function bumpLiveCount(kind) {
    if (kind === 'pushed') liveCounts.pushed += 1;
    else if (kind === 'duplicate') liveCounts.dupes += 1;
    else if (kind === 'blocked' || kind === 'error') liveCounts.blocked += 1;
    renderLiveCounts();
}
function resetLiveCounts() {
    liveCounts.pushed = 0; liveCounts.dupes = 0; liveCounts.blocked = 0;
    renderLiveCounts();
}
function renderLiveCounts() {
    if (!els.liveCounts) return;
    const parts = [];
    if (liveCounts.pushed > 0) parts.push(`<span class="pill pushed">✓ ${liveCounts.pushed}</span>`);
    if (liveCounts.dupes > 0)  parts.push(`<span class="pill dup">↺ ${liveCounts.dupes}</span>`);
    if (liveCounts.blocked > 0) parts.push(`<span class="pill block">⊘ ${liveCounts.blocked}</span>`);
    els.liveCounts.innerHTML = parts.join('');
}

let _dailyLoadInflight = null;
let _dailyRefreshTimer = null;
// Debounced refresh — auto-pipeline pushes can land in fast bursts; we
// only want ONE /push-history hit at the tail of the burst.
// TODAY card was removed — these are kept as no-op stubs so call sites
// stay valid. Backend still receives data via ExtensionSessionStat
// heartbeats and the Clients-Tracking admin view reads from there.
function scheduleDailyRefresh(delayMs = 1500) {
    if (_dailyRefreshTimer) clearTimeout(_dailyRefreshTimer);
    _dailyRefreshTimer = setTimeout(() => {
        _dailyRefreshTimer = null;
        loadDailyStats().catch(() => {});
    }, delayMs);
}
async function loadDailyStats() {
    if (!cfg.authEmail) return;
    if (_dailyLoadInflight) return _dailyLoadInflight;

    // SCRAPED / LINKEDIN / ROLE-MISS / PUSHED are sourced from the SW's
    // local todayMetrics accumulator (always accurate from operator's POV).
    // Server is consulted ONLY for cap state + lifetime-pushed cross-check
    // so the cap-hit gate stays in sync with /addjob.
    const emailLower = String(cfg.authEmail || '').trim().toLowerCase();
    const url = `${API_BASE_URL.replace(/\/+$/, '')}/extension/today-stats?clientEmail=${encodeURIComponent(emailLower)}&_=${Date.now()}`;
    _dailyLoadInflight = (async () => {
        // 1. Pull SW state for the local todayMetrics.
        const swState = await send('jrd-state').catch(() => null);
        const local = swState?.todayMetrics || {};

        // 2. Pull server for cap + server-truth pushed cross-check.
        let server = null;
        try {
            const res = await fetch(url, { cache: 'no-store' });
            const body = await res.json().catch(() => null);
            if (res.ok && body?.success) server = body;
            else console.warn('[FF-JRD] today-stats non-ok', res.status, body);
        } catch (e) {
            console.warn('[FF-JRD] today-stats fetch threw', e?.message);
        }

        const payload = {
            captures:        Number(local.captures) || 0,
            linkedinSkipped: Number(local.linkedinSkipped) || 0,
            roleMismatch:    Number(local.roleMismatch) || 0,
            pushed:          Number(local.pushed) || 0,
            serverPushed:    Number(server?.pushed) || 0,
            cap:             Number(server?.cap) || 0,
            isDefaultCap:    server?.isDefaultCap === true,
            remaining:       server?.remaining,
        };
        console.log('[FF-JRD] today-stats render', payload);
        renderTodayStats(payload);
    })();
    try { await _dailyLoadInflight; }
    finally { _dailyLoadInflight = null; }
}

// renderTodayStats: paints the four today-only tiles (Scraped / Pushed /
// LinkedIn skip / Role-miss) + cap progress bar. No history bars. Source:
// /extension/today-stats — combines ExtensionSessionStat (today) + JobModel
// ops count (today) + ProfileModel.targetJobCount.
// renderTodayStats: TODAY card is gone — this now ONLY syncs cap state
// into capInfoCache + capHit + the per-client stats tile so the cap-hit
// banner / Start button still react to dashboard cap changes. Tile DOM
// is no longer present.
function renderTodayStats(payload) {
    const localPushed = Number(payload?.pushed || 0);
    const serverPushed = Number(payload?.serverPushed || 0);
    const pushed = Math.max(localPushed, serverPushed);
    const cap = Number(payload?.cap || 0);
    const isDefault = payload?.isDefaultCap === true;
    const remaining = Number.isFinite(Number(payload?.remaining))
        ? payload.remaining
        : Math.max(0, cap - pushed);

    if (cap > 0) {
        capInfoCache = {
            targetJobCount: isDefault ? null : cap,
            effectiveCap: cap,
            isDefaultCap: isDefault,
            currentOps: pushed,
            remaining,
        };
        const shouldHit = remaining <= 0;
        if (shouldHit !== capHit) {
            capHit = shouldHit;
            renderCapHitBanner();
            applyState();
        }
    }

    if (els.clientCapStat && cap > 0) {
        els.clientCapStat.style.display = '';
        if (els.capRemaining) els.capRemaining.textContent = String(remaining);
        if (els.capTotal) els.capTotal.textContent = isDefault ? `of ${cap} (default)` : `of ${cap}`;
        els.clientCapStat.classList.toggle('over', remaining <= 0);
        els.clientCapStat.classList.toggle('warn', remaining > 0 && (remaining / Math.max(cap, 1)) <= 0.2);
    }
}

function setCodeMessage(text, kind = '') {
    if (!els.codeMessage) return;
    els.codeMessage.className = `login-msg ${kind}`;
    els.codeMessage.textContent = text || '';
}

function renderClientBar() {
    els.clientName.textContent = cfg.authName || '(no name)';
    els.clientEmail.textContent = cfg.authEmail || '';
}

function renderPreferredRoles() {
    const p = cfg.authProfile || {};
    const items = [];
    const fmt = (v) => Array.isArray(v) ? v.filter(Boolean).join(' · ')
        : typeof v === 'string' ? v.split(/\s*[/|,]\s*|\s{2,}/).filter(Boolean).join(' · ')
        : '';
    if (p.preferredRoles) items.push(`<span class="role-chip">${escapeHtml(fmt(p.preferredRoles))}</span>`);
    if (p.experienceLevel) items.push(`<span class="role-chip dim">${escapeHtml(p.experienceLevel)}</span>`);
    if (p.preferredLocations) items.push(`<span class="role-chip dim">${escapeHtml(fmt(p.preferredLocations))}</span>`);
    els.preferredRoles.innerHTML = items.join('');
}

function renderSummarySection() {
    const p = cfg.authProfile || {};
    const summary = p.aiSummary || '';
    const meta = p.aiSummaryMeta || {};
    const metaEl = $('summary-meta');
    if (summaryRefreshing && !summary) {
        els.summaryStatus.textContent = 'Refreshing…';
        els.summaryStatus.className = 'summary-status refreshing';
        els.summaryBody.className = 'summary-body empty-msg';
        els.summaryBody.textContent = 'Fetching latest summary from dashboard…';
        if (metaEl) { metaEl.hidden = true; metaEl.innerHTML = ''; }
        return;
    }
    if (summary) {
        const built = meta.builtAt ? new Date(meta.builtAt).toLocaleString() : 'unknown';
        const words = meta.wordCount || summary.split(/\s+/).filter(Boolean).length;
        els.summaryStatus.textContent = summaryRefreshing ? 'Refreshing…' : 'Saved';
        els.summaryStatus.className = summaryRefreshing ? 'summary-status refreshing' : 'summary-status fresh';
        els.summaryBody.className = 'summary-body loaded';
        els.summaryBody.textContent = summary;
        if (metaEl) {
            metaEl.hidden = false;
            metaEl.innerHTML = `
                <span class="meta-pill"><span class="meta-dot"></span>${escapeHtml(words)} words</span>
                <span class="meta-pill">gpt-4o-mini</span>
                <span class="meta-pill">Built ${escapeHtml(built)}</span>
            `;
        }
    } else {
        els.summaryStatus.textContent = 'Not built';
        els.summaryStatus.className = 'summary-status missing';
        els.summaryBody.className = 'summary-body empty-msg';
        els.summaryBody.textContent = 'No AI summary on file yet. Build one from the Clients-Tracking portal — it powers every auto-judge decision.';
        if (metaEl) {
            metaEl.hidden = true;
            metaEl.innerHTML = '';
        }
    }
}

// ---- stats / state ------------------------------------------------------

function applyState() {
    els.aiThreshold.value = String(cfg.aiThreshold ?? 50);
    if (els.autoMode) els.autoMode.checked = cfg.autoMode !== false;
    if (els.autoBatchSize) els.autoBatchSize.value = String(cfg.autoBatchSize ?? 8);
    if (els.shortcutsEnabled) els.shortcutsEnabled.checked = cfg.shortcutsEnabled === true;
    const hint = $('shortcut-hint');
    if (hint) hint.hidden = cfg.shortcutsEnabled !== true;
    els.count.textContent = String(captureCount);
    // Capture-cap color: amber at 80, red at 100.
    if (els.count) {
        els.count.classList.toggle('at-cap', captureCount >= CAPTURE_CAP);
        els.count.classList.toggle('near-cap', captureCount >= 80 && captureCount < CAPTURE_CAP);
    }
    els.linkedinSkippedCount.textContent = String(linkedinSkippedCount);
    els.activeState.textContent = captureActive ? 'YES' : 'no';
    els.statusDot.classList.toggle('active', !!captureActive);
    // Start disabled while session live OR an auto-batch is running OR a
    // manual flush is processing OR the client cap is reached.
    els.start.disabled = !!captureActive || isProcessing || autoRunning || capHit;
    if (capHit) {
        els.start.title = 'Client cap reached — raise the target on the dashboard before scraping more.';
    } else if (autoRunning) {
        els.start.title = 'Auto-batch in flight — wait for current batch to finish.';
    } else {
        els.start.title = '';
    }
    // The single Judge button: stops capture, then judges → resolves → pushes
    // everything captured. Stays enabled whenever there's something to judge.
    if (cfg.autoMode !== false) {
        if (isProcessing) {
            els.judge.textContent = 'Judging…';
            els.judge.title = 'Pipeline running — judge → resolve → push.';
            els.judge.disabled = true;
        } else {
            els.judge.textContent = captureCount > 0 ? `Judge (${captureCount})` : 'Judge';
            els.judge.title = autoRunning
                ? 'Auto-batch in flight. Click to queue judge + push for after it finishes.'
                : 'Stops capture, then judges + resolves + pushes all captured jobs.';
            els.judge.disabled = captureCount === 0;
        }
    } else {
        els.judge.textContent = 'Judge';
        els.judge.title = '';
        els.judge.disabled = !captureActive || captureCount === 0 || isProcessing || isJudged;
    }
    if (els.push) els.push.hidden = !isJudged || cfg.autoMode !== false;
    if (isJudged) updatePushButton();
}

function updatePushButton() {
    if (!els.push) return; // push button removed — auto-mode handles pushing
    const selectedCount = countSelectedPicks();
    els.pushCount.textContent = String(selectedCount);
    if (isResolving) {
        els.push.disabled = true;
        els.push.title = 'Waiting for full JD + real apply URLs to resolve…';
    } else {
        els.push.disabled = selectedCount === 0 || isProcessing;
        els.push.title = '';
    }
}

function countSelectedPicks() {
    let n = 0;
    for (const e of decisionsMap.values()) if (e.selectedPick) n += 1;
    return n;
}

// ---- decision card rendering -------------------------------------------

// Operator-facing labels for skipKind. Threshold = soft skip (a looser bar
// would have picked it). Mismatch = hard reject (would never pick).
const SKIP_KIND_LABELS = {
    'threshold':           'below threshold',
    'role-mismatch':       'role mismatch',
    'seniority-mismatch':  'seniority mismatch',
    'location-mismatch':   'location mismatch',
    'auth-mismatch':       'work-auth mismatch',
    'company-blocked':     'company blocked',
};
function skipKindLabel(kind) {
    return SKIP_KIND_LABELS[kind] || kind;
}

function scoreClass(score) {
    if (!Number.isFinite(score) || score === 0) return 's-zero';
    if (score >= 70) return 's-high';
    if (score >= 40) return 's-mid';
    return 's-low';
}

// ---- Indeed original-apply-URL cache (localStorage) ---------------------
// Resolved employer URLs persist across panel reloads so the operator never
// re-resolves the same job. Keyed by jobId.
const APPLY_CACHE_KEY = 'ffIndeedApplyUrls';
function loadApplyCache() {
    try { return JSON.parse(localStorage.getItem(APPLY_CACHE_KEY) || '{}') || {}; }
    catch { return {}; }
}
function cachedApplyUrl(jobId) {
    if (!jobId) return '';
    return loadApplyCache()[jobId] || '';
}
function saveApplyUrl(jobId, url) {
    if (!jobId || !url) return;
    try {
        const c = loadApplyCache();
        c[jobId] = url;
        localStorage.setItem(APPLY_CACHE_KEY, JSON.stringify(c));
    } catch { /* quota / disabled — ignore */ }
}
// An indeed.com redirect/placeholder URL (not yet the original employer URL).
function isIndeedRedirectUrl(u) {
    return /(^|\/\/)([^/]*\.)?indeed\.com\//i.test(String(u || ''));
}

function renderCard(entry) {
    const { decision, job, outcome, detail, pushing, selectedPick, manualFlip } = entry;
    const card = document.createElement('div');
    const effectivePick = isJudged ? !!selectedPick : !!decision.pick;
    const pickClass = effectivePick ? 'pick' : 'skip';
    const outcomeClass = outcome ? `outcome-${outcome}` : '';
    const pushingClass = pushing ? 'pushing' : '';
    const flipClass = manualFlip ? 'manual-flip' : '';
    // Skip kind drives the left-border colour so operator can scan failures
    // by category at a glance: gray=threshold, amber=ai-judged mismatch,
    // red=hard-signal violation. Picks always render with the accent border.
    const skipKindClass = decision.skipKind ? `skip-kind-${decision.skipKind}` : '';
    card.className = `decision-card ${pickClass} ${outcomeClass} ${pushingClass} ${flipClass} ${skipKindClass}`;
    card.dataset.jobId = decision.id;

    const meta = [];
    if (job.location) meta.push(`<span class="meta">📍 ${escapeHtml(job.location)}</span>`);
    if (job.workModel) meta.push(`<span class="meta">${escapeHtml(job.workModel)}</span>`);
    if (job.seniority) meta.push(`<span class="meta">${escapeHtml(job.seniority)}</span>`);
    if (job.salary) meta.push(`<span class="meta">${escapeHtml(job.salary)}</span>`);
    if (Number.isFinite(job.matchPercent) && job.matchPercent > 0) {
        meta.push(`<span class="meta">JR ${job.matchPercent}%</span>`);
    }
    if (Array.isArray(job.tags) && job.tags.length) {
        const flagTags = job.tags.filter((t) => /H1B|Comp\.|Citizens|Clearance|early applicant/i.test(t));
        for (const t of flagTags.slice(0, 3)) meta.push(`<span class="meta">${escapeHtml(t)}</span>`);
    }

    let actionsHtml = '';
    if (isJudged && !outcome) {
        const tCls = effectivePick ? 'is-pick' : 'is-skip';
        const tLabel = effectivePick ? '✓ pick' : '✗ skip';
        actionsHtml += `<button class="pick-toggle ${tCls}" data-toggle-jobid="${escapeHtml(decision.id)}" title="Click to flip pick/skip">${tLabel}</button>`;
    }
    if (job.applyUrl) {
        const blocked = String(job.applyUrl).startsWith('__LINKEDIN_BLOCKED__:');
        // Prefer a cached/resolved original employer URL over whatever the
        // job currently carries (which may still be an indeed redirect).
        const resolved = cachedApplyUrl(decision.id);
        const rawUrl = blocked
            ? String(job.applyUrl).replace('__LINKEDIN_BLOCKED__:', '')
            : (resolved || job.applyUrl);
        if (blocked) {
            actionsHtml += `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noreferrer" title="LinkedIn-hosted — auto-skipped per policy" style="text-decoration:line-through;color:var(--fg-muted)">View ↗</a>`;
        } else if (isIndeedRedirectUrl(rawUrl)) {
            // Still an Indeed redirect — offer to resolve the ORIGINAL
            // employer URL by opening it in a tab and following the chain.
            actionsHtml += `<button class="get-original-btn" data-resolve-jobid="${escapeHtml(decision.id)}" title="Open the apply link, follow Indeed's redirect to the company site, and store the original URL">Get original ↗</button>`;
            actionsHtml += `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noreferrer" style="color:var(--fg-muted);font-size:11px" title="Indeed redirect link">indeed ↗</a>`;
        } else {
            // Resolved employer URL.
            actionsHtml += `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(rawUrl)}">View ↗</a>`;
        }
    }
    // Job description — let the operator expand and verify the scraped JD
    // right in the panel (or see clearly when nothing was captured).
    const jd = String(job.description || '').trim();
    if (jd) {
        actionsHtml += `<button class="jd-toggle" data-jd-jobid="${escapeHtml(decision.id)}" title="Show the scraped job description">JD ↓</button>`;
    } else {
        actionsHtml += `<span class="jd-missing" title="No job description was scraped for this job">no JD</span>`;
    }
    let outcomeHtml = '';
    if (pushing) {
        outcomeHtml = `<span class="outcome-chip pushing">pushing…</span>`;
    } else if (outcome) {
        const label = outcome.replace(/-/g, ' ');
        outcomeHtml = `<span class="outcome-chip ${outcome}">${escapeHtml(label)}</span>`;
        if (detail && (outcome === 'blocked' || outcome === 'error' || outcome === 'duplicate')) {
            outcomeHtml += `<span class="meta">${escapeHtml(detail.slice(0, 120))}</span>`;
        }
    } else if (decision.pick === false) {
        outcomeHtml = `<span class="outcome-chip skipped">skipped</span>`;
    }

    card.innerHTML = `
        <div class="decision-head">
            <div class="decision-title">
                <div class="ttl">${escapeHtml(job.title || '(untitled)')}</div>
                <div class="co">${escapeHtml(job.company || '')}${job.industries ? ' · ' + escapeHtml(job.industries) : ''}</div>
            </div>
            <span class="score-pill ${scoreClass(decision.score)}">${decision.score}</span>
        </div>
        ${meta.length ? `<div class="decision-meta">${meta.join('')}</div>` : ''}
        ${decision.matchedRole ? `<div class="matched-role"><span class="matched-role-label">Maps to preferred role</span><span class="matched-role-val">${escapeHtml(decision.matchedRole)}</span></div>` : ''}
        ${decision.skipKind ? `<div class="skip-kind-tag skip-kind-tag-${escapeHtml(decision.skipKind)}">${escapeHtml(skipKindLabel(decision.skipKind))}</div>` : ''}
        ${decision.reason ? `<div class="decision-reason">${escapeHtml(decision.reason)}</div>` : ''}
        ${actionsHtml || outcomeHtml ? `<div class="decision-actions">${actionsHtml}${outcomeHtml}</div>` : ''}
        ${jd ? `<div class="jd-panel" data-jd-panel="${escapeHtml(decision.id)}" hidden><div class="jd-panel-meta">${jd.split(/\s+/).length} words</div><pre class="jd-panel-body">${escapeHtml(jd)}</pre></div>` : ''}
    `;
    return card;
}

function rebuildList() {
    const list = els.decisionsList;
    list.innerHTML = '';
    const entries = [...decisionsMap.values()];
    if (entries.length === 0) {
        list.innerHTML = '<div class="empty-state">No decisions yet. Capture some jobs and click <strong>Judge captured</strong>.</div>';
        return;
    }
    entries.sort((a, b) => {
        if (a.decision.pick !== b.decision.pick) return a.decision.pick ? -1 : 1;
        return (b.decision.score || 0) - (a.decision.score || 0);
    });
    let pickCount = 0, skipCount = 0;
    for (const e of entries) {
        if (e.decision.pick) pickCount += 1; else skipCount += 1;
        if (e.decision.pick && currentFilter === 'skip') continue;
        if (!e.decision.pick && currentFilter === 'pick') continue;
        list.appendChild(renderCard(e));
    }
    els.tabCountAll.textContent = String(entries.length);
    els.tabCountPick.textContent = String(pickCount);
    els.tabCountSkip.textContent = String(skipCount);
    els.picksCount.textContent = String(pickCount);
}

function ensureSectionVisible() { els.decisionsSection.hidden = false; }

function recomputeOutcomeChips() {
    let pushed = 0, dup = 0, blocked = 0, errors = 0;
    for (const e of decisionsMap.values()) {
        if (e.outcome === 'pushed') pushed += 1;
        else if (e.outcome === 'duplicate') dup += 1;
        else if (e.outcome === 'blocked') blocked += 1;
        else if (e.outcome === 'error') errors += 1;
    }
    els.chipPushed.textContent = `Pushed: ${pushed}`;
    els.chipDup.textContent = `Dupes: ${dup}`;
    els.chipBlocked.textContent = `Blocked: ${blocked}`;
    els.chipErrors.textContent = `Errors: ${errors}`;
    els.pushedCount.textContent = String(pushed);
    if (pushed + dup + blocked + errors > 0) els.outcomesRow.hidden = false;
}

function ingestDecision({ decision, job }) {
    decisionsMap.set(decision.id, {
        decision, job, outcome: null, detail: '', pushing: false,
        selectedPick: !!decision.pick, manualFlip: false,
    });
    ensureSectionVisible();
    rebuildList();
    updatePushButton();
}

function ingestPushStart({ jobId, title, company }) {
    const entry = decisionsMap.get(jobId);
    if (!entry) return;
    entry.pushing = true;
    decisionsMap.set(jobId, entry);
    rebuildList();
    pushTickerLine(`→ pushing "${title}" @ ${company}`, 'push');
}

function ingestPushResult({ jobId, outcome, detail }) {
    const entry = decisionsMap.get(jobId);
    if (!entry) return;
    entry.outcome = outcome;
    entry.detail = detail || '';
    entry.pushing = false;
    decisionsMap.set(jobId, entry);
    rebuildList();
    recomputeOutcomeChips();
}

function handleAiBatchStart({ batchIndex, totalBatches, batchSize, jobs }) {
    const titles = (jobs || []).map((j) => `"${j.title}" @ ${j.company}`).join(', ');
    pushTickerLine(`AI batch ${batchIndex}/${totalBatches} — ${batchSize}: ${titles}`, 'batch');
    els.batchInfo.textContent = `batch ${batchIndex}/${totalBatches}`;
    setProgress(((batchIndex - 1) / totalBatches) * 100,
        `<span class="step">AI batch ${batchIndex}/${totalBatches}</span> — judging ${batchSize}…`);
}

function handleAiProgress({ judged, total }) {
    setProgress((judged / total) * 100, `<span class="step">AI judging</span> ${judged}/${total} reviewed…`);
}

function handlePushProgress({ done, target }) {
    setProgress((done / target) * 100, `<span class="step">Pushing</span> ${done}/${target}…`);
}

// ---- async actions ------------------------------------------------------

async function loadCfgFromStorage() {
    try {
        const stored = await chrome.storage.local.get([
            'aiThreshold', 'autoMode', 'autoBatchSize', 'shortcutsEnabled',
            'openaiKey', 'authToken', 'authEmail', 'authName', 'authProfile',
            'extensionCode', 'operatorName',
        ]);
        for (const [k, v] of Object.entries(stored)) {
            if (v !== undefined && v !== null && v !== '') cfg[k] = v;
        }
    } catch {}
}

async function refreshState() {
    await loadCfgFromStorage();
    const s = await send('jrd-state');
    if (s) {
        cfg = { ...cfg, ...s.config };
        captureCount = s.capture?.count || 0;
        linkedinSkippedCount = s.capture?.linkedinSkipped || 0;
        captureActive = !!s.capture?.active;
        autoRunning = !!s.auto?.running;
        capHit = !!s.auto?.capHit;
        capInfoCache = s.auto?.capInfo || null;
        if (s.lastResult && Array.isArray(s.lastResult.decisions)) {
            decisionsMap.clear();
            for (const d of s.lastResult.decisions) {
                if (!d.job) continue;
                decisionsMap.set(d.id, {
                    decision: { id: d.id, pick: d.pick, score: d.score, reason: d.reason, matchedRole: d.matchedRole || '', skipKind: d.skipKind || '' },
                    job: d.job,
                    outcome: d.outcome === 'skipped-by-threshold' || d.outcome === 'skipped' ? null : d.outcome,
                    detail: d.detail || '',
                    pushing: false,
                    selectedPick: !!d.pick,
                    manualFlip: false,
                });
            }
            if (decisionsMap.size > 0) {
                ensureSectionVisible();
                rebuildList();
                recomputeOutcomeChips();
            }
        }
    }
    if (cfg.authToken && cfg.authEmail) {
        // Operator code is required before main view. If logged in but
        // no code yet, gate on the code-entry screen.
        if (!cfg.extensionCode || !/^\d{5}$/.test(String(cfg.extensionCode))) {
            showCodeEntry();
        } else {
            showMain();
        }
    } else {
        showLogin();
    }
}

// Login bypasses the service worker entirely — sidepanel iframe is at the
// extension origin with host_permissions covering the dashboard, so it
// can hit /extension/clientLogin directly. Avoids the MV3 message-channel
// race that was killing login responses ("port closed before reply").
async function doLogin(e) {
    e?.preventDefault();
    const email = els.loginEmail.value.trim().toLowerCase();
    const password = els.loginPassword.value;
    if (!email || !password) { setLoginMessage('Email + password required.', 'warn'); return; }
    els.loginSubmit.disabled = true;
    setLoginMessage('Authenticating…');
    let res;
    try {
        res = await fetch(API_URLS.CLIENT_LOGIN, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
    } catch (err) {
        els.loginSubmit.disabled = false;
        setLoginMessage(`Login failed: NETWORK — ${err.message}. Check that the dashboard backend at ${API_BASE_URL} is reachable.`, 'error');
        console.warn('[FF-JRD] doLogin fetch threw:', err);
        return;
    }
    let body = null;
    try { body = await res.json(); } catch {}
    els.loginSubmit.disabled = false;
    if (!res.ok) {
        const code = res.status === 401 ? 'INVALID_CREDS' : `HTTP_${res.status}`;
        setLoginMessage(`Login failed: ${code} — ${body?.message || `HTTP ${res.status}`}`, 'error');
        console.warn('[FF-JRD] login non-ok:', res.status, body);
        return;
    }
    if (!body?.token) {
        setLoginMessage(`Login failed: NO_TOKEN — server returned 200 but no token. Body keys: ${Object.keys(body || {}).join(', ')}`, 'error');
        return;
    }
    // Persist creds to chrome.storage so background sees them on next message.
    // openaiKey lives on the profile in dashboard Mongo — pull it forward
    // into state.config so the SW's auto-judge picks it up without any
    // operator-side paste step.
    const profileKey = (body.userProfile?.openaiKey || '').trim();
    const next = {
        authToken: body.token,
        authEmail: body.userDetails?.email || email,
        authName: body.userDetails?.name || '',
        authProfile: body.userProfile || null,
        authLoginAt: new Date().toISOString(),
        ...(profileKey ? { openaiKey: profileKey, openaiModel: 'gpt-4o-mini' } : {}),
    };
    try {
        await chrome.storage.local.set(next);
    } catch (e2) {
        console.warn('[FF-JRD] storage set failed:', e2?.message);
    }
    Object.assign(cfg, next);
    // Fire-and-forget sync to background. If it fails, no big deal — bg
    // reads storage lazily on next operation.
    send('jrd-save-config', { config: next }).catch(() => {});
    // After login → operator-code gate. Code is short-circuited if already
    // verified for this storage profile.
    if (cfg.extensionCode && /^\d{5}$/.test(String(cfg.extensionCode))) {
        setMessage(`Logged in as ${cfg.authName || cfg.authEmail}.`, 'ok');
        showMain();
    } else {
        showCodeEntry();
    }
}

// Hard-coded master code — bypasses /api/extension-codes/verify entirely.
// Never surface in UI. Used for ops-internal sessions and fallback when
// dashboard backend is unreachable. Keep this string out of any rendered
// hint/help text.
const MASTER_CODE = '00000';

// doSubmitCode: bypass SW — direct fetch to dashboard same way doLogin
// works. MV3 SW eviction during await closes the message port; calling
// from the sidepanel iframe avoids that race entirely. Endpoint matches
// jobTODashboard's `/api/extension-codes/verify`.
async function doSubmitCode(e) {
    e?.preventDefault();
    const code = (els.codeInput?.value || '').trim();
    if (!/^\d{5}$/.test(code)) {
        setCodeMessage('Code must be exactly 5 digits.', 'warn');
        return;
    }
    // Master-code shortcut — accept locally without hitting the dashboard.
    if (code === MASTER_CODE) {
        await acceptOperatorCode(code, 'admin');
        return;
    }
    els.codeSubmit.disabled = true;
    setCodeMessage('Verifying…');
    let res;
    try {
        res = await fetch(API_URLS.VERIFY_CODE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });
    } catch (err) {
        els.codeSubmit.disabled = false;
        setCodeMessage(`Network: ${err.message}. Check ${API_BASE_URL} reachable.`, 'error');
        return;
    }
    let body = null;
    try { body = await res.json(); } catch {}
    els.codeSubmit.disabled = false;
    if (!res.ok || !body?.valid) {
        const errCode = body?.error || (res.status === 401 ? 'INVALID' : `HTTP_${res.status}`);
        setCodeMessage(`Rejected: ${errCode}`, 'error');
        return;
    }
    await acceptOperatorCode(code, body.name || '');
}

// acceptOperatorCode: persist + sync to SW + transition to main view.
async function acceptOperatorCode(code, name) {
    cfg.extensionCode = code;
    cfg.operatorName = name || '';
    try {
        await chrome.storage.local.set({
            extensionCode: code,
            operatorName: name || '',
        });
    } catch {}
    // Fire-and-forget sync to SW. SW reads from storage on wake anyway,
    // so popup-close mid-call is harmless.
    send('jrd-save-config', { config: { extensionCode: code, operatorName: name || '' } }).catch(() => {});
    setMessage(`Verified as ${name || 'operator'}. Ready to scrape.`, 'ok');
    showMain();
}

async function doLogout() {
    await send('jrd-logout');
    cfg.authToken = ''; cfg.authEmail = ''; cfg.authName = ''; cfg.authProfile = null;
    cfg.extensionCode = ''; cfg.operatorName = '';
    captureCount = 0; linkedinSkippedCount = 0; captureActive = false; isJudged = false;
    decisionsMap.clear();
    if (els.todayCaptures) els.todayCaptures.textContent = '0';
    if (els.todayPushed)   els.todayPushed.textContent   = '0';
    if (els.todayLinkedin) els.todayLinkedin.textContent = '0';
    if (els.todayRolemiss) els.todayRolemiss.textContent = '0';
    if (els.todayCap)      els.todayCap.textContent      = '';
    if (els.dailySub)      els.dailySub.textContent      = 'resets at 00:00 IST';
    if (els.dailyFill)     els.dailyFill.style.width     = '0%';
    if (els.clientCapStat) els.clientCapStat.style.display = 'none';
    if (els.liveBar) els.liveBar.hidden = true;
    resetLiveCounts();
    showLogin();
}

async function saveConfig() {
    const config = {
        aiThreshold: Number.parseInt(els.aiThreshold.value, 10) || 50,
        autoMode: els.autoMode ? !!els.autoMode.checked : true,
        autoBatchSize: Math.max(1, Math.min(40, Number.parseInt(els.autoBatchSize?.value, 10) || 8)),
        shortcutsEnabled: els.shortcutsEnabled ? !!els.shortcutsEnabled.checked : false,
    };
    try {
        await chrome.storage.local.set(config);
        cfg = { ...cfg, ...config };
        await send('jrd-save-config', { config });
        setMessage('Settings saved.', 'ok');
        els.configDetails.open = false;
    } catch (e) { setMessage(`Save failed: ${e.message}`, 'error'); }
}

// Summary management lives in the Clients-Tracking portal — extension is
// read-only here. Build/edit happens at /ai-summaries on that portal.

async function startCapture() {
    // Wipe any stale capture buffer + decisions from the previous session
    // so captureCount starts at 0 and the side panel is clean. Cheap if
    // already empty.
    if (captureCount > 0) {
        await send('jrd-clear-capture').catch(() => {});
    }
    decisionsMap.clear();
    rebuildList();
    els.outcomesRow.hidden = true;
    els.decisionsSection.hidden = true;
    els.progressSection.hidden = true;
    els.activityTicker.innerHTML = '';
    els.batchInfo.textContent = '';
    els.pushedCount.textContent = '0';
    els.picksCount.textContent = '0';
    linkedinSkippedCount = 0;
    captureCount = 0;
    isJudged = false;
    if (els.count) els.count.textContent = '0';
    if (els.linkedinSkippedCount) els.linkedinSkippedCount.textContent = '0';
    resetLiveCounts();
    const r = await send('jrd-start-capture');
    if (r?.ok) {
        captureActive = true;
        captureCount = 0;
        applyState();
        setMessage('Capture started. Open jobright.ai/jobs/recommend — it auto-scrolls until the cap.', 'ok');
        setLive('Capturing', 'Auto-scrolling JR — auto-pipeline kicks off every batch.');
    } else { setMessage('Failed to start capture.', 'error'); }
}

async function runJudge() {
    // In auto-mode, the SW pipelines judge → resolve → push as the operator
    // scrolls. Manual click here drains anything not yet auto-batched and
    // halts capture. Buffer + stats stay visible so the operator can see the
    // session summary ("12 scraped · 3 pushed") until they click Start to
    // begin a fresh session — Start is the explicit reset trigger.
    if (cfg.autoMode !== false) {
        // 1. Halt fresh ingest. SW keeps the buffer for auto-pipeline drain.
        await send('jrd-stop-capture').catch(() => {});
        captureActive = false;

        // 2. Live feedback while the pipeline drains.
        setProcessing(true, '<span class="step">Stop & push</span> — draining pipeline…');
        const draining = captureCount > 0
            ? `Stopping capture · pushing remaining ${captureCount} captured jobs through judge → resolve → push…`
            : 'Stopping capture · finishing in-flight pushes…';
        setMessage(draining);
        setLive('Stopping', `Pushing ${captureCount} jobs — judge → resolve → push…`);
        applyState();

        const r = await send('jrd-flush-auto');
        if (!r?.ok) {
            setProcessing(false);
            setMessage(`Stop & push failed: ${r?.error || 'UNEXPECTED'} ${r?.message || ''}`, 'error');
            applyState();
            return;
        }
        const s = r.stats || {};

        // 3. Show summary — persistent until next Start. Buffer + counts stay.
        const totalsLine = `judged ${s.judged || 0} · picks ${s.picks || 0} · pushed ${s.pushed || 0} · dupes ${s.dupes || 0} · blocked ${s.blocked || 0} · errors ${s.errors || 0}`;
        setMessage(`✓ Session done — ${totalsLine}. Click Start to scrape more.`, 'ok');
        pushTickerLine(`✓ flushed — pushed ${s.pushed || 0} / picks ${s.picks || 0}`);
        setLive('Done', `Pushed ${s.pushed || 0} of ${s.picks || 0} picks · ${captureCount} scraped. Click Start for next session.`, 'success');

        // 4. Settle SW state. Don't clear — captureCount + stats stay visible.
        setProcessing(false);
        await refreshState().catch(() => {});

        // 5. Refresh today tile so SCRAPED / PUSHED / LINKEDIN populate from
        //    the just-logged ExtensionSessionStat row. SW's reportSessionStat
        //    fires inside flush; give it a beat then pull.
        setTimeout(() => loadDailyStats().catch(() => {}), 800);
        setTimeout(() => loadDailyStats().catch(() => {}), 2500);

        // 6. Visual nudge — flash Start button green.
        if (els.start && !els.start.disabled) {
            els.start.classList.add('start-armed');
            setTimeout(() => els.start?.classList.remove('start-armed'), 1600);
        }
        return;
    }
    // Manual fallback (autoMode disabled).
    setProcessing(true, '<span class="step">Loading profile</span>…');
    setMessage('Judging captured jobs against candidate brief…');
    decisionsMap.clear();
    rebuildList();
    els.outcomesRow.hidden = true;
    els.activityTicker.innerHTML = '';
    isJudged = false;
    applyState();
    const r = await send('jrd-judge-only');
    setProcessing(false);
    if (!r?.ok) {
        setMessage(`Judge failed: ${r?.error || 'UNEXPECTED'} ${r?.message || ''}`, 'error');
        applyState();
        return;
    }
    isJudged = true;
    setProgress(100, '<span class="step">Judged</span> — review picks, then push selected');
    const usedSummary = r.usedAiSummary ? 'using saved summary' : 'no summary — using raw profile';
    setMessage(`${r.total} jobs judged (${usedSummary}). Toggle picks below, then click Push.`, 'ok');
    pushTickerLine(`✓ judged ${r.total} (${usedSummary})`);
    applyState();
}

async function stopCapture() {
    if (!captureActive) { setMessage('Capture is already stopped.', 'warn'); return; }
    setMessage('Stopping capture — auto-pipeline will drain remaining jobs…');
    const r = await send('jrd-stop-capture');
    if (!r?.ok) { setMessage('Failed to stop capture.', 'error'); return; }
    captureActive = false;
    applyState();
    setMessage(`Capture stopped. ${r.count || captureCount} job${(r.count || captureCount) === 1 ? '' : 's'} in buffer — pipeline finishing.`, 'ok');
    setLive('Stopped', 'Auto-pipeline draining remaining picks…', 'success');
    hideLive(2500);
}

async function resetCapture() {
    await send('jrd-clear-capture');
    captureCount = 0; linkedinSkippedCount = 0; captureActive = false; isJudged = false;
    decisionsMap.clear();
    els.outcomesRow.hidden = true;
    els.decisionsSection.hidden = true;
    els.progressSection.hidden = true;
    els.activityTicker.innerHTML = '';
    els.batchInfo.textContent = '';
    els.pushedCount.textContent = '0';
    els.picksCount.textContent = '0';
    rebuildList();
    applyState();
    setMessage('Capture cleared.');
    if (els.liveBar) els.liveBar.hidden = true;
    resetLiveCounts();
}

function toggleCardPick(jobId) {
    const e = decisionsMap.get(jobId);
    if (!e) return;
    e.selectedPick = !e.selectedPick;
    e.manualFlip = e.selectedPick !== e.decision.pick;
    decisionsMap.set(jobId, e);
    rebuildList();
    updatePushButton();
}

// ---- events --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    switch (msg.type) {
        case 'today-metrics':
            // Live SW broadcast every time bumpToday() fires. Repaint tiles
            // immediately — no round-trip needed. Server fetch still runs
            // in the background to keep cap state fresh.
            renderTodayStats({
                captures:        Number(msg.captures) || 0,
                linkedinSkipped: Number(msg.linkedinSkipped) || 0,
                roleMismatch:    Number(msg.roleMismatch) || 0,
                pushed:          Number(msg.pushed) || 0,
                serverPushed:    Number(capInfoCache?.currentOps) || 0,
                cap:             Number(capInfoCache?.effectiveCap) || 0,
                isDefaultCap:    capInfoCache?.isDefaultCap === true,
                remaining:       capInfoCache?.remaining,
            });
            break;
        case 'count':
            captureCount = msg.count;
            applyState();
            if (msg.added > 0) {
                setMessage(`+${msg.added} captured (total ${msg.count}).`, 'ok');
                if (captureActive) {
                    setLive('Capturing', `${msg.count} job${msg.count === 1 ? '' : 's'} in buffer · auto-scrolling for more`);
                }
            }
            break;
        case 'reed-paging':
            // Reed is page-based — the content script fetches pages in the
            // background. Show the operator it's working (and to wait).
            setLive('Paging Reed', msg.text || 'Auto-capturing more Reed pages — please wait…', 'active');
            break;
        case 'flexa-paging':
            // Flexa is "Load More" based — the content script clicks it in the
            // background. Show the operator it's working (and to wait).
            setLive('Loading Flexa', msg.text || 'Auto-capturing more Flexa jobs — please wait…', 'active');
            break;
        case 'jr-paging':
            // JobRight auto-scrolls the recommendations list on its own while
            // capturing — the operator no longer has to scroll by hand.
            setLive('Auto-scrolling', msg.text || 'Auto-scrolling JobRight for more jobs — please wait…', 'active');
            break;
        case 'source-blocked': {
            const pretty = (s) => s === 'jobright' ? 'JobRight' : s === 'indeed' ? 'Indeed' : s === 'reed' ? 'Reed' : s === 'flexa' ? 'Flexa' : (s || 'this site');
            const allowed = (msg.allowed || ['jobright']).map(pretty).join(' / ');
            const site = pretty(msg.source);
            const hint = (msg.allowed || []).includes('jobright')
                ? `Open jobright.ai/jobs/recommend to scrape, or enable ${site} for this client in Clients-Tracking → AI Summary → Scrape sources.`
                : `Enable ${site} for this client in Clients-Tracking → AI Summary → Scrape sources.`;
            setMessage(`⚠ This client supports only ${allowed} — ${site} jobs are skipped. ${hint}`, 'warn');
            setLive(`${allowed}-only client`, `${site} jobs ignored — nothing captured here.`, 'error');
            break;
        }
        case 'auto-halted':
            setProcessing(false);
            setMessage(
                `⚠ Auto-judging paused after repeated failures (${msg.error || 'JUDGE_FAILED'}). ` +
                `Check your internet connection and OpenAI key, then click Judge to retry.`,
                'error',
            );
            setLive('Judging paused', `${msg.error || 'judge failed'} — fix, then click Judge.`, 'error');
            applyState();
            break;
        case 'linkedin-skip':
            linkedinSkippedCount = msg.count;
            applyState();
            setMessage(`Skipped ${msg.added} LinkedIn-hosted job${msg.added === 1 ? '' : 's'} (${msg.count} total).`, 'warn');
            for (const j of msg.latest || []) pushTickerLine(`linkedin skip · ${j.applyLink}`, 'batch');
            break;
        case 'phase':
            els.phase.textContent = msg.phase;
            if (msg.phase === 'resolving-jds') {
                setProcessing(true, `<span class="step">Resolving JDs</span> 0/${msg.total}…`);
                pushTickerLine(`→ phase: resolving full JDs (${msg.total} jobs)`, 'batch');
                setLive('Resolving JDs', `Pulling full job descriptions for ${msg.total} job${msg.total === 1 ? '' : 's'}…`);
            }
            if (msg.phase === 'judging') {
                setProcessing(true, `<span class="step">AI judging</span> ${msg.total} captured jobs (full JD)…`);
                pushTickerLine(`→ phase: judging (${msg.total} jobs)`, 'batch');
                setLive('Judging', `Scoring ${msg.total} job${msg.total === 1 ? '' : 's'} against full JD…`);
            }
            if (msg.phase === 'pushing') {
                setProgress(0, `<span class="step">Pushing</span> 0/${msg.toPush}…`);
                pushTickerLine(`→ phase: pushing (${msg.toPush} picks)`, 'push');
                setLive('Pushing', `Sending ${msg.toPush} pick${msg.toPush === 1 ? '' : 's'} to dashboard…`);
            }
            if (msg.phase === 'awaiting-resolve') {
                setMessage('Waiting for full JD resolution to finish before push…', 'warn');
                pushTickerLine('⏳ push paused — finishing full-JD resolve');
                setLive('Awaiting JD', 'Scraper still extracting full job descriptions…');
            }
            if (msg.phase === 'done') {
                pushTickerLine(`✓ phase: done`);
                setLive('Done', 'Run complete.', 'success');
                hideLive(2200);
            }
            if (msg.phase === 'cap-reached') {
                captureActive = false;
                applyState();
                setMessage(`Buffer full (${msg.cap || CAPTURE_CAP} captures). Capture auto-stopped — click "Stop scraping & push" to flush + reset.`, 'warn');
                pushTickerLine(`⚑ buffer full — click Stop & push to flush`, 'batch');
                setLive('Buffer full', `Click Stop & push (${captureCount}) to drain pipeline + re-arm Start.`, 'success');
                // Highlight the flush button so operator's eye is drawn there.
                if (els.judge && !els.judge.disabled) {
                    els.judge.classList.add('start-armed');
                    setTimeout(() => els.judge?.classList.remove('start-armed'), 2400);
                }
            }
            if (msg.phase === 'auto-cycle-flushing') {
                // Auto-run: 100-buffer full — flushing (judge + push) before the
                // next 100. Capture stays "active" from the operator's view.
                pushTickerLine(`⟳ batch ${msg.batch}: buffer full — flushing (judge + push)…`, 'batch');
                setLive('Auto-run', `Batch ${msg.batch}: pushing this 100, then capturing the next…`, 'active');
            }
            if (msg.phase === 'auto-cycle') {
                // Flushed + reset; capturing resumes automatically.
                captureActive = true;
                applyState();
                const s = msg.stats || {};
                pushTickerLine(`✓ batch ${msg.batch} pushed (picks ${s.picks || 0}) — capturing next 100…`, 'push');
                setMessage(`Auto-run: batch ${msg.batch} done — continuing to the next 100.`, 'ok');
                setLive('Auto-run', `Batch ${msg.batch} pushed · auto-scrolling for the next 100…`, 'active');
            }
            if (msg.phase === 'session-complete') {
                captureActive = false;
                applyState();
                const s = msg.stats || {};
                const why = msg.reason === 'cap-hit' ? 'client target reached'
                    : msg.reason === 'exhausted' ? 'no more JobRight recommendations'
                    : msg.reason === 'max-batches' ? 'safety limit reached'
                    : msg.reason === 'judge-halted' ? 'judging paused on errors'
                    : 'finished';
                setMessage(`Auto-run complete — ${why}. ${msg.batches || 0} batch${(msg.batches || 0) === 1 ? '' : 'es'} pushed.`, 'ok');
                pushTickerLine(`■ auto-run complete (${why}) — ${msg.batches || 0} batches`, 'push');
                setLive('Auto-run complete', `${why} · ${msg.batches || 0} batches pushed.`, 'success');
                hideLive(4000);
            }
            if (msg.phase === 'cap-hit') {
                // Server-side client cap (targetJobCount) reached. Hard halt:
                // capture stops, no further pushes, banner stays until resolved.
                captureActive = false;
                capHit = true;
                capInfoCache = msg.capInfo || capInfoCache;
                applyState();
                renderCapHitBanner();
                setMessage(msg.message || 'Client target reached — pushes halted.', 'error');
                pushTickerLine(`⊗ client cap reached — pipeline halted`, 'push');
                setLive('Cap hit', msg.message || 'Client target reached.', 'error');
                hideLive(0);
                // Refresh the daily card so the tile reflects "0 remaining".
                scheduleDailyRefresh(50);
            }
            break;
        case 'judge-prep':
            // Pre-judge JD resolve progress. Updates the live bar so the
            // operator sees "Resolving 3/5 JDs…" before the GPT call fires.
            if (msg.stage === 'resolving') {
                setLive('Resolving JDs', `Pulling full descriptions for ${msg.total} job${msg.total === 1 ? '' : 's'}…`);
            } else if (msg.stage === 'resolved') {
                setLive('Resolving JDs', `${msg.done || 0}/${msg.total} JDs ready · then GPT scores…`);
            }
            break;
        case 'jd-extract-start': {
            const host = (() => {
                try { return new URL(msg.jobLink || '').hostname.replace(/^www\./, ''); }
                catch { return msg.source || 'scraper'; }
            })();
            const route = msg.route || (msg.source === 'employer' ? '/extract/infor' : '/api/jr/job-detail');
            pushTickerLine(`→ JD extract sent · ${host} · ${route}`, 'batch');
            setLive('Extracting JD', `Sending ${host} job page to Playwright scraper…`);
            break;
        }
        case 'jd-extract-result': {
            const label = [msg.provider, msg.country || msg.location]
                .filter(Boolean)
                .join(' · ');
            const title = msg.title || 'Job';
            pushTickerLine(`✓ JD extracted · ${title.slice(0, 48)} · ${msg.descLen || 0} chars${label ? ` · ${label}` : ''}`, 'batch');
            setLive(
                'JD ready',
                `${msg.descLen || 0} chars${msg.country ? ` · ${msg.country}` : ''}${msg.provider ? ` · ${msg.provider}` : ''}`,
                'success',
            );
            break;
        }
        case 'jd-extract-error': {
            pushTickerLine(`✗ JD extract failed · ${msg.error || 'ERROR'}${msg.message ? ` · ${String(msg.message).slice(0, 80)}` : ''}`, 'batch');
            setLive('JD extract failed', msg.error || msg.message || 'Scraper failed', 'error');
            break;
        }
        case 'ai-batch-start': handleAiBatchStart(msg); break;
        case 'ai-progress': handleAiProgress(msg); break;
        case 'push-progress': handlePushProgress(msg); break;
        case 'decision': ingestDecision({ decision: msg.decision, job: msg.job }); break;
        case 'push-start':
            ingestPushStart({ jobId: msg.jobId, title: msg.title, company: msg.company });
            setLive(
                'Pushing',
                `${(msg.title || 'Untitled').slice(0, 60)} @ ${(msg.company || 'Unknown')}`,
            );
            break;
        case 'push-result':
            ingestPushResult({ jobId: msg.jobId, outcome: msg.outcome, detail: msg.detail });
            bumpLiveCount(msg.outcome);
            if (msg.outcome === 'pushed') scheduleDailyRefresh();
            break;
        case 'auto-batch-start':
            autoRunning = true;
            applyState();
            pushTickerLine(`⚙ auto batch — ${msg.size} jobs → judging`, 'batch');
            ensureSectionVisible();
            resetLiveCounts();
            setLive('Auto batch', `Judging ${msg.size} captured job${msg.size === 1 ? '' : 's'} via OpenAI…`);
            break;
        case 'auto-batch-end':
            autoRunning = false;
            applyState();
            // Clear the in-progress bar regardless of success/error so the
            // panel doesn't get stuck mid-batch (e.g. PROFILE_LOAD error
            // leaving the "AI judging 8/8" bar frozen).
            setProgress(0, '');
            if (els.progressSection) els.progressSection.hidden = true;
            if (msg.error) {
                pushTickerLine(`✗ auto batch error: ${msg.error}`, 'batch');
                setLive('Batch error', String(msg.error), 'error');
                hideLive(3500);
            } else if (msg.stats) {
                const s = msg.stats;
                pushTickerLine(`✓ auto totals — judged ${s.judged} · picks ${s.picks} · pushed ${s.pushed} · dupes ${s.dupes} · blocked ${s.blocked} · errors ${s.errors}`, 'batch');
                setLive(
                    'Batch done',
                    `${s.picks} pick${s.picks === 1 ? '' : 's'} · ${s.pushed} pushed · ${s.dupes} dupe${s.dupes === 1 ? '' : 's'} · ${s.blocked} blocked`,
                    'success',
                );
                hideLive(2500);
            }
            break;
        case 'applyurl-resolved': {
            // Cache only genuine employer URLs (not the indeed fallback) so
            // the View link survives panel reloads.
            if (msg.applyUrl && !isIndeedRedirectUrl(msg.applyUrl)) {
                saveApplyUrl(msg.jobId, msg.applyUrl);
            }
            const e = decisionsMap.get(msg.jobId);
            if (e?.job) {
                e.job = { ...e.job, applyUrl: msg.applyUrl };
                decisionsMap.set(msg.jobId, e);
                rebuildList();
            } else {
                rebuildList();
            }
            break;
        }
        case 'applyurl-blocked-linkedin': {
            const e = decisionsMap.get(msg.jobId);
            if (e?.job) {
                e.job = { ...e.job, applyUrl: msg.applyUrl };
                e.selectedPick = false;
                e.manualFlip = true;
                decisionsMap.set(msg.jobId, e);
                rebuildList();
                updatePushButton();
                pushTickerLine(`linkedin · ${msg.applyUrl} (auto-skipped)`, 'batch');
            }
            break;
        }
        case 'resolve-start':
            isResolving = true;
            updatePushButton();
            setMessage(`Resolving full JD + real apply URLs for ${msg.total} picks… (Push waits for this)`, 'ok');
            pushTickerLine(`→ resolving ${msg.total} jobs (full JD)…`, 'batch');
            break;
        case 'resolve-progress':
            setProgress(
                (msg.done / msg.total) * 100,
                `<span class="step">Resolving</span> ${msg.done}/${msg.total} (fetching full JD from JR)`,
            );
            break;
        case 'resolve-done': {
            isResolving = false;
            updatePushButton();
            const parts = [];
            if (msg.resolved) parts.push(`${msg.resolved} resolved`);
            if (msg.linkedinDropped) parts.push(`${msg.linkedinDropped} LinkedIn auto-skipped`);
            if (msg.failed) parts.push(`${msg.failed} failed`);
            const text = parts.length ? parts.join(', ') : 'no JR fallbacks to resolve';
            setMessage(`Full JD ready — ${text}. Click Push when ready.`, msg.failed ? 'warn' : 'ok');
            pushTickerLine(`✓ resolve done: ${text}`);
            break;
        }
        case 'summary-phase': {
            const map = { 'requesting': 'POSTing /build-ai-summary…', 'done': 'Summary saved.' };
            const text = map[msg.phase] || msg.phase;
            setProgress(msg.phase === 'done' ? 100 : 30, `<span class="step">Build summary</span> — ${escapeHtml(text)}`);
            pushTickerLine(`summary: ${text}`);
            break;
        }
    }
});

// Wire DOM
els.loginForm.addEventListener('submit', doLogin);
if (els.codeForm) els.codeForm.addEventListener('submit', doSubmitCode);
if (els.codeBack) els.codeBack.addEventListener('click', () => {
    cfg.authToken = ''; cfg.authEmail = ''; cfg.authProfile = null;
    chrome.storage.local.remove(['authToken', 'authEmail', 'authName', 'authProfile', 'authLoginAt']).catch(() => {});
    showLogin();
});
els.logout.addEventListener('click', doLogout);
const shortcutHintBtn = $('shortcut-hint');
if (shortcutHintBtn) shortcutHintBtn.addEventListener('click', () => toggleShortcutHelp());
els.saveConfig.addEventListener('click', saveConfig);
els.start.addEventListener('click', startCapture);
els.judge.addEventListener('click', runJudge);
els.reset.addEventListener('click', resetCapture);

els.decisionsList.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle-jobid]');
    if (toggle) {
        e.preventDefault();
        toggleCardPick(toggle.dataset.toggleJobid);
        return;
    }
    const resolveBtn = e.target.closest('[data-resolve-jobid]');
    if (resolveBtn) {
        e.preventDefault();
        resolveOriginalUrl(resolveBtn);
        return;
    }
    const jdBtn = e.target.closest('[data-jd-jobid]');
    if (jdBtn) {
        e.preventDefault();
        const panel = jdBtn.closest('.decision-card')?.querySelector(`[data-jd-panel="${CSS.escape(jdBtn.dataset.jdJobid)}"]`);
        if (panel) {
            const open = panel.hidden;
            panel.hidden = !open;
            jdBtn.textContent = open ? 'JD ↑' : 'JD ↓';
            jdBtn.classList.toggle('open', open);
        }
    }
});

// "Get original ↗" — ask the SW to open the apply link in a tab, follow
// Indeed's redirect to the employer site, store + show that URL.
async function resolveOriginalUrl(btn) {
    const jobId = btn.dataset.resolveJobid;
    if (!jobId || btn.disabled) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Resolving…';
    try {
        const r = await send('jrd-resolve-apply', { jobId });
        if (r && r.ok && r.applyUrl && !isIndeedRedirectUrl(r.applyUrl)) {
            saveApplyUrl(jobId, r.applyUrl);
            rebuildList();
        } else {
            btn.textContent = 'No direct URL';
            setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 2500);
        }
    } catch {
        btn.textContent = prev;
        btn.disabled = false;
    }
}

els.tabs.forEach((t) => {
    t.addEventListener('click', () => {
        els.tabs.forEach((x) => x.classList.toggle('active', x === t));
        currentFilter = t.dataset.filter;
        rebuildList();
    });
});

window.addEventListener('beforeunload', (e) => {
    if (isProcessing) {
        e.preventDefault();
        e.returnValue = 'Processing is still running — are you sure you want to close?';
        return e.returnValue;
    }
});

// ---- keyboard shortcuts -------------------------------------------------
//
// S=start · D=stop · K=judge · R=reset · ?=help · Esc=close help.
// Skip when focus lives in a form control (don't hijack typing) and skip
// when the panel is on the login or code view (creds/codes need every key).
const SHORTCUTS = [
    { key: 's', label: 'Start capture',  run: () => safeClick(els.start) },
    { key: 'd', label: 'Stop capture',   run: () => stopCapture() },
    { key: 'k', label: 'Judge',          run: () => safeClick(els.judge) },
    { key: 'r', label: 'Reset session',  run: () => safeClick(els.reset) },
    { key: '?', label: 'Toggle help',    run: () => toggleShortcutHelp() },
];

function safeClick(btn) {
    if (!btn || btn.hidden || btn.disabled) {
        setMessage(`Shortcut ignored — ${btn?.id || 'button'} not actionable right now.`, 'warn');
        return;
    }
    btn.click();
}

function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
}

document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    // Only main view honors shortcuts — login/code views need every keystroke.
    if (els.mainView?.hidden) {
        if (e.key === 'Escape' && !els.shortcutHelp?.hidden) toggleShortcutHelp(false);
        return;
    }
    // Esc still closes help even when shortcuts disabled (so a user who
    // toggled them off mid-overlay can dismiss it).
    if (e.key === 'Escape') {
        if (els.shortcutHelp && !els.shortcutHelp.hidden) {
            toggleShortcutHelp(false);
            e.preventDefault();
        }
        return;
    }
    if (cfg.shortcutsEnabled !== true) return;
    const k = e.key.toLowerCase();
    const sc = SHORTCUTS.find((s) => s.key === k);
    if (!sc) return;
    e.preventDefault();
    sc.run();
});

function toggleShortcutHelp(force) {
    let panel = els.shortcutHelp || $('shortcut-help');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'shortcut-help';
        panel.className = 'shortcut-help';
        panel.innerHTML = `
            <div class="shortcut-help-card">
                <div class="shortcut-help-head">
                    <span class="shortcut-help-title">Keyboard shortcuts</span>
                    <button type="button" class="shortcut-help-close" aria-label="Close">×</button>
                </div>
                <div class="shortcut-help-body">
                    ${SHORTCUTS.map((s) => `
                        <div class="shortcut-row">
                            <kbd>${escapeHtml(s.key.toUpperCase())}</kbd>
                            <span>${escapeHtml(s.label)}</span>
                        </div>
                    `).join('')}
                    <div class="shortcut-row">
                        <kbd>Esc</kbd><span>Close this overlay</span>
                    </div>
                </div>
                <div class="shortcut-help-foot">Shortcuts ignored when typing in inputs.</div>
            </div>`;
        document.body.appendChild(panel);
        els.shortcutHelp = panel;
        panel.querySelector('.shortcut-help-close').addEventListener('click', () => toggleShortcutHelp(false));
        panel.addEventListener('click', (e) => { if (e.target === panel) toggleShortcutHelp(false); });
    }
    const next = typeof force === 'boolean' ? force : panel.hidden;
    panel.hidden = !next;
}

// Boot
refreshState();

// Cap-state poll — TODAY card is gone but we still need cap-hit gating
// driven by /extension/today-stats (server returns effectiveCap +
// remaining). Polls every 30s while main view open.
setInterval(() => {
    if (els.mainView?.hidden) return;
    if (!cfg.authEmail) return;
    loadDailyStats().catch(() => {});
}, 30000);
