import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "url";

export default defineConfig(({ mode }) => {
    // Vite only exposes .env values on `import.meta.env` inside application
    // code — this config file runs in plain Node, where `process.env` holds
    // nothing but the real OS environment. Reading the target off `process.env`
    // therefore always missed a VITE_BACKEND_URL set in .env.local and silently
    // fell through to localhost:8000, so every proxied request died with
    // ECONNREFUSED. `loadEnv` reads the .env files explicitly.
    //
    // The third argument is the prefix filter: "" loads unprefixed vars too,
    // which is what lets BACKEND_URL work as an alias.
    const env = loadEnv(mode, process.cwd(), "");
    const backendTarget = env.VITE_BACKEND_URL || env.BACKEND_URL || "http://localhost:8000";

    return {
        plugins: [react()],
        resolve: {
            alias: {
                "@": fileURLToPath(new URL("./src", import.meta.url)),
            },
        },
        server: {
            port: 5173,
            // Proxies the relative /api base URL to the backend so dev requests
            // stay same-origin. Pointing VITE_BACKEND_URL at the deployed
            // backend lets the UI be worked on locally without a database, and
            // without adding localhost to the backend's CORS_ORIGINS — the
            // proxy hop happens server-side, so the browser never sees a
            // cross-origin request.
            proxy: {
                "/api": {
                    target: backendTarget,
                    changeOrigin: true,
                },
            },
        },
    };
});
