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

    // daily progress card
    dailyCard: $('daily-card'),
    dailyCount: $('daily-count'),
    dailyCap: $('daily-cap'),
    dailySub: $('daily-sub'),
    dailyFill: $('daily-fill'),
    dailySpark: $('daily-spark'),

    // settings (minimal — only cadence, threshold, auto toggle)
    aiThreshold: $('ai-threshold'),
    autoMode: $('auto-mode'),
    autoBatchSize: $('auto-batch-size'),
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
    push: $('push'),
    pushCount: $('push-count'),
    reset: $('reset'),

    // stats
    count: $('count'),
    picksCount: $('picks-count'),
    pushedCount: $('pushed-count'),
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
    authToken: '',
    authEmail: '',
    authName: '',
    authProfile: null,
    extensionCode: '',
    operatorName: '',
    openaiKey: '',
};
let captureCount = 0;
let linkedinSkippedCount = 0;
let captureActive = false;
let isProcessing = false;
let isJudged = false;
let isResolving = false;
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
    // Pull today's count + 14-day sparkline. Fire-and-forget — UI shows
    // a friendly skeleton while it loads.
    loadDailyStats().catch((e) => console.warn('[FF-JRD] loadDailyStats failed', e?.message));
}

// loadDailyStats: GET /push-history?email=X&days=14, paint today's count,
// cap progress, and 14-day sparkline. Refreshed on showMain + after every
// successful push. Server-truth, not local — survives SW eviction + dedup
// edge-cases.
let _dailyLoadInflight = null;
let _dailyRefreshTimer = null;
// Debounced refresh — auto-pipeline pushes can land in fast bursts; we
// only want ONE /push-history hit at the tail of the burst.
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
    const url = `${API_BASE_URL.replace(/\/+$/, '')}/push-history?email=${encodeURIComponent(cfg.authEmail)}&days=14`;
    _dailyLoadInflight = (async () => {
        let res;
        try {
            res = await fetch(url);
        } catch (e) {
            console.warn('[FF-JRD] push-history fetch threw', e?.message);
            return;
        }
        let body = null;
        try { body = await res.json(); } catch {}
        if (!res.ok || !body?.success) {
            console.warn('[FF-JRD] push-history non-ok', res.status, body);
            return;
        }
        renderDailyStats(body);
    })();
    try { await _dailyLoadInflight; }
    finally { _dailyLoadInflight = null; }
}

