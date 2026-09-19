# Microsoft Entra SSO — setup from scratch

The application code is already done: the sign-in button, the provider call and
the trigger that provisions a profile and links the roster row all shipped with
the Supabase migration. Nothing here needs a code change. What follows is
configuration in two dashboards, one environment variable, and two data
cleanups afterwards.

Budget about 30 minutes, most of it waiting for a Vercel redeploy.

**Values you will need, specific to this project:**

| Thing | Value |
| --- | --- |
| Supabase project ref | `mapacifoqcybetzglhow` |
| Supabase callback URL | `https://mapacifoqcybetzglhow.supabase.co/auth/v1/callback` |
| Production frontend | `https://dtghr-fe.vercel.app` |
| Dev frontend | `http://localhost:5173` |

You need someone who can register an application in Entra. In a default
tenant any user can, but many organisations restrict it — if "New registration"
is greyed out, that is why.

---

## Part 1 — Register the application in Entra

Go to [entra.microsoft.com](https://entra.microsoft.com) → **Identity** →
**Applications** → **App registrations** → **New registration**. (The same
screens live in the Azure Portal under Microsoft Entra ID; Microsoft moves this
UI around, so go by the names rather than the exact path.)

1. **Name:** `DTG HR Hub`

2. **Supported account types:** *Accounts in this organizational directory only
   (Single tenant)*. This is an internal tool; single tenant means only
   dtgeotech.com accounts can ever use it, which is what you want.

3. **Redirect URI:** choose **Web** from the dropdown, and enter:

   ```
   https://mapacifoqcybetzglhow.supabase.co/auth/v1/callback
   ```

   > **Pick Web, not Single-page application.** The old MSAL setup used SPA,
   > and it is the obvious choice by habit. Supabase does the authorization
   > code exchange server-side with a client secret, and Entra refuses to
   > accept a secret from an app registered as an SPA. Getting this wrong
   > produces `AADSTS7000218` at the last step of the login, long after you
   > have forgotten which dropdown you touched.

4. **Register.**

5. From the **Overview** page, copy these two and keep them somewhere for the
   next part:
   - **Application (client) ID**
   - **Directory (tenant) ID**

### Create a client secret

**Certificates & secrets** → **Client secrets** → **New client secret**.

- Description: `Supabase auth`
- Expires: 24 months is the maximum. **Put the expiry date in a calendar now.**
  When this secret expires, SSO stops working for everybody at once — see
  [Keeping a way back in](#keeping-a-way-back-in) below.

Copy the **Value** column immediately. Not the Secret ID — the Value. It is
shown once and is unrecoverable afterwards; you would have to create another.

### Check the permissions

**API permissions** should list Microsoft Graph → **User.Read** (delegated),
which is added by default. Add `openid`, `profile` and `email` if they are not
already there. If your tenant requires admin consent, click **Grant admin
consent for …** — the button says whether it is needed.

### If your accounts have no mail attribute

Supabase identifies people by email address. If a user's Entra account has no
`mail` attribute set, the login fails with *"Error getting user email from
external provider"*.

Accounts with an Exchange mailbox always have one, so this is unlikely here.
If you hit it: **Token configuration** → **Add optional claim** → *ID* →
`email`, which falls back to the UPN.

---

## Part 2 — Configure the provider in Supabase

Supabase dashboard → **Authentication** → **Sign In / Providers** → **Azure**.

1. Toggle it **on**.
2. **Application (client) ID** — from Part 1.
3. **Secret Value** — the client secret Value from Part 1.
4. **Azure Tenant URL** — this one is easy to leave blank, and you must not:

   ```
   https://login.microsoftonline.com/<your-directory-tenant-id>
   ```

   Blank means Microsoft's `common` endpoint, which accepts any tenant. Since
   you registered as single-tenant, the two disagree and the login fails at the
   issuer check.

5. **Save**, then confirm the callback URL shown on that page matches what you
   registered in Entra, character for character.

### Before you test: check account linking

Still in **Authentication**, find **"Allow multiple accounts with the same
email address"** and make sure it is **off** (the default).

This matters more than it sounds. Your ten existing accounts already live in
`auth.users` with a password identity. With this setting off, signing in with
Microsoft **adds an Entra identity to the existing account**, keeping the same
user id — so `employees.user_id`, `is_superuser` and every audit-log reference
keep pointing at the right person.

With it on, you get a *second* account for the same human. The new one gets a
fresh uuid, the trigger builds it a profile, and that profile has
`is_superuser = false` and no employee row — because the employee is still
linked to the original id. You would then have HR admins who cannot see the
Employees page and roster rows nobody can propose against.

---

## Part 3 — Allow the redirect back

**Authentication** → **URL Configuration**.

- **Site URL:** `https://dtghr-fe.vercel.app`
- **Redirect URLs** — add both:
  ```
  https://dtghr-fe.vercel.app/**
  http://localhost:5173/**
  ```

The app asks to come back to `window.location.origin`. Anything not on this
list is ignored and you land on the Site URL instead — so without the localhost
entry, signing in from your dev server silently drops you on production.

If you want SSO on Vercel preview deployments too, add `https://*.vercel.app/**`.
That is broad; skip it unless you actually need it.

---

## Part 4 — Turn the button on

The sign-in button is hidden behind a build-time flag, so nobody sees a broken
button while the above is half-configured.

**Locally** — in `.env.local`:

```
VITE_AZURE_SSO_ENABLED=true
```

Restart `npm run dev`. Vite only reads this at startup.

**On Vercel** — Settings → Environment Variables, add `VITE_AZURE_SSO_ENABLED`
= `true` for Production, then **redeploy**. Vite inlines it at build time, so
an existing deployment will not pick it up.

---

## Part 5 — Test with one account

Test on `localhost:5173` first. A mistake there costs you a page refresh; the
same mistake in production locks out ten people.

1. Open `http://localhost:5173`, sign out if you are signed in.
2. **Sign in with Microsoft** → pick your dtgeotech.com account.
3. You should come back signed in.

Then check what actually happened in the database:

```sql
-- Each person should have ONE user id with TWO identities: email and azure.
select u.email, u.id, i.provider, i.created_at
from auth.users u
join auth.identities i on i.user_id = u.id
order by u.email, i.provider;

-- Nobody should have a profile without an employee row (except HR Admin,
-- which deliberately has no roster row of its own).
select u.email, u.is_superuser, e.employee_id
from public.users u
left join public.employees e on e.user_id = u.id
order by u.email;
```

**If the person who just signed in has two rows in `auth.users`,** linking did
not happen. Stop before anyone else signs in — the duplicate has to be removed
and the setting from Part 2 corrected, and untangling ten of them is far worse
than untangling one.

---

## Part 6 — Two cleanups afterwards

### Clear the forced password change

All ten accounts still carry `password_change_required = true`, left over from
the temporary passwords `create_accounts.py` handed out. An SSO user has no
password to change, so that flag sends them to the **Set Your Password** screen
on every sign-in for no reason.

```sql
update public.users set password_change_required = false;
```

Run this once everyone is on SSO. If some people will keep signing in with a
password and have not yet changed theirs, scope it with a `where` clause.

### Keeping a way back in

You may be tempted to drop the passwords entirely now:

```sql
-- Think about this before running it.
update auth.users set encrypted_password = null
 where email <> 'admin@dtgeotech.com';
```

**Keep at least one password account.** The client secret from Part 1 expires,
and when it does, SSO stops working for everybody simultaneously — including
whoever would need to sign in to fix it. `admin@dtgeotech.com` with a known
password is the way back in.

If you run that statement, change the admin password first: `Admin@123` is in
`DTG-HR-HUB-BE/.env` and in this repository's history, so it is not a secret.
Change it from the Set Your Password screen, or from Supabase →
Authentication → Users.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `AADSTS7000218` — client_assertion or client_secret required | The app is registered as **Single-page application**. It has to be **Web**. Add a Web platform in Entra → Authentication and move the redirect URI to it. |
| `AADSTS50011` — redirect URI mismatch | The URI in Entra does not exactly match `https://mapacifoqcybetzglhow.supabase.co/auth/v1/callback`. Check for a trailing slash. |
| `Unsupported provider: provider is not enabled` | The Azure provider was not saved, or the frontend is pointed at a different Supabase project. |
| Sign-in works but lands on production while testing locally | `http://localhost:5173/**` is missing from the Redirect URLs in Part 3. |
| *Error getting user email from external provider* | The account has no `mail` attribute. See the optional-claim note in Part 1. |
| `AADSTS700016` — application not found in directory | Wrong tenant id in the Azure Tenant URL, or the app was registered in a different tenant. |
| The button does not appear at all | `VITE_AZURE_SSO_ENABLED` is not `true` in that build. It is inlined at build time — a redeploy is required, not just an environment variable change. |
| Signed in, but the Employees page is empty and you used to be admin | Linking created a duplicate account. See the end of Part 5. |

---

## What happens on first SSO sign-in

For reference, the moving parts once a new person signs in through Entra:

1. Supabase creates the row in `auth.users` (or adds an `azure` identity to the
   existing one, if the email matches a confirmed account).
2. The `on_auth_user_created` trigger — from migration
   `20260916000100_supabase_auth_migration.sql` — inserts a `public.users`
   profile, taking `full_name` from the Entra claims.
3. The same trigger links the employee record whose email matches and has no
   `user_id` yet, so their roster row becomes proposable without HR pairing
   them up by hand.
4. `bootstrap_session()` re-runs that link on every sign-in, which covers the
   case where HR adds the employee record after the login already exists.

New joiners therefore need no account creation step at all — an Entra account
plus an employee row with a matching email is enough. `is_superuser` is still
set by hand:

```sql
update public.users set is_superuser = true where email = '...';
```
