# DTG HR Hub — Frontend

FE repository for custom HR management platform with smart integration. Single unified portal for employees, combining custom-built core features with selective third-party integrations. Built for scalability, designed for simplicity.

## Tech Stack

- **Framework:** React 18 + TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **Backend:** Supabase — PostgREST behind row-level security, plus Postgres
  functions for anything with business logic behind it
- **Client:** `@supabase/supabase-js`
- **Routing:** React Router v6
- **Auth:** Supabase Auth — email/password, with Microsoft Entra ID available
  as a provider
- **Hosting:** Vercel (static build)

There is no server of our own. The migrations that define the backend live in
[`supabase/`](supabase/README.md); start with the runbook there.

## Quick Start

### Prerequisites

Node 18+ and a Supabase project with the migrations in [`supabase/`](supabase/README.md)
applied.

### Running locally

```bash
npm install
cp .env.example .env.local   # then fill in the two VITE_SUPABASE_* values
npm run dev
```

The app is served at **http://localhost:5173** and talks to Supabase directly —
the same path as production, so there is no dev proxy to keep in sync.

## Deployment

Deployed to Vercel as a static Vite build. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` in the project's environment variables; Vite inlines
them at build time, so a change needs a redeploy.

The anon key is safe in the bundle — it grants nothing on its own, because
every table is behind row-level security. The **service_role** key must never
appear here.

## Authentication Flow

There are two authentication paths:

### 1. Microsoft Entra ID (Employees)
Available through Supabase's Azure provider, and off until it is configured —
see step 4 of the [runbook](supabase/README.md).
1. User clicks **Sign in with Microsoft** on the login page.
2. Supabase redirects to the Entra login and handles the callback itself; the
   app receives a Supabase session like any other.
3. On first sign-in a trigger creates their profile and links the roster row
   whose email matches, so their own row becomes proposable without HR pairing
   it up by hand.
4. **Logout Flow:** logging out clears the HR Hub session only. Users are not
   signed out of their Entra/Microsoft account.

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

Vite inlines them at **build** time, so changing one in Vercel requires a
redeploy before it takes effect.

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | yes | Supabase project URL, e.g. `https://xxxx.supabase.co`. |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon (publishable) key. |
| `VITE_AZURE_SSO_ENABLED` | no | `"true"` shows the Microsoft sign-in button. The provider itself is configured in the Supabase dashboard, not here. |

> The app throws at startup if either required variable is missing, rather than
> failing on the first query with something less obvious.

> Entra SSO is optional. With `VITE_AZURE_SSO_ENABLED` unset, the app hides the
> "Sign in with Microsoft" button and email/password login continues to work.
