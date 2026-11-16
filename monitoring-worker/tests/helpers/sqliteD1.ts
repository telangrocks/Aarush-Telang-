import fs from 'node:fs';
import path from 'node:path';

const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');

export class SqliteD1PreparedStatement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly rawDb: any,
    private readonly query: string,
    private readonly onBeforeWrite: (sql: string) => void
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
    return this;
  }

  private execQuery(): { rows: Record<string, unknown>[]; changes: number } {
    this.onBeforeWrite(this.query);
    const trimmed = this.query.trim().toUpperCase();
    const stmt = this.rawDb.prepare(this.query);
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
      const rows = stmt.all(...this.values) as Record<string, unknown>[];
      return { rows, changes: 0 };
    }
    const info = stmt.run(...this.values) as { changes?: number | bigint };
    return { rows: [], changes: Number(info?.changes ?? 0) };
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { rows } = this.execQuery();
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return row as unknown as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { rows, changes } = this.execQuery();
    return {
      success: true,
      results: rows as unknown as T[],
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: changes,
        last_row_id: 0,
        changed_db: changes > 0,
        changes,
      },
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.run<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {
    const { rows } = this.execQuery();
    if (!rows.length) return options?.columnNames ? [[]] : [];
    const cols = Object.keys(rows[0]);
    const data = rows.map((r) => cols.map((c) => r[c])) as T[];
    return options?.columnNames ? [cols, ...data] : data;
  }

  public executeSync(): D1Result<any> {
    const { rows, changes } = this.execQuery();
    return {
      success: true,
      results: rows,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: changes,
        last_row_id: 0,
        changed_db: changes > 0,
        changes,
      },
    };
  }
}

export class SqliteD1Database implements D1Database {
  public readonly rawDb: any;
  public injectErrorOnMatch: { pattern: RegExp; error: Error; remaining?: number } | null = null;

  constructor(migrationSqlPath?: string) {
    this.rawDb = new DatabaseSync(':memory:');
    if (migrationSqlPath) {
      const schemaSql = fs.readFileSync(migrationSqlPath, 'utf8');
      this.rawDb.exec(schemaSql);
      return;
    }
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      this.rawDb.exec(sql);
    }
  }

  private checkFaultInjection(sql: string): void {
    if (!this.injectErrorOnMatch) return;
    if (this.injectErrorOnMatch.pattern.test(sql)) {
      if (this.injectErrorOnMatch.remaining !== undefined) {
        this.injectErrorOnMatch.remaining -= 1;
        const err = this.injectErrorOnMatch.error;
        if (this.injectErrorOnMatch.remaining <= 0) {
          this.injectErrorOnMatch = null;
        }
        throw err;
      }
      throw this.injectErrorOnMatch.error;
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.rawDb, query, (sql) => this.checkFaultInjection(sql));
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.rawDb.exec('BEGIN IMMEDIATE');
    try {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push((stmt as SqliteD1PreparedStatement).executeSync());
      }
      this.rawDb.exec('COMMIT');
      return results;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.checkFaultInjection(query);
    this.rawDb.exec(query);
    return { count: 1, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error('withSession not needed in test harness');
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}
