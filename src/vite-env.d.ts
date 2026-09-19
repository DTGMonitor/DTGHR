/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Supabase project URL, e.g. https://xxxx.supabase.co */
    readonly VITE_SUPABASE_URL: string;

    /**
     * Supabase anon (publishable) key. Safe to ship in the bundle: it grants
     * nothing on its own, because every table is behind row-level security.
     * The service_role key must never appear here.
     */
    readonly VITE_SUPABASE_ANON_KEY: string;

    /**
     * "true" to show the Microsoft sign-in button. The Azure provider itself
     * is configured in the Supabase dashboard, not in this bundle.
     */
    readonly VITE_AZURE_SSO_ENABLED?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
