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
        stats: { judged: 0, picks: 0, pushed: 0, dupes: 0, blocked: 0, errors: 0 },
    },
};

const PERSIST_KEYS = {
    captureActive: 'jrd_capture_active',
    captureJobs: 'jrd_capture_jobs',
    captureStartedAt: 'jrd_capture_startedAt',
    judged: 'jrd_judged',
};

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

function ingestCards(jobs) {
    if (!state.capture.active) return;
    let added = 0;
    for (const j of jobs || []) {
        if (!j?.jobId || state.capture.jobs.has(j.jobId)) continue;
        state.capture.jobs.set(j.jobId, j);
        added += 1;
    }
    setBadge(state.capture.jobs.size);
    notifyPopup('count', { count: state.capture.jobs.size, added });
    if (added > 0) persistCapture();
    // Auto pipeline: kick a batch when enough unprocessed jobs accumulate.
    if (state.config.autoMode) tryAutoBatch();
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
    try { await chrome.storage.local.set({ authProfile: r.profile }); } catch {}
    return { ok: true, profile: r.profile };
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

Return STRICT JSON only — no prose, no markdown:
{"decisions":[{"id":"<jobId>","pick":<true|false>,"score":<0-100>,"reason":"<200-280 chars>"}]}

Scoring rules:
- score 0-100 weighing: role family (40%), seniority alignment (25%),
  location/work-model fit (15%), skills/experience signals (15%),
  salary band (5%).
- Pick when score >= the operator threshold passed in the user prompt.
- Skip when seniority is 4+ levels off (intern asked → VP role; senior → entry intern).
- Treat Software Engineer / Backend / Frontend / Full-Stack / Platform / SRE
  / DevOps / Data / ML / AI / Mobile / Security / QA as ONE engineering family.
- Treat Product Manager / Product Owner / Associate PM / Sr PM / Director PM
  as the same family at different seniority.

REASON QUALITY — every reason MUST:
- Be 2-3 sentences, 200-280 chars total.
- Name specific signals you used: role title vs candidate roles, exact
  seniority levels, location vs preferred locations, salary if relevant,
  H1B/work-auth status, any blocker.
- For SKIPS: lead with the single biggest disqualifier ("Skip — senior PM
  but candidate is entry-level (4+ levels off)") then a secondary signal.
- For PICKS: name the strongest match factor first ("Strong fit — Senior
  Backend Engineer matches candidate's preferred roles + remote-friendly
  US role aligns with their work-from-anywhere preference"), then any caveat.

NEVER write generic reasons like "good fit" or "not a match" — always cite a concrete factor.`;

function buildUserPrompt({ profile, jobs, threshold, aiSummary }) {
    const intentBlock = aiSummary
        ? `## Candidate brief (authoritative — judge against THIS):\n${aiSummary}\n`
        : `## Candidate intent (no AI summary built yet — using raw profile):\n${JSON.stringify({
              roles: profile?.preferredRoles || '',
              seniority: profile?.experienceLevel || '',
              locations: profile?.preferredLocations || '',
              workAuth: profile?.usWorkEligibility || profile?.visaStatus || '',
              targetCompanies: profile?.targetCompanies || '',
              excludedCompanies: profile?.excludedCompanies || profile?.removedCompanies || '',
          }, null, 2)}\n`;
    const slim = jobs.map((j) => ({
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
    }));
    return `Threshold: ${threshold}

${intentBlock}
## Jobs to judge (one decision per id below):
${JSON.stringify(slim, null, 2)}`;
}

async function aiJudge({ profile, jobs, threshold, aiSummary = '' }) {
    if (!state.config.openaiKey) return { ok: false, error: 'NO_OPENAI_KEY' };
    if (!jobs.length) return { ok: true, decisions: [] };

    // Batch in chunks of 8 — small enough that a 4o-mini call latency stays
    // < 5s and JSON output reliably validates.
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
        for (const d of parsed.decisions) {
            const norm = {
                id: d.id,
                pick: d.pick === true,
                score: Number.isInteger(d.score) ? d.score : 0,
                reason: typeof d.reason === 'string' ? d.reason : '',
            };
            decisions.push(norm);
            // Stream each judged job into the side panel so the operator
            // sees reasoning in real time, not just at the end.
            const job = jobsById.get(d.id);
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
    } else if (body?.message?.toLowerCase?.().includes('duplicate') || r.status === 409) {
        outcome = 'duplicate';
        outcomeDetail = body?.message || 'duplicate';
        state.auto.stats.dupes += 1;
    } else if (body?.error === 'TARGET_REACHED') {
        outcome = 'blocked';
        outcomeDetail = `${body.message} (${body.current}/${body.cap})`;
        state.auto.stats.blocked += 1;
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
    if (state.auto.running) return;
    state.auto.running = true;
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
        // Maybe more captures arrived while we ran — drain.
        if (state.config.autoMode) setTimeout(() => tryAutoBatch(), 0);
    }
}

function tryAutoBatch() {
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

// flushAutoBatch: drain whatever's pending regardless of size. Called on
// stop-capture so a half-batch isn't stranded.
async function flushAutoBatch() {
    if (!state.config.autoMode) return;
    if (state.auto.running) return;
    if (!state.config.authEmail || !state.config.openaiKey) return;
    const pending = [];
    for (const j of state.capture.jobs.values()) {
        if (!state.auto.processed.has(j.jobId)) pending.push(j);
    }
    if (pending.length === 0) return;
    await runAutoBatch(pending);
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
            notifyPopup('linkedin-skip', {
                count: state.capture.linkedinSkipped.size,
                added,
                latest: msg.jobs.slice(-3),
            });
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
            },
            lastResult: state.lastResult,
        });
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
        state.capture.active = true;
        state.capture.startedAt = new Date().toISOString();
        state.capture.jobs = new Map();
        state.capture.linkedinSkipped = new Map();
        state.judged = null;
        // Reset auto-pipeline tracking for this run.
        state.auto.processed = new Set();
        state.auto.profile = null;
        state.auto.aiSummary = '';
        state.auto.stats = { judged: 0, picks: 0, pushed: 0, dupes: 0, blocked: 0, errors: 0 };
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

    if (msg.type === 'jrd-clear-capture') {
        // Drain auto-pipeline tail before wiping so a half-batch isn't lost.
        flushAutoBatch().catch(() => {}).finally(() => {
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
            .then(() => sendResponse({ ok: true, stats: { ...state.auto.stats } }))
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
