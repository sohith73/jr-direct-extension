// MV3 service worker.
//
// Owns:
//   • the captured-jobs buffer (Map<jobId, job> — deduped)
//   • config persisted in chrome.storage.local (auth + 5-digit op code,
//     OpenAI key from server-side profile, picked client)
//   • the AI relevance call (OpenAI gpt-4o-mini, JSON mode)
//   • the dashboard push (POST /addjob)
//
// Backend URLs live in exports.js — edit there to switch envs. Operator
// settings only expose the auto-pipeline cadence.

import { API_URLS, API_BASE_URL, SCRAPER_BASE_URL } from './exports.js';

const DEFAULTS = {
    aiThreshold: 50,
    // Auto pipeline: when true, the SW judges + resolves + pushes jobs
    // automatically as the operator scrolls. Triggers a batch every
    // `autoBatchSize` newly captured jobs. No manual Push needed.
    autoMode: true,
    autoBatchSize: 8,
    autoPushConcurrency: 3,
    // OpenAI direct-call config — must be in DEFAULTS so loadConfig() pulls
    // it from chrome.storage.local after SW eviction. Without this in the
    // key list the SW silently loses the key on every wakeup.
    openaiKey: '',
    // Model is hard-coded — do NOT make user-configurable. Any change requires
    // a code edit so accidental swaps to a costlier or worse-fit model are
    // impossible from the UI.
    openaiModel: 'gpt-4o-mini',
    // Authenticated client session (one client per login).
    authToken: '',
    authEmail: '',
    authName: '',
    authProfile: null,
    authLoginAt: '',
    // 5-digit operator code (verified via /api/extension-codes/verify).
    // Sent on every /addjob so the dashboard knows which operator pushed.
    extensionCode: '',
    operatorName: '',
};

// In-memory state. Volatile across service-worker eviction. We persist
// the bits the user spent real time creating (capture.jobs, judged) so
// the operator doesn't lose work between Judge and Push when SW idles out.
const state = {
    config: { ...DEFAULTS },
    capture: {
        active: false,
        startedAt: null,
        jobs: new Map(), // jobId → scraped card
        linkedinSkipped: new Map(), // jobId → applyLink (visible-to-operator log)
    },
    // Per-day local accumulator — survives session resets, panel reloads,
    // and SW eviction. Source of truth for the extension's "Today" tile.
    // Date-stamped so it auto-resets at IST midnight on first event of the
    // new day. Persisted to chrome.storage.local under TODAY_KEY.
    todayMetrics: {
        date: '',           // YYYY-MM-DD in IST
        client: '',         // client email — resets when client switches
        captures: 0,        // total job cards scraped today (incl. LinkedIn)
        linkedinSkipped: 0, // LinkedIn-only postings filtered out
        pushed: 0,          // successfully landed in dashboard tracker
        roleMismatch: 0,    // AI rejected: title doesn't match preferred roles
        otherSkip: 0,       // threshold + seniority + location + auth + other
    },
    // After judgeOnly: { decisions, jobs, completedAt } — used by pushSelected.
    judged: null,
    lastResult: null,
    // Auto-pipeline runtime tracking. processed = jobIds we've already
    // dispatched to a batch; running = batch in flight; profile cached
    // for the duration of capture so we don't refetch every batch.
    auto: {
        running: false,
        processed: new Set(),
        profile: null,
        aiSummary: '',
        stats: { judged: 0, picks: 0, pushed: 0, dupes: 0, blocked: 0, errors: 0, skipsByKind: {} },
        // Hard stop. Flips true on first server TARGET_REACHED reply OR
        // when /push-history reports remaining=0. While true the SW refuses
        // to fire new batches, refuses individual pushes, and auto-stops
        // capture so the operator gets clear "cap hit" feedback instead of
        // every push silently failing.
        capHit: false,
        capInfo: null, // { targetJobCount, current, remaining } from server
    },
};

const PERSIST_KEYS = {
    captureActive: 'jrd_capture_active',
    captureJobs: 'jrd_capture_jobs',
    captureStartedAt: 'jrd_capture_startedAt',
    judged: 'jrd_judged',
};
const TODAY_KEY = 'jrd_today_metrics';

// IST date string ("YYYY-MM-DD"). Used as the bucket key for todayMetrics
// so the counters auto-reset at 00:00 IST without a cron job. IST is fixed
// UTC+5:30 (no DST), so we shift current UTC by 5.5h and slice.
function istDateKey(now = new Date()) {
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
}

// Pull persisted today-metrics from chrome.storage.local at SW boot. Resets
// when the date changes (operator left the panel open across midnight) or
// when the active client switches (each client has its own bucket).
async function loadTodayMetrics() {
    try {
        const s = await chrome.storage.local.get(TODAY_KEY);
        const persisted = s?.[TODAY_KEY];
        if (persisted && typeof persisted === 'object' && persisted.date === istDateKey()) {
            state.todayMetrics = {
                date: persisted.date,
                client: persisted.client || '',
                captures: Number(persisted.captures) || 0,
                linkedinSkipped: Number(persisted.linkedinSkipped) || 0,
                pushed: Number(persisted.pushed) || 0,
                roleMismatch: Number(persisted.roleMismatch) || 0,
                otherSkip: Number(persisted.otherSkip) || 0,
            };
        } else {
            resetTodayMetrics(persisted?.client || '');
        }
    } catch {}
}

async function persistTodayMetrics() {
    try {
        await chrome.storage.local.set({ [TODAY_KEY]: state.todayMetrics });
    } catch {}
}

function resetTodayMetrics(client = '') {
    state.todayMetrics = {
        date: istDateKey(),
        client,
        captures: 0,
        linkedinSkipped: 0,
        pushed: 0,
        roleMismatch: 0,
        otherSkip: 0,
    };
    persistTodayMetrics();
}

// Increment a metric. Auto-rolls over at IST midnight + auto-resets when
// the active client changes (per-client buckets). All inc paths funnel
// through here so persistence + roll-over are consistent.
function bumpToday(field, delta = 1) {
    const today = istDateKey();
    const activeClient = String(state.config.authEmail || '').trim().toLowerCase();
    if (state.todayMetrics.date !== today
        || (activeClient && state.todayMetrics.client && state.todayMetrics.client !== activeClient)) {
        resetTodayMetrics(activeClient);
    } else if (activeClient && !state.todayMetrics.client) {
        state.todayMetrics.client = activeClient;
    }
    state.todayMetrics[field] = (Number(state.todayMetrics[field]) || 0) + Number(delta || 0);
    persistTodayMetrics();
    notifyPopup('today-metrics', { ...state.todayMetrics });
}

async function persistCapture() {
    try {
        await chrome.storage.session.set({
            [PERSIST_KEYS.captureActive]: state.capture.active,
            [PERSIST_KEYS.captureStartedAt]: state.capture.startedAt,
            [PERSIST_KEYS.captureJobs]: [...state.capture.jobs.entries()],
        });
    } catch (e) { console.warn('[FF-JRD] persistCapture failed', e?.message); }
}

async function persistJudged() {
    try {
        await chrome.storage.session.set({
            [PERSIST_KEYS.judged]: state.judged,
        });
    } catch (e) { console.warn('[FF-JRD] persistJudged failed', e?.message); }
}

async function restoreState() {
    try {
        const s = await chrome.storage.session.get(Object.values(PERSIST_KEYS));
        const entries = s[PERSIST_KEYS.captureJobs];
        if (Array.isArray(entries)) {
            state.capture.jobs = new Map(entries);
        }
        if (typeof s[PERSIST_KEYS.captureActive] === 'boolean') {
            state.capture.active = s[PERSIST_KEYS.captureActive];
        }
        if (s[PERSIST_KEYS.captureStartedAt]) {
            state.capture.startedAt = s[PERSIST_KEYS.captureStartedAt];
        }
        if (s[PERSIST_KEYS.judged] && typeof s[PERSIST_KEYS.judged] === 'object') {
            state.judged = s[PERSIST_KEYS.judged];
        }
        if (state.capture.jobs.size > 0) setBadge(state.capture.jobs.size);
        console.log('[FF-JRD] restored state', {
            captured: state.capture.jobs.size,
            judged: state.judged ? state.judged.decisions?.length : 0,
        });
    } catch (e) { console.warn('[FF-JRD] restoreState failed', e?.message); }
}
restoreState();
loadTodayMetrics();

// Sidepanel opens a persistent port for keepalive — incoming pings reset
// the SW idle timer so long-running awaits (login, judge batches, push)
// don't get cut off. Sidepanel is the source-of-truth for "panel open".
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'jrd-keepalive') {
        port.onMessage.addListener(() => { /* ack ping */ });
        port.onDisconnect.addListener(() => { /* ignore — sidepanel closed */ });
    }
});

// Toolbar-icon click → toggle the in-page panel on the active JR tab.
// Mirrors jobTODashboard pattern (panel = an iframe injected into the
// page DOM by the content script, not Chrome's native side panel).
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab?.id) return;
    const url = tab.url || '';
    if (!/^https?:\/\/([^/]+\.)?jobright\.ai\//.test(url)) {
        // Not on a JR tab — open one and let the content script auto-mount.
        await chrome.tabs.create({ url: 'https://jobright.ai/jobs/recommend' });
        return;
    }
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'jrd-toggle-panel' });
    } catch {
        // Content script may not be injected yet (tab opened before reload).
        // Inject it manually then toggle.
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content-scrape.js'],
            });
            await chrome.tabs.sendMessage(tab.id, { type: 'jrd-toggle-panel' });
        } catch (e) {
            console.warn('[FF-JRD] could not inject content script', e?.message);
        }
    }
});

async function loadConfig() {
    try {
        const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
        for (const k of Object.keys(DEFAULTS)) {
            if (stored[k] !== undefined) state.config[k] = stored[k];
        }
    } catch {
        /* ignore */
    }
}
loadConfig();

// Live-sync state.config when sidepanel updates storage directly (e.g.
// the bypass-SW login path). Without this, background's in-memory
// authEmail stays empty after login → subsequent judge/push fail.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
            state.config[key] = changes[key].newValue;
        }
    }
});

function setBadge(count) {
    try {
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    } catch {
        /* ignore */
    }
}

function notifyPopup(type, payload) {
    try {
        chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    } catch {
        /* popup probably closed */
    }
}

// ---- capture handling ----------------------------------------------------

// Hard cap on captures per session. Beyond this we stop ingesting so the
// auto-pipeline finishes the existing buffer cleanly. Operator can Reset
// to start a fresh session.
const MAX_CAPTURES = 100;

function ingestCards(jobs) {
    if (!state.capture.active) return;
    let added = 0;
    let dropped = 0;
    for (const j of jobs || []) {
        if (!j?.jobId || state.capture.jobs.has(j.jobId)) continue;
        if (state.capture.jobs.size >= MAX_CAPTURES) {
            dropped += 1;
            continue;
        }
        state.capture.jobs.set(j.jobId, j);
        added += 1;
    }
    setBadge(state.capture.jobs.size);
    notifyPopup('count', {
        count: state.capture.jobs.size,
        added,
        dropped,
        cap: MAX_CAPTURES,
        atCap: state.capture.jobs.size >= MAX_CAPTURES,
    });
    if (state.capture.jobs.size >= MAX_CAPTURES) {
        // Reaching cap auto-stops capture so the pipeline drains and the
        // operator gets a clean "session done" signal.
        if (state.capture.active) {
            state.capture.active = false;
            persistCapture();
            notifyPopup('phase', { phase: 'cap-reached', cap: MAX_CAPTURES });
        }
    }
    if (added > 0) persistCapture();
    // Local today accumulator — survives panel reload, SW eviction, session
    // reset. Source of truth for the extension's TODAY tile. Counts every
    // captured card (incl. ones that later get LinkedIn-skipped or
    // role-rejected, per the user's rule "total includes skipped too").
    if (added > 0) bumpToday('captures', added);
    // Backend heartbeat for the admin "Today" tile (cross-operator view).
    if (added > 0) scheduleSessionHeartbeat();
    // Auto pipeline: kick a batch when enough unprocessed jobs accumulate.
    if (state.config.autoMode) tryAutoBatch();
}

let _heartbeatTimer = null;
let _heartbeatLastSent = 0;
function scheduleSessionHeartbeat() {
    const HEARTBEAT_INTERVAL_MS = 5000;
    if (_heartbeatTimer) return;
    const now = Date.now();
    const wait = Math.max(0, HEARTBEAT_INTERVAL_MS - (now - _heartbeatLastSent));
    _heartbeatTimer = setTimeout(() => {
        _heartbeatTimer = null;
        _heartbeatLastSent = Date.now();
        reportSessionStat('heartbeat').catch(() => {});
    }, wait);
}

// ---- dashboard helpers ---------------------------------------------------

// dashboardFetch: thin fetch wrapper with retry on 5xx/429/network and
// detailed error reporting. Mirrors DASH/scraper/src/clients/common/httpClient.js
// behaviour so the extension and scraper share semantics.
//
// Returns: { ok, status, body, bodyText, error?, errorDetail? }
async function dashboardFetch(path, opts = {}) {
    const base = API_BASE_URL.replace(/\/+$/, '');
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers = {
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers || {}),
    };
    const MAX_RETRIES = 2;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            console.log('[FF-JRD] dashboardFetch', opts.method || 'GET', url, '(attempt', attempt + 1, ')');
            const res = await fetch(url, {
                method: opts.method || 'GET',
                headers,
                body: opts.body || undefined,
            });
            const bodyText = await res.text().catch(() => '');
            let body = null;
            if (bodyText) { try { body = JSON.parse(bodyText); } catch { /* non-json */ } }
            console.log('[FF-JRD] dashboardFetch ←', res.status, body || bodyText.slice(0, 200));
            // Retry on 5xx/429
            if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
                await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
                continue;
            }
            const result = { ok: res.ok, status: res.status, body, bodyText };
            if (!res.ok) {
                result.error = `HTTP_${res.status}`;
                result.errorDetail = body?.message || body?.error || bodyText.slice(0, 300) || `HTTP ${res.status}`;
            }
            return result;
        } catch (err) {
            lastErr = err;
            console.warn('[FF-JRD] dashboardFetch network error', err.message);
            if (attempt < MAX_RETRIES) {
                await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
                continue;
            }
        }
    }
    return {
        ok: false,
        status: 0,
        error: 'NETWORK',
        errorDetail: lastErr?.message || 'network error reaching dashboard',
    };
}

