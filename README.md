# DTG HR Hub — Frontend

FE repository for custom HR management platform with smart integration. Single unified portal for employees, combining custom-built core features with selective third-party integrations. Built for scalability, designed for simplicity.

## Tech Stack

- **Framework:** React 18 + TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **HTTP Client:** Axios (with JWT interceptor)
- **Routing:** React Router v6
- **Auth:** MSAL (Microsoft Entra ID, optional) + email/password
- **Hosting:** Vercel (static build)

## Quick Start

### Prerequisites

Node 18+ and a running backend. See [DTG-HR-HUB-BE](https://github.com/dtg-focus/DTG-HR-HUB-BE).

### Running locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

The app is served at **http://localhost:5173**.

Vite proxies `/api` to the backend (`VITE_BACKEND_URL`, default
`http://localhost:8000`), so requests stay same-origin and no CORS setup is
needed in development.

## Deployment

Deployed to Vercel as a static Vite build. The full guide — including how to
point the frontend at the backend deployment — lives in the backend repo:
**[DEPLOYMENT.md](https://github.com/dtg-focus/DTG-HR-HUB-BE/blob/main/DEPLOYMENT.md)**.

There are two ways to reach the API in production:

- **Absolute URL** — set `VITE_API_BASE_URL` to
  `https://<backend>.vercel.app/api/v1`, and add this app's origin to the
  backend's `CORS_ORIGINS`.
- **Same-origin rewrite** — leave `VITE_API_BASE_URL` unset and add an `/api`
  rewrite to `vercel.json` above the SPA fallback. Vercel proxies server-side,
  so there is no CORS at all.

## Authentication Flow

There are two authentication paths:

### 1. Microsoft Entra ID (Employees)
Most users log in via Single Sign-On (SSO) using their Microsoft organizational accounts.
1. User clicks **Sign in with Microsoft** on the login page.
2. MSAL redirects to the Azure Active Directory login.
3. Upon successful callback, the frontend acquires an ID token and logs the user into the HR Hub dashboard.
4. **Logout Flow:** When an employee logs out from HR Hub, only the local session is cleared. They are not forced to completely sign out of their Entra/Microsoft account.

### 2. Email & Password (HR/Admins)
There is **no public registration**. Only HR (superusers) can create employee accounts or use email/password auth directly.

1. HR logs in (or uses the default superuser) → navigates to **Employees** page
2. Clicks **"+ Add Employee"** → employee is created with an auto-generated ID (`DTG-001`, `DTG-002`, …)
3. Clicks the **person+ icon** on an employee row → a login account is created with a temporary password
4. HR shares the temp password → employee logs in with email
5. Employee is redirected to the **Set Password** page on first login
6. After setting their password, the employee has full access

## Project Structure

```
src/
├── components/
│   ├── layout/              # Sidebar, header, Layout wrapper
│   ├── employees/
│   │   ├── EmployeeFormModal.tsx   # Add/edit employee drawer
│   │   ├── DeleteConfirmModal.tsx  # Deactivation confirmation
│   │   └── CreateAccountModal.tsx  # Temp password display modal
│   └── ProtectedRoute.tsx          # Auth guard + password-change redirect
├── contexts/
│   └── AuthContext.tsx       # Auth state, login, logout, changePassword
├── lib/
│   └── api.ts               # Axios instance with JWT interceptor
├── pages/
│   ├── LoginPage.tsx         # Login form (no registration link)
│   ├── SetPasswordPage.tsx   # First-login password setup
│   ├── DashboardPage.tsx     # Dashboard overview
│   ├── EmployeesPage.tsx     # Employee CRUD + account creation
│   ├── LeavesPage.tsx        # Leave management
│   └── SchedulesPage.tsx     # Shift roster management + grid editor
├── services/
│   ├── employeeService.ts    # Employee API + createAccount
│   ├── leaveService.ts       # Leaves API
│   └── scheduleService.ts    # Schedules + Shift Assignments API
├── types/
│   ├── auth.ts               # UserResponse
│   ├── employee.ts           # Employee interface
│   ├── leave.ts              # Leave types
│   └── schedule.ts           # Schedule & Shift enums/types
├── App.tsx                   # Router & layout
└── main.tsx                  # App entrypoint
```

## Key Features

| Feature | Description |
|---------|-------------|
| **HR-controlled registration** | No public signup — only superusers create accounts |
| **First-login password change** | Employees must set their own password on first login |
| **Auto-generated employee IDs** | IDs follow `DTG-NNN` format, assigned server-side |
| **Leave management** | Employees: submit, view, cancel own requests. Admin: see aggregate stats |
| **Leave approval** | Admin/HR can approve or reject any leave request |
| **Roster Management (Schedules)** | Excel-like grid with paint-mode toolbar for fast shift assignment. Approved leaves overlaid as read-only cells. Auto-save on publish. |
| **Paginated Activity Log** | Dashboard shows paginated recent activity with Previous/Next navigation |
| **Role-based UI** | Admin sees summary cards + pending approvals; employees see personal balances + own requests. Only admin can add employees |

## Environment Variables

All are optional. Vite inlines them at **build** time, so changing one in Vercel
requires a redeploy before it takes effect.

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | Absolute API base URL. Defaults to `/api/v1`, which is proxied by Vite in dev and by a `vercel.json` rewrite in production. |
| `VITE_BACKEND_URL` | Dev-server proxy target. Only used by `npm run dev`. Defaults to `http://localhost:8000`. |
| `VITE_AZURE_CLIENT_ID` | Application (client) ID from the Azure portal. |
| `VITE_AZURE_TENANT_ID` | Directory (tenant) ID from the Azure portal. |

> Entra SSO is optional. With `VITE_AZURE_CLIENT_ID` and `VITE_AZURE_TENANT_ID`
> unset, the app hides the "Sign in with Microsoft" button and email/password
> login continues to work.