function renderDailyStats(history) {
    const days = Array.isArray(history?.history) ? history.history : [];
    const cap = Number.isFinite(Number(history?.capInfo?.targetJobCount)) ? history.capInfo.targetJobCount : null;
    const remaining = Number.isFinite(Number(history?.capInfo?.remaining)) ? history.capInfo.remaining : null;
    const totalOps = history?.totals?.ops || 0;

    // Densify last 14 days so missing rows render as empty bars.
    const today = new Date();
    const dense = [];
    const requested = Math.max(1, Number(history?.days) || 14);
    for (let i = requested - 1; i >= 0; i -= 1) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const found = days.find((r) => r.date === key);
        dense.push({ date: key, ops: found?.ops || 0 });
    }
    const todayKey = today.toISOString().slice(0, 10);
    const todayRow = dense.find((r) => r.date === todayKey) || { ops: 0 };
    const todayOps = todayRow.ops || 0;

    if (els.dailyCount) els.dailyCount.textContent = String(todayOps);

    // Cap context line: "of N total cap · X remaining" or "no cap" or
    // "cap reached" — short + readable.
    if (els.dailyCap) {
        if (cap == null) {
            els.dailyCap.textContent = '';
        } else {
            els.dailyCap.textContent = `· cap ${cap}`;
        }
    }
    if (els.dailySub) {
        if (cap == null) {
            els.dailySub.textContent = `${totalOps} total · 14d`;
        } else if (remaining == null || remaining <= 0) {
            els.dailySub.textContent = `Cap reached — ${totalOps} of ${cap}`;
        } else {
            els.dailySub.textContent = `${totalOps}/${cap} total · ${remaining} remaining`;
        }
    }

    // Cap progress bar (overall, not just today) — gives operator a
    // glanceable "how close are we to the wall" signal.
    if (els.dailyFill) {
        let pct = 0;
        let cls = '';
        if (cap != null && cap > 0) {
            pct = Math.min(100, Math.round((totalOps / cap) * 100));
            if (totalOps >= cap) cls = 'over';
            else if (pct >= 80) cls = 'warn';
        } else {
            // No cap → show today as fraction of busiest day in the window.
            const max = dense.reduce((m, r) => (r.ops > m ? r.ops : m), 0);
            pct = max > 0 ? Math.round((todayOps / max) * 100) : 0;
        }
        els.dailyFill.style.width = `${pct}%`;
        els.dailyFill.className = `daily-fill ${cls}`.trim();
    }

    // Sparkline. Empty days get a faint slot so the row stays visually
    // anchored. Today is highlighted regardless of count.
    if (els.dailySpark) {
        const max = dense.reduce((m, r) => (r.ops > m ? r.ops : m), 0) || 1;
        els.dailySpark.innerHTML = dense.map((r) => {
            const heightPct = r.ops > 0 ? Math.max(8, Math.round((r.ops / max) * 100)) : 6;
            const isToday = r.date === todayKey;
            const empty = r.ops === 0 && !isToday;
            const cls = `bar${isToday ? ' today' : ''}${empty ? ' empty' : ''}`;
            return `<div class="${cls}" style="height:${heightPct}%" title="${escapeHtml(r.date)} · ${r.ops} job${r.ops === 1 ? '' : 's'}"></div>`;
        }).join('');
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
    if (summary) {
        const built = meta.builtAt ? new Date(meta.builtAt).toLocaleString() : 'unknown';
        const words = meta.wordCount || summary.split(/\s+/).filter(Boolean).length;
        els.summaryStatus.textContent = 'Saved';
        els.summaryStatus.className = 'summary-status fresh';
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
    els.count.textContent = String(captureCount);
    els.linkedinSkippedCount.textContent = String(linkedinSkippedCount);
    els.activeState.textContent = captureActive ? 'YES' : 'no';
    els.statusDot.classList.toggle('active', !!captureActive);
    els.start.disabled = !!captureActive || isProcessing;
    // In auto-mode the Judge button becomes a "flush remaining" trigger;
    // it stays enabled whenever capture is active (no isJudged gate).
    if (cfg.autoMode !== false) {
        els.judge.textContent = 'Flush + push';
        els.judge.title = 'Auto pipeline runs as you scroll. Click to drain anything < batch size.';
        els.judge.disabled = !captureActive || captureCount === 0 || isProcessing;
    } else {
        els.judge.textContent = 'Judge captured';
        els.judge.title = '';
        els.judge.disabled = !captureActive || captureCount === 0 || isProcessing || isJudged;
    }
    els.push.hidden = !isJudged || cfg.autoMode !== false;
    if (isJudged) updatePushButton();
}

function updatePushButton() {
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

function scoreClass(score) {
    if (!Number.isFinite(score) || score === 0) return 's-zero';
    if (score >= 70) return 's-high';
    if (score >= 40) return 's-mid';
    return 's-low';
}

function renderCard(entry) {
    const { decision, job, outcome, detail, pushing, selectedPick, manualFlip } = entry;
    const card = document.createElement('div');
    const effectivePick = isJudged ? !!selectedPick : !!decision.pick;
    const pickClass = effectivePick ? 'pick' : 'skip';
    const outcomeClass = outcome ? `outcome-${outcome}` : '';
    const pushingClass = pushing ? 'pushing' : '';
    const flipClass = manualFlip ? 'manual-flip' : '';
    card.className = `decision-card ${pickClass} ${outcomeClass} ${pushingClass} ${flipClass}`;
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
        const displayUrl = blocked
            ? String(job.applyUrl).replace('__LINKEDIN_BLOCKED__:', '')
            : job.applyUrl;
        if (blocked) {
            actionsHtml += `<a href="${escapeHtml(displayUrl)}" target="_blank" rel="noreferrer" title="LinkedIn-hosted — auto-skipped per policy" style="text-decoration:line-through;color:var(--fg-muted)">View ↗</a>`;
        } else {
            actionsHtml += `<a href="${escapeHtml(displayUrl)}" target="_blank" rel="noreferrer">View ↗</a>`;
        }
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
        ${decision.reason ? `<div class="decision-reason">${escapeHtml(decision.reason)}</div>` : ''}
        ${actionsHtml || outcomeHtml ? `<div class="decision-actions">${actionsHtml}${outcomeHtml}</div>` : ''}
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
            'aiThreshold', 'autoMode', 'autoBatchSize',
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
        if (s.lastResult && Array.isArray(s.lastResult.decisions)) {
            decisionsMap.clear();
            for (const d of s.lastResult.decisions) {
                if (!d.job) continue;
                decisionsMap.set(d.id, {
                    decision: { id: d.id, pick: d.pick, score: d.score, reason: d.reason },
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
    if (els.dailyCount) els.dailyCount.textContent = '0';
    if (els.dailySub) els.dailySub.textContent = '—';
    if (els.dailyFill) els.dailyFill.style.width = '0%';
    if (els.dailySpark) els.dailySpark.innerHTML = '';
    if (els.dailyCap) els.dailyCap.textContent = '';
    showLogin();
}

async function saveConfig() {
    const config = {
        aiThreshold: Number.parseInt(els.aiThreshold.value, 10) || 50,
        autoMode: els.autoMode ? !!els.autoMode.checked : true,
        autoBatchSize: Math.max(1, Math.min(40, Number.parseInt(els.autoBatchSize?.value, 10) || 8)),
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
    isJudged = false;
    const r = await send('jrd-start-capture');
    if (r?.ok) {
        captureActive = true;
        captureCount = 0;
        applyState();
        setMessage('Capture started. Open jobright.ai/jobs/recommend and scroll.', 'ok');
    } else { setMessage('Failed to start capture.', 'error'); }
}

async function runJudge() {
    // In auto-mode, the SW pipelines judge → resolve → push as the operator
    // scrolls. Manual click here just drains anything not yet auto-batched.
    if (cfg.autoMode !== false) {
        setProcessing(true, '<span class="step">Auto-flush</span> — draining remaining captures through pipeline…');
        setMessage('Auto pipeline running — flushing remaining jobs (judge + scrape + push)…');
        applyState();
        const r = await send('jrd-flush-auto');
        setProcessing(false);
        if (!r?.ok) {
            setMessage(`Auto-flush failed: ${r?.error || 'UNEXPECTED'} ${r?.message || ''}`, 'error');
            return;
        }
        const s = r.stats || {};
        setMessage(
            `Auto totals — judged ${s.judged || 0} · picks ${s.picks || 0} · pushed ${s.pushed || 0} · dupes ${s.dupes || 0} · blocked ${s.blocked || 0} · errors ${s.errors || 0}`,
            'ok',
        );
        pushTickerLine(`✓ auto flush — pushed ${s.pushed || 0} / picks ${s.picks || 0}`);
        applyState();
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

async function runPush() {
    const selectedIds = [];
    for (const [jobId, e] of decisionsMap.entries()) if (e.selectedPick) selectedIds.push(jobId);
    if (selectedIds.length === 0) { setMessage('No picks selected.', 'warn'); return; }
    setProcessing(true, `<span class="step">Pushing</span> ${selectedIds.length} jobs…`);
    setMessage(`Pushing ${selectedIds.length} selected jobs…`);
    applyState();
    const r = await send('jrd-push-selected', { jobIds: selectedIds });
    setProcessing(false);
    applyState();
    if (!r?.ok) { setMessage(`Push failed: ${r?.error || 'UNEXPECTED'} ${r?.message || ''}`, 'error'); return; }
    const res = r.result;
    setMessage(
        `Done. ${(res.results.pushed || []).length} pushed, ${(res.results.duplicates || []).length} dupes, `
        + `${(res.results.blocked || []).length} blocked, ${(res.results.errors || []).length} errors.`,
        'ok',
    );
    setProgress(100, '<span class="step">Done</span>');
    isJudged = false;
    await refreshState();
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
        case 'count':
            captureCount = msg.count;
            applyState();
            if (msg.added > 0) setMessage(`+${msg.added} captured (total ${msg.count}).`, 'ok');
            break;
        case 'linkedin-skip':
            linkedinSkippedCount = msg.count;
            applyState();
            setMessage(`Skipped ${msg.added} LinkedIn-hosted job${msg.added === 1 ? '' : 's'} (${msg.count} total).`, 'warn');
            for (const j of msg.latest || []) pushTickerLine(`linkedin skip · ${j.applyLink}`, 'batch');
            break;
        case 'phase':
            els.phase.textContent = msg.phase;
            if (msg.phase === 'judging') {
                setProcessing(true, `<span class="step">AI judging</span> ${msg.total} captured jobs…`);
                pushTickerLine(`→ phase: judging (${msg.total} jobs)`, 'batch');
            }
            if (msg.phase === 'pushing') {
                setProgress(0, `<span class="step">Pushing</span> 0/${msg.toPush}…`);
                pushTickerLine(`→ phase: pushing (${msg.toPush} picks)`, 'push');
            }
            if (msg.phase === 'awaiting-resolve') {
                setMessage('Waiting for full JD resolution to finish before push…', 'warn');
                pushTickerLine('⏳ push paused — finishing full-JD resolve');
            }
            if (msg.phase === 'done') pushTickerLine(`✓ phase: done`);
            break;
        case 'ai-batch-start': handleAiBatchStart(msg); break;
        case 'ai-progress': handleAiProgress(msg); break;
        case 'push-progress': handlePushProgress(msg); break;
        case 'decision': ingestDecision({ decision: msg.decision, job: msg.job }); break;
        case 'push-start': ingestPushStart({ jobId: msg.jobId, title: msg.title, company: msg.company }); break;
        case 'push-result':
            ingestPushResult({ jobId: msg.jobId, outcome: msg.outcome, detail: msg.detail });
            if (msg.outcome === 'pushed') scheduleDailyRefresh();
            break;
        case 'auto-batch-start':
            pushTickerLine(`⚙ auto batch — ${msg.size} jobs → judging`, 'batch');
            ensureSectionVisible();
            break;
        case 'auto-batch-end':
            if (msg.error) {
                pushTickerLine(`✗ auto batch error: ${msg.error}`, 'batch');
            } else if (msg.stats) {
                const s = msg.stats;
                pushTickerLine(`✓ auto totals — judged ${s.judged} · picks ${s.picks} · pushed ${s.pushed} · dupes ${s.dupes} · blocked ${s.blocked} · errors ${s.errors}`, 'batch');
            }
            break;
        case 'applyurl-resolved': {
            const e = decisionsMap.get(msg.jobId);
            if (e?.job) {
                e.job = { ...e.job, applyUrl: msg.applyUrl };
                decisionsMap.set(msg.jobId, e);
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
els.saveConfig.addEventListener('click', saveConfig);
els.start.addEventListener('click', startCapture);
els.judge.addEventListener('click', runJudge);
els.push.addEventListener('click', runPush);
els.reset.addEventListener('click', resetCapture);

els.decisionsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-jobid]');
    if (!btn) return;
    e.preventDefault();
    toggleCardPick(btn.dataset.toggleJobid);
});

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

// Boot
refreshState();