// clientLogin: POST /extension/clientLogin with email+password (the
// CLIENT's own dashboard credentials). On success we cache the returned
// profile + token so every other request runs in that client's context.
async function clientLogin({ email, password }) {
    console.log('[FF-JRD] clientLogin start', email);
    if (!email || !password) {
        return { ok: false, error: 'BAD_INPUT', message: 'email + password required' };
    }
    let r;
    try {
        r = await dashboardFetch('/extension/clientLogin', {
            method: 'POST',
            body: JSON.stringify({ email: String(email).toLowerCase(), password }),
        });
    } catch (e) {
        console.error('[FF-JRD] clientLogin dashboardFetch threw:', e);
        return { ok: false, error: 'NETWORK', message: `dashboardFetch threw: ${e?.message || e}` };
    }
    console.log('[FF-JRD] clientLogin response', r.status, r.body || r.errorDetail);
    if (!r.ok) {
        // Specific 401 → most common: wrong creds.
        if (r.status === 401) {
            return {
                ok: false,
                error: 'INVALID_CREDS',
                message: r.body?.message || 'User not found or invalid password',
            };
        }
        return {
            ok: false,
            error: r.error || `HTTP_${r.status || 0}`,
            message: r.body?.message || r.errorDetail || `HTTP ${r.status} from /extension/clientLogin`,
        };
    }
    const body = r.body || {};
    if (!body.token) {
        return {
            ok: false,
            error: 'NO_TOKEN',
            message: `login response missing token (got keys: ${Object.keys(body).join(', ') || '(empty)'})`,
        };
    }
    const profileKey = (body.userProfile?.openaiKey || '').trim();
    state.config = {
        ...state.config,
        authToken: body.token,
        authEmail: body.userDetails?.email || String(email).toLowerCase(),
        authName: body.userDetails?.name || '',
        authProfile: body.userProfile || null,
        authLoginAt: new Date().toISOString(),
        // Pull OpenAI key from the client's server-side profile so the
        // operator never needs to paste it locally.
        ...(profileKey ? { openaiKey: profileKey } : {}),
    };
    try {
        await chrome.storage.local.set({
            authToken: state.config.authToken,
            authEmail: state.config.authEmail,
            authName: state.config.authName,
            authProfile: state.config.authProfile,
            authLoginAt: state.config.authLoginAt,
            ...(profileKey ? { openaiKey: profileKey } : {}),
        });
    } catch {}
    // Fresh login → reset cap gate state for the new client + sync server-side
    // remaining cap so the panel renders accurate counters from frame zero.
    state.auto.capHit = false;
    state.auto.capInfo = null;
    refreshCapInfo().catch(() => {});
    return {
        ok: true,
        client: {
            email: state.config.authEmail,
            name: state.config.authName,
            preferredRoles: body.userDetails?.preferredRoles || [],
            preferredLocations: body.userDetails?.preferredLocations || [],
            planType: body.userDetails?.planType || '',
            aiSummary: body.userProfile?.aiSummary || '',
            aiSummaryMeta: body.userProfile?.aiSummaryMeta || null,
        },
    };
}

// verifyOperatorCode: hits dashboard's /api/extension-codes/verify with
// the 5-digit code the operator entered. On success persists the code +
// resolved name to chrome.storage so /addjob carries it forward.
async function verifyOperatorCode({ code }) {
    const trimmed = String(code || '').trim();
    if (!/^\d{5}$/.test(trimmed)) {
        return { ok: false, error: 'BAD_CODE', message: 'Code must be exactly 5 digits.' };
    }
    let r;
    try {
        r = await dashboardFetch('/api/extension-codes/verify', {
            method: 'POST',
            body: JSON.stringify({ code: trimmed }),
        });
    } catch (e) {
        return { ok: false, error: 'NETWORK', message: e?.message || String(e) };
    }
    const body = r.body || {};
    if (!r.ok || !body.valid) {
        return {
            ok: false,
            error: body.error || `HTTP_${r.status}`,
            message: body.error || r.errorDetail || 'Code rejected by server',
        };
    }
    state.config.extensionCode = trimmed;
    state.config.operatorName = body.name || '';
    try {
        await chrome.storage.local.set({
            extensionCode: trimmed,
            operatorName: body.name || '',
        });
    } catch {}
    return { ok: true, code: trimmed, name: body.name || '' };
}

async function clientLogout() {
    state.config.authToken = '';
    state.config.authEmail = '';
    state.config.authName = '';
    state.config.authProfile = null;
    state.config.extensionCode = '';
    state.config.operatorName = '';
    state.config.authLoginAt = '';
    state.capture.active = false;
    state.capture.jobs = new Map();
    state.capture.linkedinSkipped = new Map();
    state.judged = null;
    state.lastResult = null;
    state.auto.capHit = false;
    state.auto.capInfo = null;
    state.auto.processed = new Set();
    state.auto.profile = null;
    state.auto.aiSummary = '';
    setBadge(0);
    try {
        await chrome.storage.local.remove([
            'authToken', 'authEmail', 'authName', 'authProfile', 'authLoginAt',
            'extensionCode', 'operatorName',
        ]);
        await chrome.storage.session.remove(Object.values(PERSIST_KEYS));
    } catch {}
    return { ok: true };
}

// reloadProfile: re-pull the latest profile (after summary edit in
// clients-tracking) so the panel reflects fresh data.
async function reloadProfile() {
    const email = state.config.authEmail;
    if (!email) return { ok: false, error: 'NOT_LOGGED_IN' };
    const r = await getProfile(email);
    if (!r.ok) return r;
    state.config.authProfile = r.profile;
    // Pull OpenAI key forward — it lives on the profile, and a portal-side
    // edit must reach the SW without requiring a re-login.
    const profileKey = (r.profile?.openaiKey || '').trim();
    if (profileKey) state.config.openaiKey = profileKey;
    try {
        await chrome.storage.local.set({
            authProfile: r.profile,
            ...(profileKey ? { openaiKey: profileKey } : {}),
        });
    } catch {}
    // Cap state changes whenever the operator (or auto-pipeline) pushes from
    // another panel session — re-sync.
    refreshCapInfo().catch(() => {});
    return { ok: true, profile: r.profile };
}

// refreshCapInfo: hits /push-history?days=1 to read capInfo.{targetJobCount,
// currentOps, remaining}. Trips state.auto.capHit when remaining===0 so the
// gate fires before the first /addjob round-trips a 403. Cheap call, cached
// implicitly by the dashboard-side aggregation; safe to call on every login,
// every panel reopen, every successful push.
async function refreshCapInfo() {
    const email = state.config.authEmail;
    if (!email) return { ok: false, error: 'NOT_LOGGED_IN' };
    const r = await dashboardFetch(`/push-history?email=${encodeURIComponent(email)}&days=1`);
    if (!r.ok || !r.body?.success) {
        return { ok: false, error: r.error || `HTTP_${r.status}`, message: r.errorDetail || 'push-history failed' };
    }
    const cap = r.body.capInfo || null;
    state.auto.capInfo = cap;
    const remaining = cap?.remaining;
    const wasHit = state.auto.capHit;
    if (Number.isFinite(remaining) && remaining <= 0) {
        if (!wasHit) tripCapHit({ source: 'push-history', cap });
    } else {
        // Cap raised on the dashboard or new client logged in — clear stale flag.
        state.auto.capHit = false;
    }
    return { ok: true, capInfo: cap };
}

// tripCapHit: single source of truth for "cap reached". Idempotent.
// Triggers: server TARGET_REACHED reply, push-history remaining===0.
// Side effects: stop capture, abort auto pipeline, notify popup so UI
// renders the "Daily cap reached" banner + disables Start.
function tripCapHit({ source, cap, message }) {
    if (state.auto.capHit) return;
    state.auto.capHit = true;
    if (cap) state.auto.capInfo = cap;
    state.capture.active = false;
    persistCapture().catch(() => {});
    console.warn('[FF-JRD] cap-hit tripped via', source, 'capInfo=', state.auto.capInfo);
    notifyPopup('phase', {
        phase: 'cap-hit',
        capInfo: state.auto.capInfo,
        message: message || 'Client target reached — pushes halted.',
    });
}

async function listClients() {
    const r = await dashboardFetch('/api/clients/all');
    if (!r.ok) {
        return { ok: false, error: r.error || `HTTP_${r.status}`, message: r.errorDetail || `HTTP ${r.status}` };
    }
    const data = Array.isArray(r.body?.data) ? r.body.data : [];
    const clients = data
        .filter((c) => typeof c?.email === 'string' && c.email)
        .map((c) => ({
            email: String(c.email).toLowerCase(),
            name: typeof c.name === 'string' ? c.name : '',
        }));
    return { ok: true, clients };
}

async function getProfile(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return { ok: false, error: 'BAD_INPUT', message: 'email is required' };
    }
    // Try lowercase first (matches scraper convention + listClients normalization);
    // fall back to the original case if 404 — some legacy profiles keep mixed case.
    const lower = email.toLowerCase();
    let r = await dashboardFetch(`/get-profile?email=${encodeURIComponent(lower)}`);
    if (!r.ok && r.status === 404 && lower !== email) {
        console.log('[FF-JRD] retrying getProfile with original-case email:', email);
        r = await dashboardFetch(`/get-profile?email=${encodeURIComponent(email)}`);
    }
    if (!r.ok) {
        return {
            ok: false,
            error: r.error || `HTTP_${r.status}`,
            message: r.errorDetail || `HTTP ${r.status} from /get-profile`,
            status: r.status,
        };
    }
    const profile = r.body?.userProfile || null;
    if (!profile) {
        return {
            ok: false,
            error: 'BAD_SHAPE',
            message: `Dashboard /get-profile returned 200 but no userProfile field. Body keys: ${Object.keys(r.body || {}).join(', ') || '(empty)'}`,
        };
    }
    return { ok: true, profile };
}

async function fetchResume(email) {
    const base = (state.config.resumeBase || '').replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'NO_RESUME_BASE', message: 'Resume API base URL not set in Settings' };
    const url = `${base}/api/resume-by-email`;
    console.log('[FF-JRD] fetchResume', url, email);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email }),
        });
    } catch (e) {
        return { ok: false, error: 'NETWORK', message: `Resume API unreachable at ${base}: ${e.message}` };
    }
    let bodyText = ''; try { bodyText = await res.text(); } catch {}
    let body = null; if (bodyText) { try { body = JSON.parse(bodyText); } catch {} }
    console.log('[FF-JRD] fetchResume ←', res.status, body || bodyText.slice(0, 200));
    if (res.status === 404) {
        return { ok: false, error: 'NO_RESUME', message: body?.error || 'No resume assigned to this user' };
    }
    if (!res.ok) {
        return { ok: false, error: `HTTP_${res.status}`, message: body?.error || bodyText.slice(0, 300) || `HTTP ${res.status} from resume API` };
    }
    return { ok: true, resume: body };
}

async function saveSummary({ email, aiSummary, model, source, wordCount }) {
    const r = await dashboardFetch('/update-ai-summary', {
        method: 'POST',
        body: JSON.stringify({ email, aiSummary, model, source, wordCount }),
    });
    if (!r.ok) {
        return {
            ok: false,
            error: r.error || `HTTP_${r.status}`,
            message: r.errorDetail || `HTTP ${r.status}`,
            hint: r.status === 404
                ? 'Endpoint /update-ai-summary not found — restart the dashboard backend so the new route registers.'
                : '',
        };
    }
    return { ok: true, profile: r.body?.profile };
}

const SUMMARY_SYSTEM_PROMPT = `You are a senior recruiter writing a candidate brief.
You receive a candidate's onboarding profile + parsed resume. You produce a single
"candidate summary" used by an automated job-fit grader.

Goals:
1. Make later grading reliable by surfacing the SIGNALS that determine fit.
2. Stay under 500 words.
3. Be specific and grounded — quote real titles, years, technologies, locations from
   the inputs. Never invent.

Required structure (use these exact section headers):

# Candidate Summary
- 2-3 sentence overview (current title, total YOE, primary discipline).

# Target Roles
- Bullet list of role titles the candidate wants. Group same-family roles
  (e.g. "Software Engineer / Backend Engineer / Platform Engineer" — one bullet).
- Note seniority band (intern / entry / mid / senior / lead / exec).

# Hard Constraints
- Locations they will accept (cities + remote/hybrid policy).
- Work authorisation (citizen / GC / H1B / OPT / needs sponsorship).
- Salary floor if profile states one.
- Industries / company stages excluded if any.

# Strong Signals (auto-PICK if matched)
- Keywords / role titles / skills that indicate a strong fit when seen on a job.

# Hard Disqualifiers (auto-SKIP if matched)
- Specific factors that must reject a job (e.g. "anything requiring active
  US security clearance — candidate does not have it").

# Notes for Grader
- 2-4 sentences of nuance: how to weight role family vs seniority vs location.
  E.g. "Candidate is open to PM and APM roles but not SVP or Director — too senior."

Rules:
- Total length: 380-500 words.
- No fluff, no marketing, no generic ("strong communicator").
- Every bullet must be derivable from the inputs. If profile is missing a fact,
  say "not specified".
- Plain text, no markdown beyond the # headers and - bullets.`;

function buildSummaryUserPrompt(profile, resume) {
    const profileText = JSON.stringify(profile || {}, null, 2);
    const resumeBlob = resume
        ? JSON.stringify({
              personalInfo: resume.personalInfo,
              summary: resume.summary,
              workExperience: resume.workExperience,
              projects: resume.projects,
              skills: resume.skills,
              education: resume.education,
              leadership: resume.leadership,
              publications: resume.publications,
          }, null, 2)
        : '(no resume found for this candidate — work from profile only)';
    return `## Onboarding profile
${profileText.slice(0, 12_000)}

## Parsed resume
${resumeBlob.slice(0, 16_000)}`;
}

