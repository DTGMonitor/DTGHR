import axios from "axios";

const TOKEN_KEY = "hr_hub_token";

/**
 * Where the API lives.
 *
 * Defaults to a *relative* path, which keeps requests same-origin in both
 * supported deployments:
 *
 * - **Local dev** — Vite proxies /api to the backend (see vite.config.ts).
 * - **Vercel** — a rewrite in vercel.json forwards /api to the backend
 *   deployment. The browser only ever sees this origin, so no CORS preflight
 *   happens and the bearer token is never sent cross-origin.
 *
 * Set VITE_API_BASE_URL to an absolute URL (e.g. https://api.example.com/api/v1)
 * to call the backend directly instead. That origin must then be listed in the
 * backend's CORS_ORIGINS.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        "Content-Type": "application/json",
    },
});

// ---------------------------------------------------------------------------
// Request interceptor — attach JWT
// ---------------------------------------------------------------------------
api.interceptors.request.use((config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// ---------------------------------------------------------------------------
// Response interceptor — handle 401
// ---------------------------------------------------------------------------
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            // Only redirect if not already on login page
            if (window.location.pathname !== "/login") {
                window.location.href = "/login";
            }
        }
        return Promise.reject(error);
    }
);

export { TOKEN_KEY };
export default api;
