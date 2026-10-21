import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { SqlClient } from "./migrate.js";

/** Group role created by migration 0005 with the dispatcher's table privileges. */
export const APP_ROLE = "shira_app";

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form Postgres stores. Sending it
 * instead of the password keeps the plain text out of the server and its statement logs.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Creates a login user in the app role, or resets its password and membership if it
 * exists. Run it as the admin user that ran the migrations.
 */
export async function ensureAppUser(db: SqlClient, name: string, password: string): Promise<"created" | "updated"> {
  if (!ROLE_NAME.test(name)) throw new Error(`invalid user name ${name}: use lowercase letters, digits, and _`);
  if (name === APP_ROLE) throw new Error(`${APP_ROLE} is the group role; pick another name for the login user`);
  if (password.length < 16) throw new Error("use a password of at least 16 characters");
  const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rows.length > 0;
  // Identifiers and literals can't be bound as parameters in DDL; the name is validated
  // above and the verifier's alphabet (base64, digits, $ : -) holds no quote.
  const verifier = scramVerifier(password);
  if (exists) {
    // Only LOGIN and PASSWORD: naming any other attribute, even NOSUPERUSER, needs a real
    // superuser, which a managed database's admin (RDS master) is not. A user that gained
    // other rights shows up in `excessPrivileges` at dispatch.
    await db.exec(`ALTER ROLE ${name} WITH LOGIN PASSWORD '${verifier}'`);
    await db.exec(`GRANT ${APP_ROLE} TO ${name}`);
    return "updated";
  }
  await db.exec(`CREATE ROLE ${name} WITH LOGIN PASSWORD '${verifier}' IN ROLE ${APP_ROLE}`);
  return "created";
}

/**
 * Why the current connection has more rights than the dispatcher needs, or null when it
 * runs as a plain member of the app role.
 */
export async function excessPrivileges(db: SqlClient): Promise<string | null> {
  const { rows } = await db.query<{ user: string; superuser: boolean; owner: boolean; member: boolean }>(
    `SELECT current_user AS user,
            r.rolsuper AS superuser,
            pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = 'tasks' AND schemaname = 'public'), 'USAGE') AS owner,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND pg_has_role(current_user, $1, 'USAGE') AS member
     FROM pg_roles r WHERE r.rolname = current_user`,
    [APP_ROLE],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.superuser) return `connected as superuser ${r.user}`;
  if (r.owner) return `connected as ${r.user}, which owns the schema`;
  if (!r.member) return `connected as ${r.user}, which is not in ${APP_ROLE}`;
  return null;
}