// buildSummary: thin client. POSTs the email to the dashboard backend
// /build-ai-summary endpoint and waits for the response. The backend owns
// the resume fetch + OpenAI call + DB write, so the extension doesn't need
// the OpenAI key or resume URL configured.
async function buildSummary({ email }) {
    console.log('[FF-JRD] buildSummary →', email);
    if (!email) return { ok: false, error: 'NO_CLIENT', message: 'no client selected' };
    notifyPopup('summary-phase', { phase: 'requesting' });
    const r = await dashboardFetch('/build-ai-summary', {
        method: 'POST',
        body: JSON.stringify({ email }),
    });
    if (!r.ok) {
        const detail = r.body || {};
        return {
            ok: false,
            error: detail.error || r.error || `HTTP_${r.status}`,
            message: detail.message || r.errorDetail || `HTTP ${r.status}`,
            step: detail.step || 'backend-call',
        };
    }
    const body = r.body || {};
    if (!body.success) {
        return {
            ok: false,
            error: body.error || 'BACKEND_FAILED',
            message: body.message || 'backend returned success:false',
            step: body.step || 'backend',
        };
    }
    notifyPopup('summary-phase', { phase: 'done' });
    return {
        ok: true,
        summary: body.aiSummary,
        wordCount: body.wordCount,
        source: body.source,
        model: body.model,
        builtAt: body.builtAt,
        resumeFound: body.resumeFound,
    };
}

// Mirror scraper convention: operationsEmail must end with '@flashfirehq'
// (AddJob.js gates the ops branch on that suffix), operationsName becomes
// the visible "Added by ..." label on the dashboard timeline.
const OPS_EMAIL = 'jrdirect@flashfirehq';
const OPS_NAME = 'JR Direct (Extension)';

const JR_FALLBACK_RX = /^https?:\/\/jobright\.ai\/jobs\/info\/[a-f0-9]{24}\b/i;
const applyLinkCache = new Map(); // jobId → real applyLink (resolved from JR)

function isLinkedInUrlBg(url) {
    if (!url || typeof url !== 'string') return false;
    try { return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname); }
    catch { return /linkedin\.com/i.test(url); }
}

// composeJobDescription: merge JR's structured JD fields into the single
// plain-text blob the dashboard's `jobDescription` column expects.
// Mirrors scraper's adapters/jobright.js composeDescription so pushed
// jobs read identically whether they came from scraper or extension.
function composeJobDescription(jr) {
    const parts = [];
    const summary = (jr?.jobSummary || '').trim();
    if (summary) parts.push(summary);
    const bullet = (items) => (items || []).filter(Boolean).map((s) => `• ${s}`).join('\n');
    if (Array.isArray(jr?.coreResponsibilities) && jr.coreResponsibilities.length) {
        parts.push(`Responsibilities:\n${bullet(jr.coreResponsibilities)}`);
    }
    const must = jr?.qualifications?.mustHave;
    if (Array.isArray(must) && must.length) {
        parts.push(`Must have:\n${bullet(must)}`);
    }
    const pref = jr?.qualifications?.preferredHave;
    if (Array.isArray(pref) && pref.length) {
        parts.push(`Nice to have:\n${bullet(pref)}`);
    }
    if (Array.isArray(jr?.skillSummaries) && jr.skillSummaries.length) {
        parts.push(`Key skills:\n${bullet(jr.skillSummaries)}`);
    }
    if (Array.isArray(jr?.benefitsSummaries) && jr.benefitsSummaries.length) {
        parts.push(`Benefits:\n${bullet(jr.benefitsSummaries)}`);
    }
    const why = (jr?.whyJoinUs || '').trim();
    if (why) parts.push(`Why join us:\n${why}`);
    return parts.join('\n\n').trim();
}

// resolveViaScraper: ask the scraper backend's Playwright session to open
// the JR detail page on our behalf. The persistent context is reliably
// authenticated, so this returns full JD + real applyLink even when the
// extension's own SW fetch would lose third-party cookies.
async function resolveViaScraper(jobId) {
    const base = SCRAPER_BASE_URL.replace(/\/+$/, '');
    let res;
    try {
        res = await fetch(`${base}/api/jr/job-detail`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ jobId }),
        });
    } catch (e) {
        return { ok: false, error: 'SCRAPER_NETWORK', message: e.message };
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !body?.success) {
        return {
            ok: false,
            error: body?.error || `SCRAPER_HTTP_${res.status}`,
            message: body?.message || `scraper returned ${res.status}`,
        };
    }
    return {
        ok: true,
        applyLink: body.applyLink,
        description: body.description,
        meta: body.raw || {},
    };
}

// resolveJobDetail: returns the real applyLink + fully-composed
// jobDescription for a JR jobId.
//
// Strategy: try scraper backend first (Playwright session, authenticated,
// extracts SSR + falls back to DOM). If unreachable, fall back to the
// SW's own fetch against jobright.ai SSR HTML.
//
// Returns: { ok:true, applyLink, description, meta? }
//        | { ok:false, error, message }
async function resolveJobDetail(jobId) {
    if (!jobId) return { ok: false, error: 'BAD_INPUT' };
    if (applyLinkCache.has(jobId)) {
        const cached = applyLinkCache.get(jobId);
        if (typeof cached === 'object' && cached.applyLink && cached.description) {
            return { ok: true, ...cached, cached: true };
        }
        // Legacy cache entries (url-only strings, or thin descriptions) —
        // discard and re-resolve so push gets full JD.
        applyLinkCache.delete(jobId);
    }

    // 1) Scraper-backed path (preferred).
    const viaScraper = await resolveViaScraper(jobId);
    if (viaScraper.ok && viaScraper.description && viaScraper.description.length >= 200) {
        applyLinkCache.set(jobId, {
            applyLink: viaScraper.applyLink,
            description: viaScraper.description,
            meta: viaScraper.meta || {},
        });
        console.log('[FF-JRD] resolveJobDetail (scraper)', jobId, 'desc', viaScraper.description.length, 'chars; apply', viaScraper.applyLink);
        return { ok: true, ...viaScraper };
    }
    if (!viaScraper.ok) {
        console.warn('[FF-JRD] scraper resolve failed', jobId, viaScraper.error, viaScraper.message);
    }

    // 2) Fallback — direct SW fetch. Used when scraper is offline or the
    //    Playwright session needs reauth.
    const url = `https://jobright.ai/jobs/info/${jobId}`;
    let res;
    try {
        res = await fetch(url, { credentials: 'include' });
    } catch (e) {
        return { ok: false, error: 'NETWORK', message: e.message };
    }
    if (!res.ok) {
        return { ok: false, error: `HTTP_${res.status}`, message: `JR returned ${res.status}` };
    }
    const html = await res.text();
    const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return { ok: false, error: 'NO_NEXT_DATA', message: 'no __NEXT_DATA__ in JR detail HTML' };
    let data;
    try { data = JSON.parse(m[1]); }
    catch (e) { return { ok: false, error: 'BAD_NEXT_JSON', message: e.message }; }
    const ds = data?.props?.pageProps?.dataSource || {};
    const jr = ds.jobResult || {};
    const real = jr.applyLink || jr.originalUrl || ds.applyLink || ds.originalUrl || '';
    if (!real) {
        return { ok: false, error: 'NO_APPLYLINK', message: 'dataSource has no applyLink/originalUrl' };
    }
    const description = composeJobDescription(jr);
    const payload = {
        applyLink: real,
        description,
        meta: {
            tags: [...(jr.recommendationTags || []), ...(jr.jobTags || [])],
            benefits: jr.benefitsSummaries || [],
            mustHave: jr.qualifications?.mustHave || [],
            preferredHave: jr.qualifications?.preferredHave || [],
        },
    };
    applyLinkCache.set(jobId, payload);
    console.log('[FF-JRD] resolveJobDetail (fallback)', jobId, 'desc', description.length, 'chars; apply', real);
    return { ok: true, ...payload };
}

// Backwards-compatible thin wrapper — pre-existing call sites just want the URL.
async function resolveApplyUrl(jobId) {
    const r = await resolveJobDetail(jobId);
    if (!r.ok) return r;
    return { ok: true, applyLink: r.applyLink, cached: r.cached };
}

// resolvePicksAsync: after judge completes, kick off parallel URL
// resolution for every pick that's still pointing at JR's fallback
// `/jobs/info/<id>`. Streams `applyurl-resolved` events to the panel
// so each card swaps to the real URL the moment it lands. Push later
// uses already-resolved URLs → faster, no resolution under user wait.
//
// Concurrency capped at 5 — every resolve hits jobright.ai, and we
// don't want the operator's session to look botty.
async function resolvePicksAsync() {
    if (!state.judged) return;
    const picks = state.judged.jobs || [];
    // Resolve for any job that either:
    //   - still has the JR fallback URL (no real applyLink known), OR
    //   - has a thin description (<300 chars) — DOM scrape only captured
    //     the "Why this job is a match" summary; the full JD lives in
    //     SSR __NEXT_DATA__ and we want it on the dashboard tracker.
    const candidates = picks.filter((j) => {
        const url = String(j.applyUrl || '');
        if (JR_FALLBACK_RX.test(url)) return true;
        const desc = String(j.description || '');
        if (desc.length < 300) return true;
        return false;
    });
    if (candidates.length === 0) {
        console.log('[FF-JRD] resolvePicksAsync: nothing to resolve');
        notifyPopup('resolve-done', { resolved: 0, total: 0 });
        return;
    }
    console.log('[FF-JRD] resolvePicksAsync: resolving', candidates.length, 'jobs');
    notifyPopup('resolve-start', { total: candidates.length });
    let resolved = 0, failed = 0, linkedinDropped = 0;
    const CONCURRENCY = 5;
    let cursor = 0;
    async function worker() {
        while (cursor < candidates.length) {
            const idx = cursor;
            cursor += 1;
            const j = candidates[idx];
            // resolveJobDetail returns applyLink + composed full JD.
            const r = await resolveJobDetail(j.jobId);
            if (r.ok && r.applyLink) {
                // Always swap in the full description from JR's structured
                // SSR payload (responsibilities + must-have + nice-to-have
                // + skills + benefits). Preserves whatever the API hook
                // already set if longer (rare).
                if (r.description && (!j.description || r.description.length > (j.description || '').length)) {
                    j.description = r.description;
                }
                if (isLinkedInUrlBg(r.applyLink)) {
                    linkedinDropped += 1;
                    j.applyUrl = `__LINKEDIN_BLOCKED__:${r.applyLink}`;
                    notifyPopup('applyurl-blocked-linkedin', {
                        jobId: j.jobId, applyUrl: r.applyLink,
                    });
                } else {
                    j.applyUrl = r.applyLink;
                    resolved += 1;
                    notifyPopup('applyurl-resolved', {
                        jobId: j.jobId, applyUrl: r.applyLink,
                    });
                }
            } else {
                failed += 1;
                console.warn('[FF-JRD] resolve failed', j.jobId, r.error || r.message);
            }
            notifyPopup('resolve-progress', {
                done: resolved + failed + linkedinDropped,
                total: candidates.length,
            });
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()));
    // Persist judged with updated applyUrls so SW eviction doesn't lose work.
    await persistJudged();
    notifyPopup('resolve-done', {
        resolved,
        failed,
        linkedinDropped,
        total: candidates.length,
    });
    console.log('[FF-JRD] resolvePicksAsync done:', { resolved, failed, linkedinDropped });
}

async function pushJob({ job, clientEmail, clientName }) {
    const email = String(clientEmail).toLowerCase();
    const title = String(job.title || '').slice(0, 50).trim();
    const company = String(job.company || '').trim();
    const joblink = String(job.applyUrl || job.jrLink || '').trim();
    if (!title || !company || !joblink) {
        return {
            ok: false,
            status: 0,
            error: 'BAD_INPUT',
            errorDetail: `missing required fields title=${!!title} company=${!!company} joblink=${!!joblink}`,
        };
    }
    const payload = {
        jobDetails: {
            userID: email,
            jobTitle: title,
            companyName: company,
            jobLocation: job.location ? String(job.location).trim() : '',
            jobDescription: String(job.description || job.matchSummary || ''),
            joblink,
        },
        userDetails: {
            email,
            name: clientName || email,
        },
        role: 'operations',
        operationsEmail: OPS_EMAIL,
        operationsName: state.config.operatorName || OPS_NAME,
        // 5-digit operator code identifies WHICH human operator pushed.
        // Backend resolves it to addedBy / extensionCode on the JobModel.
        extensionCode: state.config.extensionCode || '',
    };
    console.log('[FF-JRD] /addjob →', {
        jobTitle: title,
        company,
        jobId: job.jobId,
        descLen: payload.jobDetails.jobDescription.length,
        descPreview: payload.jobDetails.jobDescription.slice(0, 120),
        joblink: joblink,
    });
    const r = await dashboardFetch('/addjob', { method: 'POST', body: JSON.stringify(payload) });
    console.log('[FF-JRD] /addjob ←', r.status, r.body?.message || r.bodyText?.slice(0, 200) || '');
    return r;
}

// ---- AI judge ------------------------------------------------------------

