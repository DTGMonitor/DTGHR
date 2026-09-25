/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * Base URL for the backend API. Optional — defaults to the relative path
     * "/api/v1", which is proxied to the backend by Vite in development and by
     * a vercel.json rewrite in production.
     */
    readonly VITE_API_BASE_URL?: string;

    /** Microsoft Entra ID application (client) ID. Omit to disable SSO. */
    readonly VITE_AZURE_CLIENT_ID?: string;

    /** Microsoft Entra ID directory (tenant) ID. Omit to disable SSO. */
    readonly VITE_AZURE_TENANT_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
