// --- Toggle here ---------------------------------------------------------
const USE_LOCAL = true;

// --- Production ----------------------------------------------------------
const PROD = {
    API_BASE_URL: 'https://dashboard-api.flashfirejobs.com',
    SCRAPER_BASE_URL: 'https://scraper.flashfirejobs.com',
    CLIENTS_TRACKING_BASE_URL: 'https://hq.flashfirejobs.com',
};

// --- Local dev -----------------------------------------------------------
const LOCAL = {
    API_BASE_URL: 'http://localhost:8086',
    SCRAPER_BASE_URL: 'http://localhost:8092',
    CLIENTS_TRACKING_BASE_URL: 'http://localhost:5173',
};

const PICK = USE_LOCAL ? LOCAL : PROD;

export const API_BASE_URL = PICK.API_BASE_URL;
export const SCRAPER_BASE_URL = PICK.SCRAPER_BASE_URL;
export const CLIENTS_TRACKING_BASE_URL = PICK.CLIENTS_TRACKING_BASE_URL;

// API paths on the dashboard backend.
export const API_ENDPOINTS = {
    CLIENT_LOGIN: '/extension/clientLogin',
    VERIFY_CODE: '/api/extension-codes/verify',
    ADD_JOB: '/addjob',
    GET_PROFILE: '/get-profile',
    BUILD_AI_SUMMARY: '/build-ai-summary',
    UPDATE_AI_SUMMARY: '/update-ai-summary',
};

// API paths on the scraper backend (Playwright job-detail extractor).
export const SCRAPER_ENDPOINTS = {
    JOB_DETAIL: '/api/jr/job-detail',
};

// Fully-qualified URLs — usually pulled from these instead of joining at
// the call site.
export const API_URLS = {
    CLIENT_LOGIN: `${API_BASE_URL}${API_ENDPOINTS.CLIENT_LOGIN}`,
    VERIFY_CODE: `${API_BASE_URL}${API_ENDPOINTS.VERIFY_CODE}`,
    ADD_JOB: `${API_BASE_URL}${API_ENDPOINTS.ADD_JOB}`,
    GET_PROFILE: `${API_BASE_URL}${API_ENDPOINTS.GET_PROFILE}`,
    BUILD_AI_SUMMARY: `${API_BASE_URL}${API_ENDPOINTS.BUILD_AI_SUMMARY}`,
    UPDATE_AI_SUMMARY: `${API_BASE_URL}${API_ENDPOINTS.UPDATE_AI_SUMMARY}`,
    SCRAPER_JOB_DETAIL: `${SCRAPER_BASE_URL}${SCRAPER_ENDPOINTS.JOB_DETAIL}`,
};