const SYSTEM_PROMPT = `You are a hiring-fit grader for a job-search assistant.
For each job, decide whether it matches the candidate's profile.

The user prompt contains a "## Candidate hard signals" block with the
authoritative preferredRoles, excludedRoles, experienceLevel, and
preferredLocations pulled DIRECTLY from the client's onboarding profile.
This is the ground truth — the candidate-brief / aiSummary may paraphrase,
but if they conflict, the hard-signals block wins.

excludedRoles is a HARD VETO list. The candidate explicitly opted out
of these role families (e.g. "Technician", "QA", "Manager"). If the job
title or its role family matches ANY excludedRole — even loosely — you
MUST set pick=false and skipKind="role-mismatch", and the reason MUST
quote the matched excludedRole verbatim ("Skip — title 'QA Technician'
matches excluded role 'Technician'; candidate opted out of those").
This rule overrides every other signal, including high JR match scores.

Each job in "Jobs to judge" includes a "jd" field — the FULL composed
job description (responsibilities + must-haves + nice-to-haves + skills
+ benefits, up to 4500 chars). When jdSource="full" you MUST read the
JD for hard disqualifiers buried in the body — clearance required,
on-site/in-office mandates, citizenship-only clauses, 10+ YOE caps,
travel %, language requirements. These almost never appear in the
title or in the JR-provided whyMatch preview. When jdSource="preview"
the JD wasn't resolved (scraper unreachable); fall back to title +
whyMatch + tags for the decision and lower confidence on close calls.

Return STRICT JSON only — no prose, no markdown:
{"decisions":[{"id":"<jobId>","pick":<true|false>,"score":<0-100>,"reason":"<one short sentence, 90-160 chars>","matchedRole":"<verbatim preferredRole this maps to, or '' for skip>","skipKind":"<see below, '' for picks>"}]}

skipKind enum (REQUIRED for every skip — empty string for picks):
- "threshold"      → score >= 40 but < operator threshold (would pick on a looser bar)
- "role-mismatch"  → job title's discipline qualifier does NOT match any preferredRole's qualifier
- "seniority-mismatch" → discipline matches but seniority is 2+ levels off
- "location-mismatch"  → outside preferredLocations + workModel forbids it
- "auth-mismatch"  → requires citizenship/clearance candidate doesn't have
- "company-blocked" → company name in excludedCompanies
Pick the SINGLE biggest reason; do not stack. Used by the UI to color-code
the skip border so the operator can scan failures at a glance.

ROLE MATCHING (THE MOST IMPORTANT RULE — read carefully):

The candidate's preferredRoles list is the WHOLE universe of acceptable
disciplines. Do NOT invent unrelated role groupings. Do NOT widen the
family across disciplines (e.g. don't pick "Inventory Control Analyst"
when the candidate wants "Data Analyst" — those are different fields).

Step 1 — Extract the discipline QUALIFIER from each preferredRole.
  "Data Analyst"                  → qualifier "Data"
  "Data Engineer"                 → qualifier "Data"
  "Financial Analyst"             → qualifier "Financial" (also "Finance")
  "Business Analyst"              → qualifier "Business"
  "Business Intelligence Engineer" → qualifier "Business Intelligence" / "BI"
  "Backend Engineer"              → qualifier "Backend"
  "Product Manager"               → qualifier "Product"
The bare role noun ("Analyst", "Engineer", "Manager", "Specialist",
"Developer") is NEVER a qualifier on its own.

Step 2 — Look at the JOB TITLE. Pick when the title contains EITHER:
  (a) a direct qualifier match from the candidate's list (case-insensitive,
      allow obvious abbreviations: BI ↔ Business Intelligence,
      ML ↔ Machine Learning, FE ↔ Frontend, BE ↔ Backend), OR
  (b) an ADJACENT qualifier in the SAME field — accept when there is
      strong domain overlap. Allowed adjacencies (only these — do not
      invent more):
        Data ↔ Analytics ↔ Reporting ↔ Insights
        BI / Business Intelligence ↔ Reporting ↔ Analytics
        Financial ↔ Finance ↔ FP&A ↔ Treasury (only when JD is finance work)
        Software / Backend / Frontend / Full-Stack ↔ Developer / SWE / SDE
            (only swap WITHIN this engineering family if at least one of
             those qualifiers is in preferredRoles)
        Product Manager ↔ Product Owner ↔ APM
        ML ↔ AI ↔ Machine Learning Engineer ↔ Applied Scientist
            (only when at least one ML/AI qualifier is in preferredRoles)
      Adjacent matches REQUIRE the JD body to confirm the work is in
      that field. If the JD body talks about something different (e.g.
      "Analytics Engineer" but JD is product analytics for a sales team
      while candidate wants pipeline data engineering), still skip.

Step 3 — When still in doubt after Step 2, SKIP with
skipKind:"role-mismatch". A clean skip is better than a wrong push.
NEVER allow a cross-field match: Sourcing, Inventory Control,
Procurement, Sales, Marketing, Operations Coordinator, Customer Success,
QA (unless QA is in preferredRoles), Recruiting, etc. — none of these
are "adjacent" to Data/Finance/Engineering disciplines.

Examples for preferredRoles = [Data Analyst, Data Engineer, Financial
Analyst, Business Analyst, Business Intelligence Engineer]:
  "Data Analyst, Senior"          → PICK · matchedRole "Data Analyst"
  "Senior BI Analyst"             → PICK · matchedRole "Business Intelligence Engineer" (BI matches)
  "Reporting Analyst"             → PICK (adjacent: Reporting ↔ BI) · matchedRole "Business Intelligence Engineer"
  "Analytics Engineer"            → PICK (adjacent: Analytics ↔ Data) · matchedRole "Data Engineer"
  "Finance Analyst, FP&A"         → PICK (adjacent: Finance ↔ Financial) · matchedRole "Financial Analyst"
  "Financial Planning Analyst"    → PICK · matchedRole "Financial Analyst"
  "Insights Analyst"              → PICK if JD = data/analytics work · matchedRole "Data Analyst"
  "Analyst I"                     → SKIP role-mismatch — generic, no field qualifier
  "Category Sourcing Analyst"     → SKIP — Sourcing is procurement, not data/finance
  "Inventory Control Analyst"     → SKIP — different field
  "GenAI Python Systems Engineer" → SKIP — Systems Engineering ≠ Data Engineering
  "Quantitative Analyst"          → SKIP — Quant trading ≠ Financial Analyst

Scoring rules:
- score 0-100 weighing: role qualifier match (45%), seniority (20%),
  location/work-model (15%), skills/JD signals (15%), salary (5%).
- BEFORE any pick logic: excludedRoles veto. If title contains an
  excludedRole token (case-insensitive substring), force pick=false
  with skipKind="role-mismatch" — no exceptions.
- BEFORE any pick logic: if no direct OR adjacent qualifier matches
  the title (Step 2), force pick=false.
- Pick only when (a) qualifier matches (direct or adjacent in same field)
  AND (b) score >= operator threshold AND (c) seniority within band.

Seniority bands (use experienceLevel from hard signals):
- intern         → 0 yrs                  · pick when JD says intern
- entry          → 0-3 yrs (INCLUDES 1, 2 yrs job postings — those ARE entry)
- mid            → 2-6 yrs
- senior         → 5-10 yrs (and "Sr", "II", "III" titles)
- lead/staff     → 7-12 yrs
- principal      → 10-15 yrs
- director / VP  → 12+ yrs management
- exec           → 15+ yrs

Seniority skip rules:
- entry candidate vs JD demanding "1+ years", "2+ years", "1-3 years"
  → PICK. These are entry-level postings. Only SKIP when JD demands
  4+ years OR a senior-tier title (Sr / Lead / Staff / Principal / Director).
- mid candidate vs JD demanding 0-1 yrs (intern) → SKIP.
- mid candidate vs JD demanding 7+ yrs → SKIP.
- Skip only when bands are 2+ apart (entry vs senior, mid vs director).
  Adjacent bands (entry↔mid, mid↔senior) → still pick.

REASON QUALITY — every reason MUST be ONE short sentence, 90-160 chars,
plain English, no fluff. Pattern:

  PICK:  "Pick — '<job title>' matches '<preferredRole>' (<qualifier>); <seniority+location note>."
         e.g. "Pick — 'Senior Data Analyst' matches 'Data Analyst' (Data); senior aligns, remote-US covers Remote."

  SKIP role-mismatch:
         "Skip — '<job title>' has no qualifier from preferredRoles [<short list>]; closest gap is <gap>."
         e.g. "Skip — 'Inventory Control Analyst' has no qualifier from [Data, Financial, Business, BI]; Inventory Control isn't a match."

  SKIP seniority-mismatch:
         "Skip — '<job title>' is <gap> above/below candidate's <experienceLevel> on '<preferredRole>'."

  SKIP location-mismatch:
         "Skip — '<job title>' is <city/onsite>, outside preferredLocations [<list>]."

  SKIP auth-mismatch:
         "Skip — JD requires <clearance/citizenship>; candidate is <visa status>."

The "matchedRole" field MUST be the VERBATIM preferredRole string for
picks. Empty string for skips. NEVER paraphrase or rename. Use the
strings exactly as they appear in the hard-signals block.

NEVER write generic reasons like "good fit", "not a match", "see JD",
"strong alignment". Always be concrete and tight.`;

