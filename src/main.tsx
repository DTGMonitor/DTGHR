import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { msalReady } from "@/lib/msalConfig";

// Wait for MSAL to process any redirect response before rendering the app.
// Without this, the app may render before MSAL knows the user is authenticated.
msalReady.then(() => {
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
});
