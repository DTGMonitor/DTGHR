import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { employeeService } from "@/services/employeeService";
import { useAuth } from "@/contexts/AuthContext";
import {
    EMPLOYMENT_TYPE_LABELS,
    WORK_PATTERN_LABELS,
    type EmployeeDetail,
} from "@/types/employee";
import ProfileSection, { type FieldDef } from "@/components/employees/ProfileSection";
import PhotoField from "@/components/employees/PhotoField";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import RoleHistory from "@/components/employees/RoleHistory";
import ProfileRequests from "@/components/employees/ProfileRequests";
import Alert from "@/components/ui/Alert";

type TabKey = "personal" | "employment" | "statutory";

/*
 * Scorecards deliberately do not appear here.
 *
 * They live in the Performance section, which is the one place to look for
 * them: split across both, "where is Lintang's Q3 scorecard" had two answers
 * and the profile tab only ever showed one person at a time.
 */
const TABS: { key: TabKey; label: string; adminOnly?: boolean }[] = [
    { key: "personal", label: "Personal" },
    { key: "employment", label: "Employment" },
    { key: "statutory", label: "Statutory & payroll" },
];

const GENDERS = [
    { value: "male", label: "Male" },
    { value: "female", label: "Female" },
];

/*
 * PTKP — the code that sets somebody's tax-free allowance.
 *
 * TK is tidak kawin, K is kawin, K/I is married with the spouse's income
 * combined on one return. The digit is dependants, capped at three by the tax
 * office however many there are.
 *
 * Not derived from marital status: a married employee with two children is
 * K/2, and the same person filing jointly is K/I/2. Payroll needs the code
 * itself, because that is what appears on the PPh 21 calculation.
 */
const PTKP = [
    "TK/0", "TK/1", "TK/2", "TK/3",
    "K/0", "K/1", "K/2", "K/3",
    "K/I/0", "K/I/1", "K/I/2", "K/I/3",
].map((code) => ({ value: code, label: code }));

const MARITAL = [
    { value: "single", label: "Single" },
    { value: "married", label: "Married" },
    { value: "divorced", label: "Divorced" },
    { value: "widowed", label: "Widowed" },
];