function buildUserPrompt({ profile, jobs, threshold, aiSummary }) {
    // Hard-signals block ALWAYS goes in, even when an aiSummary exists. The
    // summary may paraphrase or compress the preferredRoles list — the model
    // must cite the EXACT strings the dashboard stored, so the operator's
    // pick reasons line up 1:1 with the profile they edit in clients-tracking.
    const fmtList = (v) => {
        if (Array.isArray(v)) return v.filter(Boolean);
        if (typeof v === 'string') return v.split(/\s*[/|,]\s*|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        return [];
    };
    // splitRoles — clients sometimes type negative clauses INTO the
    // preferredRoles field ("Do not add Technician roles", "no QA").
    // Partition each entry so the model gets explicit preferred + excluded
    // lists and can map the latter to skipKind:'role-mismatch'. Mirrors
    // BuildAiSummary.js → splitPreferredRoles in the dashboard backend.
    const NEG_LEAD = /^\s*(?:do\s*not|don'?t|no(?:t|pe)?|avoid|exclude|skip|never|reject|hate|dislike|remove|drop|filter\s*out)\s*(?:add|include|consider|show|pick|push|send|want)?\b\s*/i;
    const ROLE_NOUNS = /\b(?:roles?|positions?|jobs?|titles?)\b/gi;
    function splitRoles(rawList) {
        const preferred = [];
        const excluded = [];
        for (const piece of rawList) {
            const s = String(piece || '').trim();
            if (!s) continue;
            if (s.includes(',') && NEG_LEAD.test(s.split(',').slice(-1)[0].trim())) {
                for (const sub of s.split(/\s*,\s*/)) {
                    const t = sub.trim();
                    if (!t) continue;
                    if (NEG_LEAD.test(t)) {
                        const cleaned = t.replace(NEG_LEAD, '').replace(ROLE_NOUNS, '').trim();
                        if (cleaned) excluded.push(cleaned);
                    } else preferred.push(t);
                }
                continue;
            }
            if (NEG_LEAD.test(s)) {
                const cleaned = s.replace(NEG_LEAD, '').replace(ROLE_NOUNS, '').trim();
                if (cleaned) excluded.push(cleaned);
            } else {
                preferred.push(s);
            }
        }
        return { preferred, excluded };
    }
    const rolesRaw = fmtList(profile?.preferredRoles);
    const { preferred: preferredRoles, excluded: excludedRoles } = splitRoles(rolesRaw);
    const preferredLocations = fmtList(profile?.preferredLocations);
    const hardSignals = {
        preferredRoles: preferredRoles.length ? preferredRoles : '(not specified — fall back to summary)',
        excludedRoles: excludedRoles.length ? excludedRoles : [],
        experienceLevel: profile?.experienceLevel || '(not specified)',
        preferredLocations: preferredLocations.length ? preferredLocations : '(not specified)',
        workAuth: profile?.usWorkEligibility || profile?.visaStatus || '(not specified)',
        excludedCompanies: profile?.excludedCompanies || profile?.removedCompanies || [],
    };
    const hardSignalsBlock = `## Candidate hard signals (AUTHORITATIVE — quote these exact role strings in your reason)\n${JSON.stringify(hardSignals, null, 2)}\n`;
    const intentBlock = aiSummary
        ? `## Candidate brief (use for nuance — but hard signals above win on conflict):\n${aiSummary}\n`
        : `## Candidate raw profile (no AI summary built yet):\n${JSON.stringify({
              targetCompanies: profile?.targetCompanies || '',
          }, null, 2)}\n`;
    // Send the FULL composed JD when available so the model can flag real
    // disqualifiers (clearance required, on-site only, citizenship clause,
    // 10+ YOE) that never appear in the 200-char matchSummary preview.
    // Trim to MAX_JD_CHARS to keep batch token cost bounded — gpt-4o-mini
    // priced at ~$0.15/1M input, so 5 jobs × 4500 chars ≈ $0.0008/batch.
    const MAX_JD_CHARS = 4500;
    const slim = jobs.map((j) => {
        const fullJd = j.description && j.description.length > (j.matchSummary || '').length
            ? j.description
            : (j.matchSummary || '');
        const jd = String(fullJd || '').slice(0, MAX_JD_CHARS);
        return {
            id: j.jobId,
            title: j.title,
            company: j.company,
            industries: j.industries,
            location: j.location,
            workModel: j.workModel,
            seniority: j.seniority,
            experience: j.experienceYears,
            salary: j.salary,
            publishedAt: j.publishedAt,
            jrMatch: `${j.matchPercent || 0}% — ${j.fitFlag || ''}`,
            whyMatch: j.matchSummary,
            tags: j.tags,
            jdSource: j.description && j.description.length > 200 ? 'full' : 'preview',
            jd,
        };
    });
    return `Threshold: ${threshold}

${hardSignalsBlock}
${intentBlock}
## Jobs to judge (one decision per id below):
${JSON.stringify(slim, null, 2)}`;
}

// resolvePreJudge: parallel-resolve full JD for every job in the batch
// BEFORE handing off to OpenAI. Mutates each job in place so the slim
// prompt builder picks up the full description. Falls back to matchSummary
// when scraper is unreachable for a job — never blocks the whole batch
// on a single failure. Resolutions are cached, so a re-judge is cheap.
async function resolvePreJudge(jobs, { concurrency = 5 } = {}) {
    if (!Array.isArray(jobs) || jobs.length === 0) return { resolved: 0, fallback: 0 };
    notifyPopup('judge-prep', { stage: 'resolving', total: jobs.length });
    let resolved = 0;
    let fallback = 0;
    let cursor = 0;
    async function worker() {
        while (cursor < jobs.length) {
            const idx = cursor++;
            const j = jobs[idx];
            // Already has a full JD (e.g. cached from earlier scroll) — skip.
            if (j.description && j.description.length > 600) {
                resolved += 1;
                notifyPopup('judge-prep', { stage: 'resolved', done: resolved + fallback, total: jobs.length });
                continue;
            }
            try {
                const r = await resolveJobDetail(j.jobId);
                if (r.ok && r.description && r.description.length > 200) {
                    j.description = r.description;
                    // Don't overwrite applyUrl here — auto-pipeline does it
                    // post-judge to keep the resolve-vs-judge boundary clean.
                    resolved += 1;
                } else {
                    fallback += 1;
                }
            } catch (e) {
                fallback += 1;
                console.warn('[FF-JRD] resolvePreJudge failed for', j.jobId, e?.message);
            }
            notifyPopup('judge-prep', { stage: 'resolved', done: resolved + fallback, total: jobs.length });
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    console.log('[FF-JRD] resolvePreJudge done — full', resolved, '/ fallback', fallback);
    return { resolved, fallback };
}

async function aiJudge({ profile, jobs, threshold, aiSummary = '' }) {
    if (!state.config.openaiKey) return { ok: false, error: 'NO_OPENAI_KEY' };
    if (!jobs.length) return { ok: true, decisions: [] };

    // Deterministic excluded-role veto. The model is instructed to honor
    // excludedRoles but we don't trust it 100% — this post-filter flips any
    // pick to a skipKind:'role-mismatch' when the job title contains an
    // excluded token. Mirrors splitRoles() inside buildUserPrompt; kept
    // inline so we don't have to thread the closure helper out.
    const NEG = /^\s*(?:do\s*not|don'?t|no(?:t|pe)?|avoid|exclude|skip|never|reject|hate|dislike|remove|drop|filter\s*out)\s*(?:add|include|consider|show|pick|push|send|want)?\b\s*/i;
    const NOUNS = /\b(?:roles?|positions?|jobs?|titles?)\b/gi;
    const rolesRaw = Array.isArray(profile?.preferredRoles)
        ? profile.preferredRoles
        : typeof profile?.preferredRoles === 'string'
            ? profile.preferredRoles.split(/\s*[/|,]\s*|\s{2,}/)
            : [];
    const excludedRoleTokens = [];
    for (const r of rolesRaw) {
        const s = String(r || '').trim();
        if (!s) continue;
        const parts = s.includes(',') && NEG.test(s.split(',').slice(-1)[0].trim())
            ? s.split(/\s*,\s*/)
            : [s];
        for (const p of parts) {
            const t = p.trim();
            if (!t || !NEG.test(t)) continue;
            const cleaned = t.replace(NEG, '').replace(NOUNS, '').trim().toLowerCase();
            if (cleaned) excludedRoleTokens.push(cleaned);
        }
    }
    function vetoExcluded(decision, job) {
        if (!decision.pick || excludedRoleTokens.length === 0) return decision;
        const title = String(job?.title || '').toLowerCase();
        const hit = excludedRoleTokens.find((tok) => tok && title.includes(tok));
        if (!hit) return decision;
        return {
            ...decision,
            pick: false,
            skipKind: 'role-mismatch',
            matchedRole: '',
            reason: `Skip — title "${job?.title || ''}" matches excluded role "${hit}"; candidate explicitly opted out of these. (Auto-vetoed; AI scored ${decision.score}.)`,
        };
    }

    // Qualifier-match veto. The AI is told to require a discipline qualifier
    // match between job title and preferredRoles, but historically it has
    // picked broad-family titles ("Inventory Control Analyst" vs preferred
    // "Data Analyst"). Build a qualifier set from the candidate's preferred
    // roles and force-skip any pick whose title doesn't contain at least one
    // qualifier (case-insensitive substring). Conservative: false negatives
    // are cheaper than wrong jobs landing in the client's tracker.
    const ROLE_NOUN_STRIP = /\b(?:engineer|developer|analyst|manager|specialist|consultant|associate|architect|administrator|lead|director|vp|officer|technician|scientist|coordinator|executive|advisor|representative|operator|owner|head|chief|principal|senior|sr|jr|junior|staff|intern)\b/gi;
    // Direct abbreviations + adjacent same-field qualifiers. Adjacent ones
    // expand the qualifier set so a "Reporting Analyst" title still passes
    // the deterministic veto when the candidate wants "BI Engineer". The
    // model-side prompt enforces "JD body must confirm" for adjacents — the
    // veto only refuses when ZERO tokens (direct OR adjacent) hit the title.
    // Production qualifier map — direct abbreviations + adjacent same-field
    // synonyms grouped by discipline. Bidirectional within a group: every
    // entry pulls in its peers, and lookups via expandQualifier() walk the
    // map in reverse so abbreviations also resolve to their long form. Any
    // adjacency added here MUST stay within the same field — cross-field
    // lumps (e.g. "data" ↔ "sales") are exactly the bug we're guarding
    // against, not features.
    const ABBREV_MAP = {
        // -------- Data / Analytics / BI / ML / AI ----------------------
        'data':                    ['analytics', 'reporting', 'insights', 'big data'],
        'analytics':               ['data', 'reporting', 'insights', 'bi', 'business intelligence'],
        'reporting':               ['bi', 'business intelligence', 'analytics', 'data'],
        'insights':                ['data', 'analytics', 'reporting'],
        'business intelligence':   ['bi', 'reporting', 'analytics', 'data'],
        'bi':                      ['business intelligence', 'reporting', 'analytics', 'data'],
        'machine learning':        ['ml', 'ai', 'artificial intelligence', 'applied scientist', 'deep learning'],
        'ml':                      ['machine learning', 'ai', 'deep learning', 'applied scientist'],
        'artificial intelligence': ['ai', 'ml', 'machine learning', 'genai', 'llm'],
        'ai':                      ['ml', 'machine learning', 'artificial intelligence', 'genai', 'llm'],
        'genai':                   ['ai', 'llm', 'generative', 'machine learning'],
        'llm':                     ['ai', 'genai', 'machine learning'],
        'data scientist':          ['data science', 'applied scientist', 'research scientist'],
        'data science':            ['data scientist', 'applied scientist', 'machine learning'],
        'data engineer':           ['data engineering', 'analytics engineer', 'pipeline'],
        'data engineering':        ['data engineer', 'analytics engineer', 'etl'],
        'etl':                     ['data engineering', 'pipeline', 'integration'],
        'statistician':            ['statistics', 'biostatistics', 'quantitative'],

        // -------- Software / Web / Mobile / Platform -------------------
        // NOTE: never expand to bare 'engineer' — too generic, would let
        // every "X Engineer" title pass for a "Software Engineer" candidate.
        // Software-discipline expansion intentionally pulls in the common
        // flavors so a generic "Software Engineer" candidate accepts FE/BE/
        // mobile/platform titles. The reverse adjacency (FE candidate matching
        // SE titles) is also fine — most "Software Engineer" jobs cover FE.
        'software':                ['developer', 'swe', 'sde', 'programmer', 'frontend', 'backend', 'full stack', 'fullstack'],
        'developer':               ['software', 'swe', 'sde', 'programmer'],
        'swe':                     ['software', 'developer', 'sde'],
        'sde':                     ['software', 'developer', 'swe'],
        'frontend':                ['fe', 'front end', 'front-end', 'web', 'ui', 'react', 'angular', 'vue'],
        'fe':                      ['frontend', 'front end', 'front-end', 'ui'],
        'backend':                 ['be', 'back end', 'back-end', 'server', 'api', 'platform'],
        'be':                      ['backend', 'back end', 'back-end', 'server'],
        'full stack':              ['fullstack', 'full-stack', 'fs'],
        'fullstack':               ['full stack', 'full-stack', 'fs'],
        'mobile':                  ['ios', 'android', 'native', 'react native', 'flutter'],
        'ios':                     ['mobile', 'swift', 'native'],
        'android':                 ['mobile', 'kotlin', 'native'],
        'embedded':                ['firmware', 'iot', 'systems', 'hardware'],
        'firmware':                ['embedded', 'iot', 'low-level'],
        'platform':                ['infrastructure', 'devops', 'sre', 'cloud'],
        'infrastructure':          ['infra', 'platform', 'devops', 'sre', 'cloud'],
        'cloud':                   ['aws', 'azure', 'gcp', 'devops', 'platform', 'infrastructure'],
        'aws':                     ['cloud', 'amazon web services'],
        'azure':                   ['cloud', 'microsoft cloud'],
        'gcp':                     ['cloud', 'google cloud'],
        'devops':                  ['dev ops', 'dev-ops', 'sre', 'platform', 'infrastructure', 'ci/cd'],
        'site reliability':        ['sre', 'devops', 'platform', 'infrastructure'],
        'sre':                     ['site reliability', 'devops', 'platform'],
        'security':                ['cybersecurity', 'cyber', 'infosec', 'application security', 'appsec'],
        'cybersecurity':           ['security', 'cyber', 'infosec'],
        'infosec':                 ['security', 'cybersecurity', 'cyber'],
        'appsec':                  ['security', 'application security'],
        'blockchain':              ['web3', 'crypto', 'smart contract', 'solidity'],
        'quality assurance':       ['qa', 'sdet', 'test', 'testing', 'automation'],
        'qa':                      ['quality assurance', 'sdet', 'test', 'testing'],
        'sdet':                    ['qa', 'test', 'automation', 'quality assurance'],

        // -------- Product / Program / Project --------------------------
        'product manager':         ['pm', 'product owner', 'apm', 'product lead'],
        'product owner':           ['pm', 'product manager', 'po'],
        'apm':                     ['associate product manager', 'product manager', 'pm'],
        'product':                 ['pm', 'apm', 'product owner', 'po'],
        'project manager':         ['pm', 'program manager', 'pmp'],
        'program manager':         ['program', 'tpm', 'project manager'],
        'tpm':                     ['technical program manager', 'program manager'],
        'scrum master':            ['agile', 'scrum', 'product owner'],
        'business analyst':        ['ba', 'systems analyst', 'requirements analyst'],

        // -------- Design / UX / UI / Creative --------------------------
        'ux':                      ['user experience', 'product design', 'design'],
        'ui':                      ['user interface', 'product design', 'visual design', 'frontend'],
        'user experience':         ['ux', 'product design', 'interaction design'],
        'product design':          ['ux', 'ui', 'design', 'visual design'],
        'visual design':           ['ui', 'graphic design', 'product design'],
        'graphic design':          ['visual design', 'creative', 'brand'],
        'interaction design':      ['ux', 'ixd', 'product design'],
        'design':                  ['ux', 'ui', 'product design', 'visual design'],
        'ux research':             ['user research', 'design research', 'research'],
        'user research':           ['ux research', 'research', 'design research'],

        // -------- Finance / Accounting --------------------------------
        'financial':               ['finance', 'fp&a', 'fpa', 'treasury', 'accounting'],
        'finance':                 ['financial', 'fp&a', 'fpa', 'treasury', 'accounting'],
        'fp&a':                    ['financial planning', 'finance', 'financial', 'fpa'],
        'fpa':                     ['fp&a', 'financial planning', 'finance', 'financial'],
        'accounting':              ['accountant', 'controller', 'audit', 'bookkeeping', 'gl', 'tax', 'cpa'],
        'accountant':              ['accounting', 'controller', 'audit', 'tax', 'cpa', 'bookkeeping'],
        'controller':              ['accounting', 'finance', 'cfo'],
        'audit':                   ['auditor', 'accounting', 'compliance', 'internal audit'],
        'auditor':                 ['audit', 'accounting'],
        'tax':                     ['taxation', 'accounting', 'audit'],
        'treasury':                ['finance', 'financial', 'cash management'],
        'investment':              ['investments', 'investor', 'pe', 'private equity', 'vc'],
        'investor':                ['investment', 'pe', 'venture'],
        'private equity':          ['pe', 'investment', 'buyout'],
        'venture capital':         ['vc', 'investment', 'venture'],
        'risk':                    ['risk management', 'compliance', 'underwriting'],

        // -------- Sales / Customer Success / Marketing -----------------
        'sales':                   ['account executive', 'ae', 'business development', 'bd', 'sdr', 'bdr', 'inside sales', 'revenue'],
        'account executive':       ['ae', 'sales', 'enterprise sales'],
        'ae':                      ['account executive', 'sales'],
        'sdr':                     ['sales development', 'bdr', 'inside sales', 'sales'],
        'bdr':                     ['business development', 'sdr', 'sales development', 'sales'],
        'business development':    ['bd', 'sdr', 'bdr', 'partnerships', 'sales'],
        'account manager':         ['account management', 'csm', 'customer success'],
        'customer success':        ['csm', 'account manager', 'customer experience'],
        'csm':                     ['customer success manager', 'account manager'],
        'partnerships':            ['business development', 'bd', 'alliances', 'channel'],
        'marketing':               ['growth', 'demand gen', 'brand', 'communications', 'comms', 'content', 'seo', 'sem', 'crm', 'lifecycle'],
        'growth':                  ['marketing', 'growth marketing', 'performance marketing', 'demand gen'],
        'demand gen':              ['demand generation', 'marketing', 'growth'],
        'content':                 ['content marketing', 'copywriter', 'editorial', 'marketing'],
        'seo':                     ['search engine optimization', 'sem', 'search marketing', 'marketing'],
        'sem':                     ['search engine marketing', 'seo', 'paid search', 'marketing'],
        'brand':                   ['branding', 'marketing', 'creative'],
        'communications':          ['comms', 'pr', 'public relations', 'marketing'],
        'pr':                      ['public relations', 'communications', 'comms'],

        // -------- Operations / Strategy / BizOps -----------------------
        'operations':              ['ops', 'business ops', 'biz ops', 'strategy ops'],
        'ops':                     ['operations', 'business operations'],
        'business operations':     ['biz ops', 'ops', 'strategy ops', 'revenue ops'],
        'biz ops':                 ['business operations', 'ops', 'strategy'],
        'revenue operations':      ['revops', 'sales ops', 'ops'],
        'revops':                  ['revenue operations', 'sales ops'],
        'sales ops':                ['sales operations', 'revops', 'revenue operations'],
        'strategy':                ['strategic', 'business strategy', 'corporate strategy'],
        'chief of staff':          ['cos', 'strategy', 'executive office'],
        'supply chain':            ['logistics', 'procurement', 'operations'],
        'logistics':               ['supply chain', 'distribution', 'operations'],

        // -------- HR / Talent / Recruiting / People --------------------
        'human resources':         ['hr', 'people', 'people ops', 'talent'],
        'hr':                      ['human resources', 'people', 'people ops'],
        'people':                  ['hr', 'people ops', 'human resources'],
        'people operations':       ['people ops', 'hr', 'human resources'],
        'talent':                  ['recruiting', 'recruiter', 'talent acquisition', 'hr'],
        'talent acquisition':      ['recruiting', 'recruiter', 'ta'],
        'recruiting':              ['recruiter', 'talent acquisition', 'sourcer'],
        'recruiter':               ['recruiting', 'talent acquisition', 'sourcer'],
        'sourcer':                 ['recruiter', 'recruiting', 'talent'],
        'l&d':                     ['learning and development', 'training', 'enablement'],
        'compensation':            ['comp', 'rewards', 'total rewards', 'benefits'],

        // -------- Legal / Compliance / Policy --------------------------
        'legal':                   ['lawyer', 'attorney', 'counsel', 'paralegal'],
        'attorney':                ['lawyer', 'counsel', 'legal'],
        'counsel':                 ['legal', 'attorney', 'lawyer'],
        'paralegal':               ['legal', 'legal assistant'],
        'compliance':              ['regulatory', 'risk', 'governance', 'legal'],
        'regulatory':              ['compliance', 'regulatory affairs', 'governance'],
        'policy':                  ['public policy', 'government affairs', 'regulatory'],

        // -------- Healthcare / Clinical / Biotech ---------------------
        'clinical':                ['clinical research', 'cra', 'clinical operations'],
        'clinical research':       ['clinical', 'cra', 'cro'],
        'cra':                     ['clinical research associate', 'clinical research'],
        'medical':                 ['clinical', 'physician', 'healthcare'],
        'nursing':                 ['nurse', 'rn', 'lpn', 'clinical'],
        'biomedical':              ['biotech', 'biology', 'medical', 'r&d'],
        'biotech':                 ['biomedical', 'pharmaceutical', 'pharma'],
        'pharmaceutical':          ['pharma', 'biotech'],
        'pharmacology':            ['pharmacist', 'pharmaceutical'],
        'public health':           ['epidemiology', 'health policy', 'medical'],

        // -------- R&D / Hardware / Mechanical / Civil / Aerospace -----
        'r&d':                     ['research and development', 'research', 'product development'],
        'mechanical':              ['mech', 'mechatronics', 'manufacturing'],
        'electrical':              ['ee', 'electronics', 'circuit', 'power'],
        'civil':                   ['structural', 'construction', 'infrastructure engineer'],
        'aerospace':               ['aero', 'aviation', 'space', 'astronautics'],
        'chemical':                ['chemistry', 'process engineer', 'chem e'],
        'materials':               ['materials science', 'metallurgy'],
        'industrial':              ['industrial engineering', 'manufacturing', 'process'],
        'manufacturing':           ['production', 'industrial', 'mfg'],
        'quality':                 ['qc', 'quality control', 'qa'],
        'qc':                      ['quality control', 'quality', 'qa'],

        // -------- Research / Academic ---------------------------------
        'research':                ['scientist', 'researcher', 'r&d'],
        'researcher':              ['research', 'scientist', 'analyst'],
        'scientist':               ['research', 'researcher'],
        'postdoc':                 ['post doctoral', 'research fellow', 'researcher'],

        // -------- Education / Training --------------------------------
        'teacher':                 ['educator', 'instructor', 'teaching'],
        'instructor':              ['teacher', 'trainer', 'educator'],
        'professor':               ['lecturer', 'faculty', 'academic'],
        'curriculum':              ['instructional design', 'course developer', 'training'],

        // -------- Customer Support ------------------------------------
        'customer support':        ['support', 'customer service', 'cs', 'help desk'],
        'customer service':        ['cs', 'support', 'customer support'],
        'support':                 ['customer support', 'technical support', 'help desk'],
        'technical support':       ['tech support', 'support engineer', 'help desk'],

        // -------- Writing / Editorial / Localization ------------------
        'writer':                  ['copywriter', 'content writer', 'editor', 'editorial'],
        'editor':                  ['editorial', 'writer', 'copy editor'],
        'technical writer':        ['tech writer', 'documentation', 'docs'],
        'localization':            ['l10n', 'translation', 'translator'],
        'translator':              ['translation', 'localization', 'l10n'],
    };
    function expandQualifier(q) {
        const lower = q.toLowerCase().trim();
        const out = new Set();
        if (lower) out.add(lower);
        if (ABBREV_MAP[lower]) ABBREV_MAP[lower].forEach((a) => out.add(a));
        // Reverse: if the qualifier itself is an abbrev, also accept the long form.
        for (const [long, abbrevs] of Object.entries(ABBREV_MAP)) {
            if (abbrevs.includes(lower)) out.add(long);
        }
        return [...out];
    }
    // Build qualifier set from the POSITIVE preferredRoles only (skip the
    // negative entries we already partition into excludedRoleTokens above).
    const positiveRoles = [];
    for (const r of rolesRaw) {
        const s = String(r || '').trim();
        if (!s) continue;
        if (NEG.test(s)) continue;
        if (s.includes(',') && NEG.test(s.split(',').slice(-1)[0].trim())) {
            for (const sub of s.split(/\s*,\s*/)) {
                const t = sub.trim();
                if (t && !NEG.test(t)) positiveRoles.push(t);
            }
        } else {
            positiveRoles.push(s);
        }
    }
    const qualifierTokens = new Set();
    for (const role of positiveRoles) {
        // "Data Analyst" → "Data" ; "Business Intelligence Engineer" → "Business Intelligence"
        const stripped = role
            .replace(ROLE_NOUN_STRIP, '')
            .replace(/[()/+,]/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        // Fallback: when the preferredRole is just a role noun ("Accountant",
        // "Recruiter", "Designer") the strip produces an empty string. Use
        // the lowercase original so ABBREV_MAP lookups still resolve.
        const seed = stripped || role.toLowerCase().trim();
        if (!seed) continue;
        for (const v of expandQualifier(seed)) qualifierTokens.add(v);
        // Single-word fallback: also accept the strongest single token
        // (e.g. "Web Analyst" → also accept "Web").
        const tokens = seed.split(/\s+/).filter((t) => t.length >= 2);
        for (const tok of tokens) for (const v of expandQualifier(tok)) qualifierTokens.add(v);
    }
    function vetoQualifierMiss(decision, job) {
        if (!decision.pick) return decision;
        if (qualifierTokens.size === 0) return decision; // no positive roles → don't veto
        const title = String(job?.title || '').toLowerCase();
        for (const tok of qualifierTokens) {
            if (tok && title.includes(tok)) return decision; // match found
        }
        const sample = positiveRoles.slice(0, 4).join(', ') + (positiveRoles.length > 4 ? '…' : '');
        return {
            ...decision,
            pick: false,
            skipKind: 'role-mismatch',
            matchedRole: '',
            reason: `Skip — "${job?.title || ''}" carries no qualifier from preferred roles [${sample}]; not closely related. (Auto-vetoed; AI scored ${decision.score}.)`,
        };
    }

    // Batch in chunks of 8 — matches DEFAULTS.autoBatchSize so a single
    // auto-batch trigger maps to ONE OpenAI call (no internal split).
    // 8 jobs × 4500 char JDs ≈ 9k input tokens — still under gpt-4o-mini's
    // 8s typical latency window.
    const BATCH = 8;
    const decisions = [];
    const jobsById = new Map(jobs.map((j) => [j.jobId, j]));
    const totalBatches = Math.ceil(jobs.length / BATCH);
    for (let i = 0; i < jobs.length; i += BATCH) {
        const batch = jobs.slice(i, i + BATCH);
        const batchIndex = Math.floor(i / BATCH) + 1;
        notifyPopup('ai-batch-start', {
            batchIndex,
            totalBatches,
            batchSize: batch.length,
            jobs: batch.map((j) => ({ jobId: j.jobId, title: j.title, company: j.company })),
        });
        const body = {
            // Locked — judging is tuned for gpt-4o-mini's reasoning + cost
            // profile. Don't read from config; ignore stored override.
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt({ profile, jobs: batch, threshold, aiSummary }) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
        };
        let res;
        try {
            res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${state.config.openaiKey}`,
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            return { ok: false, error: 'NETWORK', message: e.message };
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return { ok: false, error: `OPENAI_${res.status}`, message: txt.slice(0, 400) };
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content || '{}';
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { /* ignore */ }
        if (!parsed || !Array.isArray(parsed.decisions)) {
            return { ok: false, error: 'BAD_AI_JSON', message: content.slice(0, 400) };
        }
        const VALID_SKIP_KINDS = new Set([
            'threshold', 'role-mismatch', 'seniority-mismatch',
            'location-mismatch', 'auth-mismatch', 'company-blocked',
        ]);
        for (const d of parsed.decisions) {
            const skipKindRaw = typeof d.skipKind === 'string' ? d.skipKind.trim() : '';
            let norm = {
                id: d.id,
                pick: d.pick === true,
                score: Number.isInteger(d.score) ? d.score : 0,
                reason: typeof d.reason === 'string' ? d.reason : '',
                matchedRole: typeof d.matchedRole === 'string' ? d.matchedRole : '',
                // Picks always emit '' skipKind. Skips fall back to 'threshold'
                // when the model returns junk so the UI never shows an
                // un-colored border.
                skipKind: d.pick === true
                    ? ''
                    : (VALID_SKIP_KINDS.has(skipKindRaw) ? skipKindRaw : 'threshold'),
            };
            const job = jobsById.get(d.id);
            // Deterministic vetoes (run in this order so excluded wins):
            //   1. excludedRoles veto — explicit opt-out by the client.
            //   2. qualifier-miss veto — title doesn't contain any preferred
            //      discipline qualifier (Data, Business Intelligence, etc.).
            // Both are no-ops when their token sets are empty.
            norm = vetoExcluded(norm, job);
            norm = vetoQualifierMiss(norm, job);
            decisions.push(norm);
            // Stream each judged job into the side panel so the operator
            // sees reasoning in real time, not just at the end.
            if (job) {
                notifyPopup('decision', { decision: norm, job });
            }
        }
        notifyPopup('ai-progress', { judged: decisions.length, total: jobs.length });
    }
    return { ok: true, decisions };
}

// ---- pipeline orchestrator ----------------------------------------------

async function judgeOnly() {
    if (!state.config.authEmail) return { ok: false, error: 'NO_CLIENT', message: 'pick a client first' };
    if (!state.config.openaiKey) return { ok: false, error: 'NO_OPENAI_KEY', message: 'set OpenAI API key' };
    const jobs = [...state.capture.jobs.values()];
    if (jobs.length === 0) return { ok: false, error: 'NO_JOBS', message: 'capture is empty' };

    notifyPopup('phase', { phase: 'loading-profile' });
    const profileRes = await getProfile(state.config.authEmail);
    if (!profileRes.ok) return { ok: false, error: 'PROFILE_LOAD', message: profileRes.error };
    const profile = profileRes.profile;
    const aiSummary = typeof profile?.aiSummary === 'string' ? profile.aiSummary : '';

    // Pre-judge: resolve full JD for every captured job so OpenAI scores
    // against real disqualifiers, not the 200-char matchSummary preview.
    notifyPopup('phase', { phase: 'resolving-jds', total: jobs.length });
    await resolvePreJudge(jobs);

    notifyPopup('phase', { phase: 'judging', total: jobs.length, usingSummary: !!aiSummary });
    const judge = await aiJudge({
        profile, jobs,
        threshold: state.config.aiThreshold ?? 50,
        aiSummary,
    });
    if (!judge.ok) return judge;

    state.judged = {
        decisions: judge.decisions,
        jobs,
        completedAt: new Date().toISOString(),
        usedAiSummary: !!aiSummary,
    };
    await persistJudged();
    notifyPopup('phase', { phase: 'judged' });
    // Fire-and-forget URL + JD resolution — operator can review picks
    // while SW resolves in parallel. Track the in-flight promise so
    // Push can await it and never POST partial data.
    state.resolveInFlight = resolvePicksAsync()
        .catch((e) => {
            console.warn('[FF-JRD] resolvePicksAsync threw:', e?.message);
        })
        .finally(() => {
            state.resolveInFlight = null;
        });
    return {
        ok: true,
        decisions: judge.decisions,
        usedAiSummary: !!aiSummary,
        total: jobs.length,
    };
}

// ---- AUTO pipeline -------------------------------------------------------
// Operator scrolls JR. SW captures jobs in DOM. When `autoBatchSize` new
// jobs accumulate, SW automatically: judges them via OpenAI → resolves
// JD via scraper backend (Playwright) → pushes picks straight to dashboard.
// Manual Judge / Push buttons stay available as a fallback.

async function ensureAutoProfile() {
    if (state.auto.profile) {
        return { ok: true, profile: state.auto.profile, aiSummary: state.auto.aiSummary };
    }
    if (!state.config.authEmail) return { ok: false, error: 'NO_CLIENT' };
    if (!state.config.openaiKey) return { ok: false, error: 'NO_OPENAI_KEY' };
    const profileRes = await getProfile(state.config.authEmail);
    if (!profileRes.ok) return { ok: false, error: 'PROFILE_LOAD', message: profileRes.error };
    state.auto.profile = profileRes.profile;
    state.auto.aiSummary = typeof profileRes.profile?.aiSummary === 'string' ? profileRes.profile.aiSummary : '';
    return { ok: true, profile: state.auto.profile, aiSummary: state.auto.aiSummary };
}

async function autoPushOne(job, decision) {
    if (state.auto.capHit) {
        // Refuse — server would 403 anyway. Mark visually so operator sees
        // why the pick didn't push.
        state.auto.stats.blocked += 1;
        notifyPopup('push-result', {
            jobId: job.jobId, outcome: 'blocked',
            detail: 'Client cap reached — push skipped',
        });
        return { outcome: 'blocked', code: 'CAP_HIT' };
    }
    const detail = await resolveJobDetail(job.jobId);
    let applyUrl = job.applyUrl;
    let description = job.description || job.matchSummary || '';
    if (detail.ok) {
        if (detail.description && detail.description.length > description.length) description = detail.description;
        if (detail.applyLink) {
            if (isLinkedInUrlBg(detail.applyLink)) {
                state.auto.stats.blocked += 1;
                notifyPopup('push-result', {
                    jobId: job.jobId, outcome: 'blocked',
                    detail: 'LinkedIn-hosted apply URL — skipped per policy',
                });
                return { outcome: 'blocked', code: 'LINKEDIN_APPLY' };
            }
            if (JR_FALLBACK_RX.test(String(applyUrl || ''))) applyUrl = detail.applyLink;
        }
    } else {
        console.warn('[FF-JRD] auto: detail resolve failed', job.jobId, detail.error || detail.message);
    }
    if (String(applyUrl || '').startsWith('__LINKEDIN_BLOCKED__:')) {
        state.auto.stats.blocked += 1;
        notifyPopup('push-result', {
            jobId: job.jobId, outcome: 'blocked',
            detail: 'LinkedIn apply URL — skipped per policy',
        });
        return { outcome: 'blocked', code: 'LINKEDIN_APPLY' };
    }
    notifyPopup('push-start', { jobId: job.jobId, title: job.title, company: job.company });
    const r = await pushJob({
        job: { ...job, applyUrl, description },
        clientEmail: state.config.authEmail,
        clientName: state.config.authName,
    });
    const body = r.body || {};
    let outcome, outcomeDetail = '';
    if (r.ok) {
        outcome = 'pushed';
        state.auto.stats.pushed += 1;
        bumpToday('pushed', 1);
    } else if (body?.message?.toLowerCase?.().includes('duplicate') || r.status === 409) {
        outcome = 'duplicate';
        outcomeDetail = body?.message || 'duplicate';
        state.auto.stats.dupes += 1;
    } else if (body?.error === 'TARGET_REACHED') {
        outcome = 'blocked';
        outcomeDetail = `${body.message} (${body.current}/${body.cap})`;
        state.auto.stats.blocked += 1;
        // First TARGET_REACHED in this session arms the global gate so the
        // remaining workers + future batches stop wasting round-trips.
        tripCapHit({
            source: 'addjob:TARGET_REACHED',
            cap: { targetJobCount: body.cap, currentOps: body.current, remaining: 0 },
            message: body.message,
        });
    } else if (body?.error === 'BLOCKED_COMPANY' || body?.error === 'BLOCKED_LOCATION' || r.status === 403) {
        outcome = 'blocked';
        outcomeDetail = `${body?.error || `HTTP_${r.status}`}: ${body?.message || ''}`;
        state.auto.stats.blocked += 1;
    } else {
        outcome = 'error';
        outcomeDetail = body?.message || `HTTP ${r.status}`;
        state.auto.stats.errors += 1;
    }
    notifyPopup('push-result', { jobId: job.jobId, outcome, detail: outcomeDetail });
    return { outcome, applyUrl, description };
}

// runAutoBatch: judge a slice → for picks, resolve+push in parallel.
// Updates state.judged so manual UI keeps a usable history.
async function runAutoBatch(batch) {
    if (state.auto.running) return state.auto.runningPromise;
    state.auto.running = true;
    let resolveRunning;
    state.auto.runningPromise = new Promise((r) => { resolveRunning = r; });
    const t0 = Date.now();
    console.log('[FF-JRD] auto: runAutoBatch START — size=' + batch.length);
    notifyPopup('auto-batch-start', { size: batch.length });
    try {
        const ctx = await ensureAutoProfile();
        if (!ctx.ok) {
            console.warn('[FF-JRD] auto: profile/openai missing —', ctx.error, ctx.message || '');
            notifyPopup('auto-batch-end', { error: ctx.error });
            return;
        }
        console.log('[FF-JRD] auto: profile loaded; aiSummary=' + (ctx.aiSummary ? ctx.aiSummary.length + ' chars' : 'none'));
        // Mark before judging so concurrent ingest doesn't re-queue.
        for (const j of batch) state.auto.processed.add(j.jobId);
        // Pre-judge: resolve full JD so OpenAI sees real disqualifiers
        // buried in the body, not just the 200-char matchSummary preview.
        // resolveJobDetail is cached so this is cheap on re-runs.
        console.log('[FF-JRD] auto: resolving full JDs for batch of', batch.length);
        await resolvePreJudge(batch);
        console.log('[FF-JRD] auto: judging', batch.length, 'jobs via OpenAI…');
        const judge = await aiJudge({
            profile: ctx.profile,
            jobs: batch,
            threshold: state.config.aiThreshold ?? 50,
            aiSummary: ctx.aiSummary,
        });
        if (!judge.ok) {
            console.warn('[FF-JRD] auto: aiJudge failed', judge.error, judge.message);
            // Un-mark so a later retry can pick them up.
            for (const j of batch) state.auto.processed.delete(j.jobId);
            notifyPopup('auto-batch-end', { error: judge.error });
            return;
        }
        state.auto.stats.judged += batch.length;
        const decisionById = new Map(judge.decisions.map((d) => [d.id, d]));
        const picks = batch.filter((j) => decisionById.get(j.jobId)?.pick === true);
        state.auto.stats.picks += picks.length;
        // Tally skipKind so admin sees role-mismatch vs threshold vs other —
        // helps pinpoint why low-pick clients are low (bad role list vs bad
        // threshold). Stored as a flat object: { 'role-mismatch':3, 'threshold':1, ... }
        if (!state.auto.stats.skipsByKind) state.auto.stats.skipsByKind = {};
        let roleMissDelta = 0, otherSkipDelta = 0;
        for (const d of judge.decisions) {
            if (d.pick === true) continue;
            const k = d.skipKind || 'threshold';
            state.auto.stats.skipsByKind[k] = (state.auto.stats.skipsByKind[k] || 0) + 1;
            if (k === 'role-mismatch') roleMissDelta += 1;
            else otherSkipDelta += 1;
        }
        if (roleMissDelta) bumpToday('roleMismatch', roleMissDelta);
        if (otherSkipDelta) bumpToday('otherSkip', otherSkipDelta);
        console.log('[FF-JRD] auto: judge done —', picks.length, 'picks /', batch.length, 'judged');

        // Stitch into state.judged so the side panel + history reflect it.
        if (!state.judged) {
            state.judged = { decisions: [], jobs: [], completedAt: new Date().toISOString(), auto: true };
        }
        state.judged.decisions.push(...judge.decisions);
        state.judged.jobs.push(...batch);
        await persistJudged().catch(() => {});

        // Parallel push with bounded concurrency.
        const conc = Math.max(1, Number(state.config.autoPushConcurrency) || 3);
        let cursor = 0;
        async function worker() {
            while (cursor < picks.length) {
                const idx = cursor++;
                const job = picks[idx];
                const d = decisionById.get(job.jobId) || {};
                try {
                    await autoPushOne(job, d);
                } catch (e) {
                    state.auto.stats.errors += 1;
                    console.warn('[FF-JRD] auto: push threw', job.jobId, e?.message);
                }
            }
        }
        await Promise.all(Array.from({ length: conc }, worker));
        console.log('[FF-JRD] auto: runAutoBatch DONE in', Date.now() - t0, 'ms — stats:', state.auto.stats);
        notifyPopup('auto-batch-end', { stats: { ...state.auto.stats } });
    } finally {
        state.auto.running = false;
        try { resolveRunning && resolveRunning(); } catch {}
        state.auto.runningPromise = null;
        // Maybe more captures arrived while we ran — drain.
        if (state.config.autoMode) setTimeout(() => tryAutoBatch(), 0);
    }
}

function tryAutoBatch() {
    if (state.auto.capHit) {
        console.warn('[FF-JRD] auto: skip — capHit (client target reached)');
        return;
    }
    if (state.auto.running) {
        console.log('[FF-JRD] auto: skip — batch already running');
        return;
    }
    if (!state.config.autoMode) {
        console.log('[FF-JRD] auto: skip — autoMode off');
        return;
    }
    if (!state.config.authEmail) {
        console.warn('[FF-JRD] auto: skip — NO_CLIENT (authEmail missing)');
        return;
    }
    if (!state.config.openaiKey) {
        console.warn('[FF-JRD] auto: skip — NO_OPENAI_KEY (state.config.openaiKey empty). Save Settings or set key.');
        return;
    }
    const size = Math.max(1, Number(state.config.autoBatchSize) || 8);
    const pending = [];
    for (const j of state.capture.jobs.values()) {
        if (!state.auto.processed.has(j.jobId)) pending.push(j);
        if (pending.length >= size) break;
    }
    console.log('[FF-JRD] auto: tryAutoBatch — pending=' + pending.length + ' threshold=' + size + ' processed=' + state.auto.processed.size + '/' + state.capture.jobs.size);
    if (pending.length < size) return;
    console.log('[FF-JRD] auto: firing batch of', pending.length, 'jobs');
    runAutoBatch(pending).catch((e) => console.warn('[FF-JRD] runAutoBatch threw', e?.message));
}

// flushAutoBatch: drain whatever's pending regardless of size. Awaits any
// in-flight batch first so the operator's "Stop & push" click reflects the
// FINAL stats, not stats captured mid-batch. Loops until processed catches
// up to capture.jobs so leftover < BATCH_SIZE jobs don't get stranded.
async function flushAutoBatch() {
    if (state.auto.capHit) return;
    if (!state.config.autoMode) return;
    if (!state.config.authEmail || !state.config.openaiKey) return;

    // 1. If a batch is already running, wait for it to finish before deciding
    //    if more pending exists. Without this the flush returns immediately
    //    with stale stats and the UI shows zeros while the SW is still
    //    pushing in the background.
    //    Defensive: if running===true but runningPromise===null (SW evicted
    //    mid-batch, leaving the flag wedged), force-clear so the flush
    //    doesn't hang forever. User-facing "Judge now" button relies on
    //    this so a stuck pipeline doesn't lock them out.
    let waitSafety = 0;
    while (state.auto.running && waitSafety++ < 60) {
        if (!state.auto.runningPromise) {
            console.warn('[FF-JRD] auto.running stuck without promise — clearing');
            state.auto.running = false;
            break;
        }
        try { await state.auto.runningPromise; } catch {}
    }

    // 2. Loop: drain pending in batches until none left. Each iteration
    //    triggers a fresh runAutoBatch that processes everything still
    //    unprocessed (no size threshold — flush is "drain everything").
    let safety = 50; // guard against infinite loops if processed bookkeeping breaks
    while (safety-- > 0) {
        const pending = [];
        for (const j of state.capture.jobs.values()) {
            if (!state.auto.processed.has(j.jobId)) pending.push(j);
        }
        if (pending.length === 0) return;
        await runAutoBatch(pending);
        // After runAutoBatch, runningPromise is cleared; if more captures
        // arrived during the run, the next iteration picks them up.
    }
}

// reportSessionStat: POST one row to /extension/session-stat so the AI
// Summaries admin page can render per-operator + per-client work-volume
// without scraping the extension's local state. Fire-and-forget — never
// blocks the operator's flow on network or backend availability.
async function reportSessionStat(reason = 'stop') {
    try {
        const operatorName = String(state.config.operatorName || '').trim();
        const clientEmail = String(state.config.authEmail || '').trim().toLowerCase();
        if (!operatorName || !clientEmail) return; // nothing to report
        const captures = state.capture.jobs?.size || 0;
        const linkedinSkipped = state.capture.linkedinSkipped?.size || 0;
        const stats = state.auto.stats || {};
        // Skip empty noise on stop/clear with nothing happening. Heartbeats
        // (`reason==='heartbeat'`) bypass this so the SCRAPED counter still
        // populates the moment the first capture lands.
        if (
            reason !== 'heartbeat'
            && captures === 0
            && (stats.judged || 0) === 0
            && (stats.pushed || 0) === 0
        ) return;
        const startedAt = state.capture.startedAt
            ? new Date(state.capture.startedAt).toISOString()
            : null;
        const skips = stats.skipsByKind || {};
        const skipsRollup = {
            roleMismatch: skips['role-mismatch'] || 0,
            seniorityMismatch: skips['seniority-mismatch'] || 0,
            locationMismatch: skips['location-mismatch'] || 0,
            authMismatch: skips['auth-mismatch'] || 0,
            threshold: skips.threshold || 0,
            companyBlocked: skips['company-blocked'] || 0,
        };
        const skipsOther =
            (stats.judged || 0) - (stats.picks || 0)
            - skipsRollup.roleMismatch - skipsRollup.seniorityMismatch
            - skipsRollup.locationMismatch - skipsRollup.authMismatch
            - skipsRollup.threshold - skipsRollup.companyBlocked;
        const body = {
            // sessionId enables backend upsert — heartbeats during capture
            // mutate the same row instead of inserting one-per-event.
            sessionId: state.capture.sessionId || '',
            extensionCode: state.config.extensionCode || '',
            operatorName,
            clientEmail,
            clientName: state.config.authName || '',
            captures,
            linkedinSkipped,
            judged: stats.judged || 0,
            picks: stats.picks || 0,
            pushed: stats.pushed || 0,
            duplicates: stats.dupes || 0,
            blocked: stats.blocked || 0,
            errors: stats.errors || 0,
            skipsByKind: skips,
            skipsRollup: { ...skipsRollup, other: Math.max(0, skipsOther) },
            startedAt,
            endedAt: new Date().toISOString(),
            extensionVersion: chrome?.runtime?.getManifest?.()?.version || '',
            reason,
        };
        await dashboardFetch('/extension/session-stat', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    } catch (e) {
        console.warn('[FF-JRD] reportSessionStat failed:', e?.message);
    }
}

async function pushSelected({ jobIds }) {
    console.log('[FF-JRD] pushSelected', jobIds?.length, 'ids');
    // SW may have been evicted between Judge and Push — try restoring.
    if (!state.judged) {
        console.log('[FF-JRD] pushSelected: state.judged null, restoring from session');
        await restoreState();
    }
    if (!state.judged) {
        return { ok: false, error: 'NOT_JUDGED', message: 'No judge result in memory or storage. Click Judge again.' };
    }
    // Block until any in-flight resolve completes — guarantees the
    // dashboard receives full JD + real applyLink, not the short
    // matchSummary captured at scroll time.
    if (state.resolveInFlight) {
        console.log('[FF-JRD] pushSelected: awaiting in-flight resolve…');
        notifyPopup('phase', { phase: 'awaiting-resolve' });
        await state.resolveInFlight;
        console.log('[FF-JRD] pushSelected: resolve complete, proceeding');
    }
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
        return { ok: false, error: 'NO_PICKS', message: 'no jobs selected for push' };
    }
    const idSet = new Set(jobIds);
    const decisionById = new Map((state.judged.decisions || []).map((d) => [d.id, d]));
    const picks = (state.judged.jobs || []).filter((j) => idSet.has(j.jobId));
    console.log('[FF-JRD] pushSelected picks:', picks.length, 'of', state.judged.jobs?.length || 0);
    if (picks.length === 0) {
        return { ok: false, error: 'NO_PICKS', message: `No matching jobs found in judged set (have ${state.judged.jobs?.length || 0} judged jobs)` };
    }

    notifyPopup('phase', { phase: 'pushing', toPush: picks.length });
    const results = { pushed: [], duplicates: [], blocked: [], errors: [] };
    for (const j of picks) {
        const d = decisionById.get(j.jobId) || {};
        notifyPopup('push-start', { jobId: j.jobId, title: j.title, company: j.company });

        // Picks were pre-resolved right after judge (resolvePicksAsync).
        // Two states to handle here:
        //   1. applyUrl prefixed with __LINKEDIN_BLOCKED__ → operator
        //      policy skip. Mark blocked, don't POST.
        //   2. applyUrl still JR fallback → resolution failed earlier;
        //      do one last attempt synchronously.
        if (String(j.applyUrl || '').startsWith('__LINKEDIN_BLOCKED__:')) {
            const lk = j.applyUrl.replace('__LINKEDIN_BLOCKED__:', '');
            notifyPopup('push-result', {
                jobId: j.jobId,
                outcome: 'blocked',
                detail: `LinkedIn apply URL (${lk}) — skipped per policy`,
            });
            results.blocked.push({
                jobId: j.jobId, title: j.title, company: j.company,
                code: 'LINKEDIN_APPLY', message: 'real apply URL is LinkedIn',
            });
            notifyPopup('push-progress', {
                done: results.pushed.length + results.duplicates.length + results.blocked.length + results.errors.length,
                target: picks.length,
            });
            continue;
        }
        // ALWAYS resolve at push time. Cache makes already-resolved
        // jobs return instantly. Guarantees dashboard receives full JD
        // every time, not the 200-char matchSummary captured at scroll.
        const detail = await resolveJobDetail(j.jobId);
        console.log('[FF-JRD] push-prep', j.jobId, {
            preDescLen: String(j.description || '').length,
            preApply: j.applyUrl,
            resolveOk: detail.ok,
            resolveDescLen: detail.ok ? detail.description.length : 0,
            resolveApply: detail.ok ? detail.applyLink : null,
            cached: detail.cached,
        });
        if (detail.ok) {
            if (detail.description && detail.description.length > (j.description || '').length) {
                j.description = detail.description;
            }
            if (detail.applyLink) {
                if (isLinkedInUrlBg(detail.applyLink)) {
                    notifyPopup('push-result', {
                        jobId: j.jobId, outcome: 'blocked',
                        detail: 'LinkedIn-hosted apply URL — skipped per policy',
                    });
                    results.blocked.push({
                        jobId: j.jobId, title: j.title, company: j.company,
                        code: 'LINKEDIN_APPLY', message: 'real apply URL is LinkedIn',
                    });
                    notifyPopup('push-progress', {
                        done: results.pushed.length + results.duplicates.length + results.blocked.length + results.errors.length,
                        target: picks.length,
                    });
                    continue;
                }
                if (JR_FALLBACK_RX.test(String(j.applyUrl || ''))) {
                    j.applyUrl = detail.applyLink;
                    notifyPopup('applyurl-resolved', { jobId: j.jobId, applyUrl: detail.applyLink });
                }
            }
        } else {
            console.warn('[FF-JRD] push-time resolve failed', j.jobId, detail.error || detail.message);
        }

        const r = await pushJob({
            // Push the FULL resolved JD (resolveJobDetail composed:
            // jobSummary + Responsibilities + Must have + Nice to have +
            // Key skills + Benefits). Falls back to matchSummary only
            // when resolve never landed for this job. AI score/reason
            // belongs on the dashboard's metadata, NOT in the JD body.
            job: { ...j, description: j.description || j.matchSummary || '' },
            clientEmail: state.config.authEmail,
            clientName: state.config.authName,
        });
        const body = r.body || {};
        let outcome, outcomeDetail = '';
        if (r.ok) {
            outcome = 'pushed';
            results.pushed.push({
                jobId: j.jobId, title: j.title, company: j.company,
                applyUrl: j.applyUrl, score: d.score || 0, reason: d.reason || '',
            });
        } else if (body?.message?.toLowerCase?.().includes('duplicate') || r.status === 409) {
            outcome = 'duplicate';
            outcomeDetail = body?.message || 'duplicate';
            results.duplicates.push({ jobId: j.jobId, title: j.title, company: j.company });
        } else if (body?.error === 'TARGET_REACHED') {
            outcome = 'blocked';
            outcomeDetail = `${body.message} (${body.current}/${body.cap})`;
            results.blocked.push({
                jobId: j.jobId, title: j.title, company: j.company,
                code: 'TARGET_REACHED', message: body.message,
            });
            tripCapHit({
                source: 'pushSelected:TARGET_REACHED',
                cap: { targetJobCount: body.cap, currentOps: body.current, remaining: 0 },
                message: body.message,
            });
            // Cap reached — every remaining push will also fail. Stop early.
            notifyPopup('push-result', { jobId: j.jobId, outcome, detail: outcomeDetail });
            console.warn('[FF-JRD] TARGET_REACHED — stopping push loop early');
            // Mark remaining picks as blocked-by-cap so UI shows them.
            const idx = picks.indexOf(j);
            for (const remaining of picks.slice(idx + 1)) {
                results.blocked.push({
                    jobId: remaining.jobId, title: remaining.title, company: remaining.company,
                    code: 'TARGET_REACHED', message: 'cap already reached — push aborted',
                });
                notifyPopup('push-result', {
                    jobId: remaining.jobId,
                    outcome: 'blocked',
                    detail: 'cap reached — push aborted',
                });
            }
            break;
        } else if (body?.error === 'BLOCKED_COMPANY' || body?.error === 'BLOCKED_LOCATION' || r.status === 403) {
            outcome = 'blocked';
            outcomeDetail = `${body?.error || `HTTP_${r.status}`}: ${body?.message || ''}`;
            results.blocked.push({
                jobId: j.jobId, title: j.title, company: j.company,
                code: body?.error || `HTTP_${r.status}`, message: body?.message || '',
            });
        } else {
            outcome = 'error';
            outcomeDetail = body?.message || `HTTP ${r.status}`;
            results.errors.push({
                jobId: j.jobId, title: j.title, company: j.company,
                status: r.status, message: body?.message || JSON.stringify(body || {}).slice(0, 200),
            });
        }
        notifyPopup('push-result', { jobId: j.jobId, outcome, detail: outcomeDetail });
        notifyPopup('push-progress', {
            done: results.pushed.length + results.duplicates.length + results.blocked.length + results.errors.length,
            target: picks.length,
        });
    }

    // Stitch outcome onto each decision so the side panel can reopen and
    // re-render the full results without another round of messages.
    const outcomeById = new Map();
    for (const p of results.pushed) outcomeById.set(p.jobId, { outcome: 'pushed', detail: '' });
    for (const dup of results.duplicates) outcomeById.set(dup.jobId, { outcome: 'duplicate', detail: 'duplicate' });
    for (const b of results.blocked) outcomeById.set(b.jobId, { outcome: 'blocked', detail: `${b.code}: ${b.message}` });
    for (const e of results.errors) outcomeById.set(e.jobId, { outcome: 'error', detail: e.message });
    const allJobs = state.judged?.jobs || [];
    const decoratedDecisions = (state.judged?.decisions || []).map((d) => {
        const job = allJobs.find((j) => j.jobId === d.id) || null;
        const out = outcomeById.get(d.id) || null;
        // If id was in idSet, it was operator-selected to push; outcome
        // tells the rest. Otherwise the operator chose not to push it.
        const wasSelected = idSet.has(d.id);
        return {
            ...d,
            job,
            outcome: out?.outcome || (wasSelected ? 'skipped' : 'not-selected'),
            detail: out?.detail || '',
        };
    });
    state.lastResult = {
        completedAt: new Date().toISOString(),
        captured: allJobs.length,
        decisions: decoratedDecisions,
        picks: picks.length,
        results,
        threshold: state.config.aiThreshold,
        clientEmail: state.config.authEmail,
        clientName: state.config.authName,
        usedAiSummary: !!state.judged?.usedAiSummary,
    };
    // Capture session resets on push success — operator starts fresh.
    state.capture.active = false;
    state.capture.jobs = new Map();
    state.judged = null;
    setBadge(0);
    try { await chrome.storage.session.remove(Object.values(PERSIST_KEYS)); } catch {}
    notifyPopup('phase', { phase: 'done' });
    return { ok: true, result: state.lastResult };
}

// ---- chrome.runtime message dispatcher ----------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Wrap entire dispatch in try/catch so any synchronous throw still
    // sends a response (otherwise channel closes silently → caller sees
    // "message port closed" lastError).
    try {
        return dispatchMessage(msg, _sender, sendResponse);
    } catch (e) {
        console.error('[FF-JRD] onMessage handler threw:', e);
        try {
            sendResponse({ ok: false, error: 'SW_HANDLER_THREW', message: e?.message || String(e) });
        } catch {}
        return false;
    }
});

function dispatchMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'jrd-cards') {
        ingestCards(msg.jobs);
        return false;
    }

    if (msg.type === 'jrd-linkedin-skipped') {
        let added = 0;
        for (const j of msg.jobs || []) {
            if (!j?.jobId) continue;
            if (state.capture.linkedinSkipped.has(j.jobId)) continue;
            state.capture.linkedinSkipped.set(j.jobId, j.applyLink || '');
            added += 1;
        }
        if (added > 0) {
            // LinkedIn-skipped cards still count toward "total scraped today"
            // per operator rule, but get their own bucket too.
            bumpToday('captures', added);
            bumpToday('linkedinSkipped', added);
            notifyPopup('linkedin-skip', {
                count: state.capture.linkedinSkipped.size,
                added,
                latest: msg.jobs.slice(-3),
            });
            scheduleSessionHeartbeat();
        }
        return false;
    }

    if (msg.type === 'jrd-update-jobs') {
        // Overwrite already-captured entries with their late-arriving real
        // employer URL (replaces JR fallback `/jobs/info/<id>`).
        let touched = 0;
        for (const j of msg.jobs || []) {
            if (!j?.jobId) continue;
            if (state.capture.jobs.has(j.jobId)) {
                state.capture.jobs.set(j.jobId, j);
                touched += 1;
            }
        }
        if (touched > 0) persistCapture();
        return false;
    }

    if (msg.type === 'jrd-drop-job') {
        // Late-discovered LinkedIn job — drop from buffer.
        if (state.capture.jobs.has(msg.jobId)) {
            state.capture.jobs.delete(msg.jobId);
            setBadge(state.capture.jobs.size);
            notifyPopup('count', { count: state.capture.jobs.size, added: 0 });
        }
        return false;
    }

    if (msg.type === 'jrd-state') {
        sendResponse({
            config: state.config,
            capture: {
                active: state.capture.active,
                count: state.capture.jobs.size,
                startedAt: state.capture.startedAt,
                linkedinSkipped: state.capture.linkedinSkipped.size,
            },
            auto: {
                running: state.auto.running,
                processed: state.auto.processed.size,
                stats: { ...state.auto.stats },
                capHit: state.auto.capHit,
                capInfo: state.auto.capInfo,
            },
            todayMetrics: { ...state.todayMetrics },
            lastResult: state.lastResult,
        });
        return true;
    }

    if (msg.type === 'jrd-refresh-cap') {
        refreshCapInfo()
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e?.message || String(e) }));
        return true;
    }

    if (msg.type === 'jrd-save-config') {
        const next = { ...state.config, ...(msg.config || {}) };
        chrome.storage.local.set(next).then(() => {
            state.config = next;
            sendResponse({ ok: true, config: state.config });
        });
        return true;
    }

    if (msg.type === 'jrd-verify-code') {
        verifyOperatorCode({ code: msg.code })
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-login') {
        clientLogin({ email: msg.email, password: msg.password })
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-logout') {
        clientLogout()
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-reload-profile') {
        reloadProfile()
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-start-capture') {
        if (state.auto.capHit) {
            sendResponse({
                ok: false,
                error: 'CAP_HIT',
                message: 'Client target reached — cannot start a new capture session. Raise the cap in Clients-Tracking → AI Summary tab.',
                capInfo: state.auto.capInfo,
            });
            return true;
        }
        state.capture.active = true;
        state.capture.startedAt = new Date().toISOString();
        // Mint a stable per-session id. Backend upserts heartbeats on this so
        // SCRAPED counter updates in real time instead of waiting for stop.
        state.capture.sessionId =
            (crypto?.randomUUID?.() ||
             `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        state.capture.jobs = new Map();
        state.capture.linkedinSkipped = new Map();
        state.judged = null;
        // Reset auto-pipeline tracking for this run.
        state.auto.processed = new Set();
        state.auto.profile = null;
        state.auto.aiSummary = '';
        state.auto.stats = { judged: 0, picks: 0, pushed: 0, dupes: 0, blocked: 0, errors: 0 };
        // capHit is NOT reset here — it tracks server-side state, not session.
        // Operator must raise the cap on the dashboard to clear it (refreshCapInfo
        // re-runs on push success / panel reopen).
        setBadge(0);
        persistCapture();
        chrome.storage.session.remove(PERSIST_KEYS.judged).catch(() => {});
        // Tell content script to clear its in-page cache so a re-scroll
        // re-emits cards instead of the de-dup squelching them.
        chrome.tabs
            .query({ url: ['https://jobright.ai/*', 'https://*.jobright.ai/*'] })
            .then((tabs) => {
                for (const t of tabs) {
                    chrome.tabs
                        .sendMessage(t.id, { type: 'jrd-reset-content-cache' })
                        .catch(() => {});
                }
            })
            .catch(() => {});
        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === 'jrd-stop-capture') {
        // Halt ingest but keep buffer + judged state. Auto-pipeline is allowed
        // to drain whatever's pending so half-batches aren't stranded.
        state.capture.active = false;
        persistCapture().catch(() => {});
        flushAutoBatch()
            .catch(() => {})
            .finally(() => reportSessionStat('stop'));
        sendResponse({ ok: true, count: state.capture.jobs.size });
        return true;
    }

    if (msg.type === 'jrd-clear-capture') {
        // Drain auto-pipeline tail before wiping so a half-batch isn't lost.
        flushAutoBatch().catch(() => {}).finally(() => {
            reportSessionStat('clear');
            state.capture.active = false;
            state.capture.jobs = new Map();
            state.capture.linkedinSkipped = new Map();
            state.capture.startedAt = null;
            state.judged = null;
            state.auto.processed = new Set();
            state.auto.profile = null;
            state.auto.aiSummary = '';
            state.auto.stats = { judged: 0, picks: 0, pushed: 0, dupes: 0, blocked: 0, errors: 0 };
            setBadge(0);
            chrome.storage.session.remove(Object.values(PERSIST_KEYS)).catch(() => {});
            sendResponse({ ok: true });
        });
        return true;
    }

    if (msg.type === 'jrd-flush-auto') {
        flushAutoBatch()
            .then(() => {
                reportSessionStat('flush');
                sendResponse({ ok: true, stats: { ...state.auto.stats } });
            })
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-set-auto-mode') {
        const enabled = msg.enabled !== false;
        state.config.autoMode = enabled;
        chrome.storage.local.set({ autoMode: enabled }).catch(() => {});
        sendResponse({ ok: true, autoMode: enabled });
        if (enabled) tryAutoBatch();
        return true;
    }

    if (msg.type === 'jrd-judge-only') {
        judgeOnly()
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-push-selected') {
        pushSelected({ jobIds: msg.jobIds || [] })
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    if (msg.type === 'jrd-build-summary') {
        buildSummary({ email: msg.email || state.config.authEmail })
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: 'UNEXPECTED', message: e.message }));
        return true;
    }

    return false;
}
