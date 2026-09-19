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
        // No dev proxy: the app calls Supabase directly, in development
        // exactly as in production.
    },
});
