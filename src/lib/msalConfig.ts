import { PublicClientApplication, type Configuration } from "@azure/msal-browser";

const msalConfig: Configuration = {
    auth: {
        clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID}`,
        redirectUri: window.location.origin,
    },
    cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
    },
};

export const msalInstance = new PublicClientApplication(msalConfig);

// Initialize MSAL — must be awaited before the app renders
export const msalReady = msalInstance.initialize().then(() => {
    console.log("[MSAL] initialized, now handling redirect promise...");
    return msalInstance.handleRedirectPromise().then((response) => {
        console.log("[MSAL] handleRedirectPromise result:", response ? `account=${response.account?.username}` : "null (no redirect)");
        if (response?.account) {
            msalInstance.setActiveAccount(response.account);
        }
        console.log("[MSAL] allAccounts after redirect:", msalInstance.getAllAccounts().map(a => a.username));
    });
});

/**
 * Scopes requested when acquiring a token.
 * Using openid + profile so we get an ID token with user info claims
 * (email, name, etc.) without needing to configure "Expose an API"
 * in the Azure Portal.
 */
export const loginRequest = {
    scopes: ["openid", "profile", "email"],
};
