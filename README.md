# DTG HR Hub — Frontend

FE repository for custom HR management platform with smart integration. Single unified portal for employees, combining custom-built core features with selective third-party integrations. Built for scalability, designed for simplicity.

## Tech Stack

- **Framework:** React 18 + TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **HTTP Client:** Axios (with JWT interceptor)
- **Routing:** React Router v6
- **Containerisation:** Docker & Docker Compose

## Quick Start

### Prerequisites

Ensure the **shared Docker network** exists (created once, shared with the BE):
```bash
docker network create dtg-network
```

The BE must be running before starting the FE. See [DTG-HR-HUB-BE](../DTG-HR-HUB-BE/README.md).

### Running with Docker

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:5173**

> API calls are automatically proxied through Vite to the BE container (`dtg-be-app:8000`) over the shared `dtg-network`. No CORS configuration needed.

### Running Locally (without Docker)

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env
# Edit .env and set: VITE_API_BASE_URL=http://localhost:8000/api/v1

# 3. Start dev server
npm run dev
```

> When running locally, Vite's proxy forwards `/api` to `http://localhost:8000` by default.

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

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | API base URL for local dev (not used in Docker) |
| `VITE_AZURE_CLIENT_ID` | Application (client) ID from the Azure portal |
| `VITE_AZURE_TENANT_ID` | Directory (tenant) ID from the Azure portal |

> In Docker, API routing is handled entirely by Vite's server-side proxy — `VITE_API_BASE_URL` is not needed.
