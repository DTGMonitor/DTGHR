/*
 * Every area's routes, registered once at start-up. Each module calls
 * `route(...)` from `@/lib/api` for the paths its screens use; importing this
 * file is what puts them in the table. See supabase/PORTING.md.
 */
import "./people";
import "./leaves";
import "./schedules";
import "./kpi";
import "./payroll";
import "./salary";
import "./finance";
import "./tickets";
import "./contracts";
import "./articles";
import "./overview";
