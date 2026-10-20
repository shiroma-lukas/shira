import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import type { SqlClient } from "./migrate.js";

/** A SqlClient that can also run a function inside one transaction. */
export interface Db extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

function wrap(conn: Pool | PoolClient): SqlClient {
  return {
    exec: (sql) => conn.query(sql),
    query: async <T>(sql: string, params?: unknown[]) => (await conn.query(sql, params)) as unknown as { rows: T[] },
  };
}

/** Production: node-postgres pool. Each transaction holds one pooled connection. */
export function fromPool(pool: Pool): Db {
  return {
    ...wrap(pool),
    async transaction(fn) {
      const conn = await pool.connect();
      const tx = wrap(conn);
      try {
        await conn.query("BEGIN");
        const result = await fn(tx);
        await conn.query("COMMIT");
        return result;
      } catch (err) {
        await conn.query("ROLLBACK");
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}

/** Tests: in-process Postgres. */
export function fromPGlite(pg: PGlite): Db {
  return {
    exec: (sql) => pg.exec(sql),
    query: (sql, params) => pg.query(sql, params),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ exec: (sql) => tx.exec(sql), query: (sql, params) => tx.query(sql, params) })),
  };
}
