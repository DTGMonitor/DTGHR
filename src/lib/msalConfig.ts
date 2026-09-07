import { PublicClientApplication, type Configuration } from "@azure/msal-browser";

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID?.trim() ?? "";
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID?.trim() ?? "";

/**
 * Whether Microsoft Entra ID sign-in is available in this build.
 *
 * Vite inlines env vars at *build* time, so this is decided when the frontend
 * is built, not at runtime — setting the variables in Vercel after a deploy
 * requires a redeploy to take effect.
 *
 * When SSO is not configured the app still works: admins sign in with email and
 * password, and the "Sign in with Microsoft" button is hidden.
 */
export const isAzureSsoConfigured = Boolean(clientId && tenantId);

// MSAL throws from its constructor when clientId is empty, which would take the
// whole app down at import time — before React can render an error. Feeding it
// a syntactically valid placeholder keeps the module importable; every code
// path that would actually reach Microsoft is gated on isAzureSsoConfigured.
const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000000";

const msalConfig: Configuration = {
    auth: {
        clientId: isAzureSsoConfigured ? clientId : PLACEHOLDER_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${tenantId || "common"}`,
        // Must exactly match a redirect URI registered on the Entra app.
        // Using the current origin means every Vercel deployment URL that
        // should support SSO has to be registered there.
        redirectUri: window.location.origin,
    },
    cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
    },
};

export const msalInstance = new PublicClientApplication(msalConfig);

/**
 * Resolves once MSAL has processed any redirect response.
 * Must be awaited before the app renders, otherwise the app can paint before
 * MSAL knows the user is authenticated.
 */
export const msalReady: Promise<void> = isAzureSsoConfigured
    ? msalInstance
          .initialize()
          .then(() => msalInstance.handleRedirectPromise())
          .then((response) => {
              if (response?.account) {
                  msalInstance.setActiveAccount(response.account);
              }
          })
          .catch((err) => {
              // A failed redirect must not block rendering — email/password
              // login remains available.
              console.error("[MSAL] initialisation failed:", err);
          })
    : Promise.resolve();

/**
 * Scopes requested when acquiring a token.
 * openid + profile + email yields an ID token carrying the user claims the
 * backend needs, without configuring "Expose an API" in the Azure Portal.
 */
export const loginRequest = {
    scopes: ["openid", "profile", "email"],
};
