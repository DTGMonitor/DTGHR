// Compare the schema the migrations build with a JSON description of another
// schema (the FastAPI models, exported by the backend). Porting aid, not a test:
//
//   node supabase/test/schema-diff.mjs path/to/other_schema.json
//
// Prints tables missing here, columns missing here, and nullability that differs.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const other = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
const db = new PGlite({ extensions: { pgcrypto } });
await db.waitReady;
await db.exec(readFileSync(join(import.meta.dirname, "00_baseline.sql"), "utf8"));
const dir = join(import.meta.dirname, "..", "migrations");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
}
const r = await db.query(`
    select table_name, column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public'
       and table_name in (select table_name from information_schema.tables
                           where table_schema = 'public' and table_type = 'BASE TABLE')`);
const here = {};
for (const row of r.rows) {
    (here[row.table_name] ??= {})[row.column_name] = row;
}

const missingTables = Object.keys(other).filter((t) => !here[t]).sort();
console.log(`tables missing here (${missingTables.length}):`, missingTables.join(", ") || "none");
for (const [t, cols] of Object.entries(other).sort()) {
    if (!here[t]) continue;
    const missing = Object.keys(cols).filter((c) => !here[t][c]);
    const nulls = Object.entries(cols)
        .filter(([c, spec]) => here[t][c] && (here[t][c].is_nullable === "YES") !== spec.nullable)
        .map(([c, spec]) => `${c} (here ${here[t][c].is_nullable === "YES" ? "null" : "not null"}, other ${spec.nullable ? "null" : "not null"})`);
    const extra = Object.keys(here[t]).filter((c) => !cols[c]);
    if (missing.length || nulls.length || extra.length) {
        console.log(`\n${t}`);
        if (missing.length) console.log(`  missing: ${missing.map((c) => `${c} ${cols[c].type}${cols[c].nullable ? "" : " not null"}`).join(", ")}`);
        if (nulls.length) console.log(`  nullability: ${nulls.join(", ")}`);
        if (extra.length) console.log(`  only here: ${extra.join(", ")}`);
    }
}
