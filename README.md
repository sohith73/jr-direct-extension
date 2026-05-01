# FlashFire JR → Dashboard Direct (browser extension)

Standalone extension. **Not coupled to the scraper backend.** Speaks
directly to the FlashFire dashboard API (`/api/clients/all`,
`/get-profile`, `/addjob`) and to OpenAI (`/v1/chat/completions`).

## What it does

1. Operator opens the extension, fills in dashboard URL + OpenAI key once.
2. Loads clients from the dashboard, picks one.
3. Clicks **Start capture** and opens `https://jobright.ai/jobs/recommend`
   (logged in to JR however they normally do).
4. As the operator scrolls, a content script reads the **DOM** of every
   visible job card and forwards `{title, company, location, salary,
   workModel, seniority, experience, matchPercent, matchSummary, tags,
   applyUrl}` to the service worker.
5. Click **Judge & push** — the worker pulls the client's profile, runs
   each captured job through `gpt-4o-mini` in batches of 8 to grade fit,
   and POSTs the picks straight to `/addjob` on the dashboard.
6. Popup shows pushed / duplicate / blocked / error counts.

## Install (developer / unpacked)

```
chrome://extensions → Developer mode → Load unpacked → DASH/jr-direct-extension/
```

Pin the extension. Click the toolbar icon → expand **Settings**:

| Field | Notes |
|---|---|
| Dashboard base URL | e.g. `http://localhost:8086` or your prod URL |
| Dashboard service token | only required if your backend enforces `X-Service-Token` |
| Resume API base URL | e.g. `http://localhost:8001`; needed for **Build Summary** |
| OpenAI API key | `sk-…`; sent only to `https://api.openai.com` |
| Model | default `gpt-4o-mini`; any chat-completions model works |
| Threshold | AI fit-score cutoff (default 50). Higher = stricter |

## Build Summary

After picking a client, a "Candidate Summary" section appears. Click
**Build summary** to:

1. Fetch the client's onboarding profile from the dashboard.
2. Fetch their parsed resume from the resume API (`POST /api/resume-by-email`).
3. Send both to `gpt-4o-mini` with a structured prompt that produces a
   ≤500-word candidate brief covering: target roles + seniority, hard
   constraints, strong-pick signals, hard disqualifiers, grader notes.
4. **Save the summary on the client's profile in the dashboard** (new
   `aiSummary` field on `ProfileModel`).

After this, every **Judge** call uses the saved summary instead of raw
profile fields → tighter, more consistent picks. The summary survives
across runs because it lives in MongoDB on the client's profile.

Backend wiring (one-time, on `flashfire-dashboard-backend-main`):
- `Schema_Models/ProfileModel.js` — adds `aiSummary` + `aiSummaryMeta` fields.
- `Controllers/UpdateAiSummary.js` — new controller.
- `Routes.js` — new `POST /update-ai-summary` route.

## Two-step Judge → Push

| Step | Action |
|---|---|
| 1 | Click **Judge captured**. AI grades every captured job vs the candidate summary. Decisions stream in as cards |
| 2 | Each card shows a **✓ pick** / **✗ skip** toggle. Click any toggle to flip the AI's choice. Manually-flipped cards get a yellow "manual" badge |
| 3 | Click **Push N** (count = currently-selected picks). Only the selected jobs are POSTed to `/addjob` |

Save → click **↻** to load the client list → pick a client.

## Capture loop

1. Click **Start capture** in the popup.
2. Switch to a JR tab logged in as that client.
3. Scroll `/jobs/recommend`. The badge counts unique jobs as cards mount.
4. Click the extension → **Judge & push**.

The list is virtualised — cards mount and unmount as you scroll — so the
extension uses a `MutationObserver` plus a debounced scroll listener to
sweep newly-rendered cards. Each card is keyed by JR `jobId` so re-mounts
don't double-count.

## Selectors (validated 2026-04-28)

```
div.index_job-card__oqX1M[id]            — card root, id = JR jobId
a[href^="/jobs/info/<jobId>"]            — wrapping link
h2                                       — title
[class*="index_third-row__"]             — "<company> / <industries>"
img[alt="position"] + div                — location
img[alt="time"] + div                    — employment type
img[alt="money"] + div                   — salary
img[alt="remote"] + div                  — work model
img[alt="seniority"] + div               — seniority
img[alt="date"] + div                    — experience years
[role="progressbar"]                     — match percent
"Why this job is a match" header sibling — match summary
.ant-tag                                 — H1B Sponsor / No H1B / Comp. & Benefits
```

If JR ever renames a class, update `content-scrape.js`'s `pick*` functions.

## Apply URLs

Captured `applyUrl` is JR's own `https://jobright.ai/jobs/info/<jobId>`
detail page — JR controls the final redirect to the employer site. The
dashboard tracker stores this as the job link; clicking it opens the JR
page where the operator/client can hit "Apply with Autofill".

## File map

```
manifest.json           MV3, content_script on jobright.ai
content-scrape.js       DOM observer + extractor + iframe-panel injector
background.js           service worker — capture buffer, OpenAI judge, /addjob push
sidepanel.html/.js/.css panel UI (loaded inside an iframe injected into JR page)
```

**Panel behaviour:** mirrors `jobTODashboard` pattern — content script
injects a 420px-wide `<div>` containing `<iframe src="sidepanel.html">`
into the JR page DOM (top: 0, right: 0, fixed, z-index max). Click the
toolbar icon to toggle it open/closed. Auto-mounts hidden when JR loads.

Why iframe-injection instead of Chrome's native `sidePanel` API:
- Lives inside JR tab — fewer Chrome version constraints.
- Shows beside JR cards, no scaling reflow.
- Same pattern operators already know from FlashFire Job Extractor.

## Limitations

- Captures only what's currently rendered as you scroll. Fast scrolling
  can outrun MutationObserver — slow scroll is more reliable.
- Captured JD is the JR "Why this job is a match" summary, not the full
  employer description. Sufficient for AI judging title/seniority/location
  fit; if you need a full JD, click into JR before pushing.
- Service worker holds the capture buffer in memory. If Chrome evicts
  the worker (rare; the active JR tab keeps it warm), the buffer is lost.
- One client at a time per session.
- OpenAI key lives in `chrome.storage.local`. Do not install on a shared
  machine.