export default function EmployeeProfilePage() {
    const { employeeId } = useParams<{ employeeId: string }>();
    const { user } = useAuth();
    /* Editing a record follows the People admin tick, not superuser: that is
       the permission the API enforces, and gating the page on something
       stricter hides a pencil from somebody the server would have allowed. */
    const isHR = Boolean(user?.can_manage_people);

    const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
    // The tab lives in the URL so a profile section can be linked to and
    // survives a refresh -- "have a look at his KPI" should be one link.
    const [searchParams, setSearchParams] = useSearchParams();
    const requested = searchParams.get("tab") as TabKey | null;
    const tab: TabKey = TABS.some((t) => t.key === requested) ? requested! : "personal";
    const setTab = (next: TabKey) =>
        setSearchParams(next === "personal" ? {} : { tab: next }, { replace: true });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!employeeId) return;
        setError(null);
        try {
            const res = await employeeService.get(employeeId);
            setEmployee(res.data);
        } catch {
            setError("Could not load this employee.");
        } finally {
            setLoading(false);
        }
    }, [employeeId]);

    useEffect(() => {
        load();
    }, [load]);

    const save = async (patch: Record<string, unknown>) => {
        if (!employeeId) return;
        await employeeService.update(employeeId, patch);
        await load();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2.5 py-24 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading profile…
            </div>
        );
    }

    if (error || !employee) {
        return (
            <div className="dtg-panel px-5 py-16 text-center">
                <Icon name="x" className="mx-auto h-8 w-8 text-danger" />
                <p className="mt-3 text-sm text-danger">{error ?? "Employee not found"}</p>
                <Link to="/employees" className="dtg-btn-secondary mt-4 inline-flex">
                    <Icon name="arrowLeft" className="h-4 w-4" />
                    Back to employees
                </Link>
            </div>
        );
    }

    /*
     * Peter and Mark are the founders, not staff.
     *
     * Nurhuda: they are the owners, so a work location, an active flag, an
     * employment type and a schedule say nothing about them — they do not
     * report anywhere, do not carry a roster and are not going to be
     * deactivated. And they are Australian, so the whole statutory and payroll
     * side (NIK, NPWP, BPJS, an Indonesian bank account) is not theirs to
     * fill in.
     *
     * The same test used everywhere else: management, and exempt from review.
     */
    /* Who is *looking*, as opposed to who is being looked at. */
    const viewerIsManagement = Boolean(
        user?.is_superuser ||
            user?.is_management ||
            user?.role === "director" ||
            user?.role === "executive",
    );

    const isFounder = Boolean(
        employee.is_management_role && employee.kpi_review_required === false,
    );

    /* A permanent contract has no end date to show. Fixed-term (PKWT) does,
       and Nurhuda wants that one kept to admin and management — an engineer
       does not need a countdown to their own contract running out. */
    const isPermanent = employee.employment_type === "permanent";

    const personalFields: FieldDef[] = [
        { key: "first_name", label: "First name" },
        { key: "last_name", label: "Last name" },
        { key: "email", label: "Work email", type: "email", mono: true },
        { key: "personal_email", label: "Personal email", type: "email", mono: true },
        { key: "phone", label: "Phone", type: "tel", mono: true },
        { key: "date_of_birth", label: "Date of birth", type: "date" },
        { key: "place_of_birth", label: "Place of birth" },
        { key: "gender", label: "Gender", type: "select", options: GENDERS },
        { key: "marital_status", label: "Marital status", type: "select", options: MARITAL },
        { key: "religion", label: "Religion" },
        {
            key: "ptkp_status",
            label: "PTKP status",
            type: "select",
            options: PTKP,
            help: "Tax status for PPh 21. K/1 is married with one dependant; K/I/… is married with the spouse's income combined.",
        },
        { key: "address", label: "Address", type: "textarea", wide: true },
    ];

    const emergencyFields: FieldDef[] = [
        { key: "emergency_contact_name", label: "Contact name" },
        { key: "emergency_contact_relationship", label: "Relationship" },
        { key: "emergency_contact_phone", label: "Phone", type: "tel", mono: true },
    ];

    const employmentFields: FieldDef[] = [
        {
            key: "employee_id",
            label: "Employee ID",
            mono: true,
            help: "Free text — set your own numbering. New records are generated as DTG-00n.",
        },
        { key: "position", label: "Position" },
        { key: "department", label: "Department" },
        { key: "job_level", label: "Level" },
        { key: "date_of_joining", label: "Hire date", type: "date" },
        {
            key: "employment_type",
            label: "Employment type",
            type: "select",
            options: Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({
                value,
                label,
            })),
        },
        {
            key: "contract_end_date",
            label: "Contract ends",
            type: "date",
            help: "Fixed-term (PKWT) contracts only.",
        },
        { key: "work_location", label: "Work location" },
        {
            key: "work_pattern",
            label: "Schedule",
            type: "select",
            options: Object.entries(WORK_PATTERN_LABELS).map(([value, label]) => ({
                value,
                label,
            })),
            help: "Determines which schedule this person sees.",
        },
        /*
            Back-up engineer, Management role, Bulletin author and the role
            scorecard used to sit here. They are permissions and configuration
            rather than employment facts, they are now set in Settings against
            everybody at once, and answering "who can publish the bulletin?"
            by opening eleven profiles in turn is what Settings exists to
            stop. The scorecard field also rendered its raw template id, so
            the profile was showing a database key as though it were data.
        */
        { key: "is_active", label: "Active", type: "toggle" },
    ];

    const statutoryFields: FieldDef[] = [
        { key: "national_id", label: "NIK (KTP)", mono: true },
        { key: "tax_id", label: "NPWP", mono: true },
        { key: "bpjs_health_no", label: "BPJS Kesehatan", mono: true },
        { key: "bpjs_employment_no", label: "BPJS Ketenagakerjaan", mono: true },
    ];

    const bankFields: FieldDef[] = [
        { key: "bank_name", label: "Bank" },
        { key: "bank_account_number", label: "Account number", mono: true },
        { key: "bank_account_holder", label: "Account holder" },
    ];

    /*
     * What a founder's employment card leaves out, and why.
     *
     * Everything here describes an employment relationship DTG does not have
     * with Peter or Mark. Rather than show the fields empty — which reads as
     * missing data somebody should go and fill in — they are absent.
     */
    const employmentShown = employmentFields.filter((f) => {
        if (
            isFounder &&
            [
                "work_location",
                "work_pattern",
                "employment_type",
                "is_active",
                // A founder was not hired. There is no start of employment to
                // record, because there was no employment to start.
                "date_of_joining",
            ].includes(f.key)
        ) {
            return false;
        }
        // A permanent contract has no end date; showing "Not set" invites
        // somebody to set one.
        if (f.key === "contract_end_date") {
            if (isPermanent || isFounder) return false;
            /* Nurhuda: the end date on a fixed-term contract stays with admin
               and management. An engineer opening their own profile does not
               need a countdown to their own contract running out — that is a
               conversation, not a field. */
            if (!viewerIsManagement) return false;
        }
        // The level ladder is for staff. "President Director, level: not set"
        // is a question with no answer rather than a gap.
        if (isFounder && f.key === "job_level") return false;
        return true;
    });

    /* Statutory identifiers and an Indonesian bank account, for two
       Australians who have neither. */
    const visibleTabs = TABS.filter((t) => !t.adminOnly || isHR).filter(
        (t) => !(isFounder && t.key === "statutory"),
    );

    return (
        <div className="dtg-fade-in space-y-5">
            {/* ── Back link ─────────────────────────────────────────────── */}
            <Link
                to="/employees"
                className="inline-flex items-center gap-1.5 text-micro font-semibold uppercase tracking-label text-teal-300 transition-colors hover:text-teal-100"
            >
                <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                Employees
            </Link>

            {/* ── Header ────────────────────────────────────────────────── */}
            <section className="dtg-panel flex flex-col gap-6 p-6 sm:flex-row sm:items-start">
                <PhotoField employee={employee} canEdit={isHR} onChanged={load} />

                <div className="min-w-0 flex-1">
                    <p className="dtg-eyebrow">{employee.position}</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        {employee.first_name} {employee.last_name}
                    </h1>
                    <p className="mt-1 font-mono text-xs text-muted">{employee.email}</p>

                    <div className="mt-3.5 flex flex-wrap gap-2">
                        <span className="dtg-chip border-teal-300/35 bg-teal-300/10 text-teal-300">
                            {employee.employee_id}
                        </span>
                        {/* A founder carries no schedule, so naming one is
                            noise; and neither of them is going to be marked
                            former staff. */}
                        {!isFounder && (
                            <span className="dtg-chip border-white/12 bg-white/[0.04] text-paper-soft">
                                {WORK_PATTERN_LABELS[employee.work_pattern]}
                            </span>
                        )}
                        {employee.is_backup_engineer && (
                            <span className="dtg-chip border-gold/35 bg-gold/10 text-gold">
                                Back-up engineer
                            </span>
                        )}
                        {isFounder ? null : employee.is_active ? (
                            <span className="dtg-chip border-signal/35 bg-signal/10 text-signal">
                                <span className="h-1.5 w-1.5 rounded-full bg-signal" />
                                Active
                            </span>
                        ) : (
                            <span className="dtg-chip border-danger/35 bg-danger/10 text-danger">
                                Former staff
                            </span>
                        )}
                        {/* "Has login" used to sit here. Nurhuda: it is not
                            information anybody needs, on somebody else's
                            profile or on their own — you know whether you can
                            sign in by having signed in. Creating a login is
                            still an action in the directory, where an action
                            belongs; it is just no longer announced as a fact
                            about a person. */}
                    </div>

                    {!employee.is_active && (
                        <Alert tone="warning" className="mt-4">
                            This record is deactivated. Only administrators can see it, and the
                            person no longer appears on any schedule.
                        </Alert>
                    )}
                </div>
            </section>

            {/* ── Tabs ──────────────────────────────────────────────────── */}
            <div role="tablist" className="flex flex-wrap gap-1 border-b border-white/10">
                {visibleTabs.map((t) => (
                    <button
                        key={t.key}
                        role="tab"
                        aria-selected={tab === t.key}
                        onClick={() => setTab(t.key)}
                        className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                            tab === t.key
                                ? "border-signal font-semibold text-paper"
                                : "border-transparent font-medium text-paper-soft hover:border-teal-500 hover:text-paper"
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ── Panels ────────────────────────────────────────────────── */}
            {tab === "personal" && (
                <div className="space-y-4">
                    <ProfileSection
                        eyebrow="Profile"
                        title="Personal details"
                        fields={personalFields}
                        employee={employee}
                        canEdit={isHR}
                        onSave={save}
                    />
                    <ProfileSection
                        eyebrow="In case of emergency"
                        title="Emergency contact"
                        fields={emergencyFields}
                        employee={employee}
                        canEdit={isHR}
                        onSave={save}
                    />
                </div>
            )}

            {tab === "employment" && (
                <div className="space-y-4">
                    <ProfileSection
                        eyebrow="Role"
                        title="Employment"
                        fields={employmentShown}
                        employee={employee}
                        canEdit={isHR}
                        onSave={save}
                    />
                    {/* Directly under the fields it records, so a promotion and
                        its history are read in the same glance.

                        Not for the founders: a career history is the record of
                        somebody moving through the company, and they own it.
                        There is no promotion for a founder to have had. */}
                    {!isFounder && <RoleHistory employeeId={employee.id} canEdit={isHR} />}
                </div>
            )}

            {/* Your own record, and you cannot edit it: the way to correct a
                bank account or a PTKP code is to ask. Shown on your own
                profile only — raising a request on somebody else's behalf is
                an administrator editing the record directly. */}
            {tab === "personal" && user?.employee_id === employee.id && (
                <div className="mt-4">
                    <ProfileRequests mine />
                </div>
            )}

            {tab === "statutory" && (
                <div className="space-y-4">
                    <ProfileSection
                        eyebrow="Indonesia"
                        title="Statutory identifiers"
                        fields={statutoryFields}
                        employee={employee}
                        canEdit={isHR}
                        onSave={save}
                    />
                    <ProfileSection
                        eyebrow="Payroll destination"
                        title="Bank account"
                        fields={bankFields}
                        employee={employee}
                        canEdit={isHR}
                        onSave={save}
                    >
                        <p className="mt-4 border-t border-white/[0.08] pt-3 text-micro leading-relaxed text-muted">
                            Salary and bonus figures are deliberately not held in HR Hub yet.
                        </p>
                    </ProfileSection>
                </div>
            )}

        </div>
    );
}
