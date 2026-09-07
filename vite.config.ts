import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "url"

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url))
        },
    },
    server: {
        port: 5173,
        // Proxies the relative /api base URL to the backend so dev requests stay
        // same-origin, matching how production works behind a Vercel rewrite.
        proxy: {
            "/api": {
                target: process.env.VITE_BACKEND_URL ?? "http://localhost:8000",
                changeOrigin: true,
            },
        },
    },
});
