import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";

/** D1 查询元数据的测试实现。 / Test implementation of D1 query metadata. */
export interface TestD1Meta {
  readonly changes: number;
  readonly last_row_id: number;
  readonly changed_db: boolean;
  readonly duration: number;
  readonly rows_read: number;
  readonly rows_written: number;
  readonly size_after: number;
}

/** D1 查询结果的测试实现。 / Test implementation of a D1 query result. */
export interface TestD1Result<Row = Record<string, unknown>> {
  readonly success: true;
  readonly results: Row[];
  readonly meta: TestD1Meta;
}

/** SQLite 可接受的已规范化 D1 绑定值。 / Normalized D1 binding accepted by SQLite. */
type BoundValue = null | number | bigint | string | Uint8Array;

/**
 * 基于 Node 内置 SQLite 的 D1 prepared statement 适配器。
 * D1 prepared-statement adapter backed by Node's built-in SQLite.
 *
 * 语句只保存 SQL 与不可变绑定值；执行始终发生在所属数据库上。
 * A statement stores only SQL and immutable bindings; execution always occurs
 * on its owning database.
 */
export class TestD1PreparedStatement {
  /** 语句所属数据库。 / Database owning this statement. */
  readonly #owner: TestD1Database;
  /** 单条 SQL 文本。 / Single SQL statement text. */
  readonly #sql: string;
  /** 不可变的位置绑定。 / Immutable positional bindings. */
  readonly #values: readonly BoundValue[];
  /** session 成功执行回调。 / Successful session-execution callback. */
  readonly #onExecute: (() => void) | undefined;

  /** 创建未绑定语句；测试通常应通过 `database.prepare()` 获取实例。 / Create an unbound statement; tests normally use `database.prepare()`. */
  public constructor(
    owner: TestD1Database,
    sql: string,
    values: readonly BoundValue[] = [],
    onExecute?: () => void,
  ) {
    this.#owner = owner;
    this.#sql = sql;
    this.#values = values;
    this.#onExecute = onExecute;
  }

  /** 返回绑定了 D1 兼容位置参数的新语句。 / Return a new statement with D1-compatible positional bindings. */
  public bind(...values: unknown[]): TestD1PreparedStatement {
    return new TestD1PreparedStatement(
      this.#owner,
      this.#sql,
      values.map(normalizeBinding),
      this.#onExecute,
    );
  }

  /** 返回第一行或指定列；无结果时返回 `null`。 / Return the first row or named column, or `null` when no row exists. */
  public async first<T = Record<string, unknown>>(
    column?: string,
  ): Promise<T | null> {
    const row = this.#owner.first(this.#sql, this.#values);
    this.#onExecute?.();
    if (row === null) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column))
      throw new Error(`Column not found: ${column}`);
    return row[column] as T;
  }

  /** 执行语句并返回全部行与 D1 风格元数据。 / Execute and return all rows plus D1-style metadata. */
  public async all<T = Record<string, unknown>>(): Promise<TestD1Result<T>> {
    const result = this.#owner.execute<T>(this.#sql, this.#values);
    this.#onExecute?.();
    return result;
  }

  /** 执行语句；与 D1 一样也保留 `RETURNING` 的结果行。 / Execute a statement, preserving `RETURNING` rows as D1 does. */
  public async run<T = Record<string, unknown>>(): Promise<TestD1Result<T>> {
    const result = this.#owner.execute<T>(this.#sql, this.#values);
    this.#onExecute?.();
    return result;
  }

  /** 返回数组形式的结果，供需要验证列顺序的测试使用。 / Return array-shaped results for tests that verify column order. */
  public async raw<T = unknown[]>(options?: {
    readonly columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const rows = this.#owner.raw(this.#sql, this.#values);
    this.#onExecute?.();
    if (options?.columnNames !== true) return rows.values as T[];
    return [rows.columns, ...rows.values] as [string[], ...T[]];
  }

  /** 暴露给同一文件中的原子 batch，防止跨数据库语句混用。 / Expose execution to the atomic batch and reject cross-database statements. */
  public executeFor(owner: TestD1Database): TestD1Result {
    if (owner !== this.#owner)
      throw new Error(
        "Cannot batch a statement prepared by another D1 database",
      );
    const result = owner.execute<Record<string, unknown>>(
      this.#sql,
      this.#values,
    );
    this.#onExecute?.();
    return result;
  }
}

/**
 * 顺序一致的 D1 session 测试实现。
 * Sequentially consistent test implementation of a D1 session.
 *
 * SQLite 测试数据库只有主副本，因此 `first-primary` 自然成立。bookmark 仅用于
 * 检查调用链是否通过同一个 session，不伪装真实分布式复制延迟。
 * The SQLite test database has only a primary, so `first-primary` holds
 * naturally. The bookmark identifies use of one session; it does not simulate
 * distributed replica lag.
 */
export class TestD1Session {
  /** 所有 session 操作共用的主数据库。 / Primary database shared by all session operations. */
  readonly #database: TestD1Database;
  /** 已完成操作数，用于测试 bookmark。 / Completed operation count used for the test bookmark. */
  #operations = 0;

  /** 创建与单一主库绑定的 session。 / Create a session bound to the single primary database. */
  public constructor(database: TestD1Database) {
    this.#database = database;
  }

  /** 在此 session 中准备 SQL。 / Prepare SQL within this session. */
  public prepare(sql: string): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.#database, sql, [], () => {
      this.#operations += 1;
    });
  }

  /** 原子执行 batch 并推进 session bookmark。 / Execute a batch atomically and advance the session bookmark. */
  public async batch<T = unknown>(
    statements: readonly TestD1PreparedStatement[],
  ): Promise<TestD1Result<T>[]> {
    return this.#database.batch<T>(statements);
  }

  /** 返回最后一次 session 操作的确定性 bookmark。 / Return a deterministic bookmark for the latest session operation. */
  public getBookmark(): string | null {
    return this.#operations === 0 ? null : `test-primary:${this.#operations}`;
  }
}

/**
 * 使用真实 SQL、外键和事务的内存 D1 适配器。
 * In-memory D1 adapter using real SQL, foreign keys, and transactions.
 *
 * @example
 * ```ts
 * const db = await createMigratedD1();
 * await db.prepare("INSERT INTO services (...) VALUES (...) ").bind(...values).run();
 * const service = await db.prepare("SELECT * FROM services WHERE service_name=?")
 *   .bind("api").first();
 * db.close();
 * ```
 */
export class TestD1Database {
  /** 唯一真实 SQLite 连接。 / The sole real SQLite connection. */
  readonly #sqlite: DatabaseSync;
  /** 防止 close 后继续使用。 / Prevent use after close. */
  #closed = false;

  /** 创建内存数据库并启用与 D1 一致的外键约束。 / Create an in-memory database and enable D1-equivalent foreign keys. */
  public constructor() {
    this.#sqlite = new DatabaseSync(":memory:");
    this.#sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  /** 准备一条 SQL 语句。 / Prepare one SQL statement. */
  public prepare(sql: string): TestD1PreparedStatement {
    this.ensureOpen();
    return new TestD1PreparedStatement(this, sql);
  }

  /**
   * 原子执行所有语句；任一失败会回滚先前语句。
   * Execute all statements atomically; one failure rolls back every prior statement.
   */
  public async batch<T = unknown>(
    statements: readonly TestD1PreparedStatement[],
  ): Promise<TestD1Result<T>[]> {
    this.ensureOpen();
    this.#sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(
        (statement) => statement.executeFor(this) as TestD1Result<T>,
      );
      this.#sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  /** 执行包含多条语句的 SQL 文本。 / Execute SQL text containing one or more statements. */
  public async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.ensureOpen();
    const started = performance.now();
    this.#sqlite.exec(sql);
    return {
      count: countStatements(sql),
      duration: performance.now() - started,
    };
  }

  /**
   * 创建顺序一致 session；测试仅接受 D1 的 `first-primary` 策略。
   * Create a sequentially consistent session; tests accept only D1's
   * `first-primary` policy so production reads cannot silently weaken it.
   */
  public withSession(
    constraintOrBookmark: string = "first-primary",
  ): TestD1Session {
    this.ensureOpen();
    if (
      constraintOrBookmark !== "first-primary" &&
      !constraintOrBookmark.startsWith("test-primary:")
    ) {
      throw new Error(
        `Integration tests require a first-primary D1 session, received: ${constraintOrBookmark}`,
      );
    }
    return new TestD1Session(this);
  }

  /** 关闭底层 SQLite；每个测试应在 teardown 调用。 / Close the underlying SQLite database during test teardown. */
  public close(): void {
    if (this.#closed) return;
    this.#sqlite.close();
    this.#closed = true;
  }

  /** 执行一条 SQL 并返回 D1 风格结果。 / Execute one SQL statement and return a D1-shaped result. */
  public execute<T>(
    sql: string,
    values: readonly BoundValue[],
  ): TestD1Result<T> {
    this.ensureOpen();
    const started = performance.now();
    const before = this.totalChanges();
    const statement = this.#sqlite.prepare(sql);
    let output: Record<string, SQLOutputValue>[];
    if (statement.columns().length === 0) {
      statement.run(...asSqlValues(values));
      output = [];
    } else {
      output = statement.all(...asSqlValues(values));
    }
    const rowsWritten = this.totalChanges() - before;
    const execution = this.#sqlite
      .prepare("SELECT changes() AS changes,last_insert_rowid() AS id")
      .get() as {
      readonly changes: number | bigint;
      readonly id: number | bigint;
    };
    const changes = Number(execution.changes);
    return {
      success: true,
      results: output.map(toPlainRow) as T[],
      meta: {
        changes,
        last_row_id: Number(execution.id),
        changed_db: rowsWritten > 0,
        duration: performance.now() - started,
        rows_read: output.length,
        rows_written: rowsWritten,
        size_after: this.databaseSize(),
      },
    };
  }

  /** 返回首行，避免由 `all()` 伪造 predetermined result。 / Return the first row directly from real SQL rather than a predetermined result. */
  public first(
    sql: string,
    values: readonly BoundValue[],
  ): Record<string, unknown> | null {
    this.ensureOpen();
    const statement = this.#sqlite.prepare(sql);
    const row = statement.get(...asSqlValues(values));
    return row === undefined ? null : toPlainRow(row);
  }

  /** 返回列名及数组行。 / Return column names and array rows. */
  public raw(
    sql: string,
    values: readonly BoundValue[],
  ): { columns: string[]; values: unknown[][] } {
    this.ensureOpen();
    const statement = this.#sqlite.prepare(sql);
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);
    const rows = statement.all(
      ...asSqlValues(values),
    ) as unknown as SQLOutputValue[][];
    return { columns, values: rows.map((row) => [...row]) };
  }

  private totalChanges(): number {
    const row = this.#sqlite
      .prepare("SELECT total_changes() AS count")
      .get() as { readonly count: number | bigint };
    return Number(row.count);
  }

  /** 读取 SQLite 页计数计算数据库大小。 / Compute database size from SQLite page counts. */
  private databaseSize(): number {
    const pages = this.#sqlite.prepare("PRAGMA page_count").get() as {
      readonly page_count: number | bigint;
    };
    const pageSize = this.#sqlite.prepare("PRAGMA page_size").get() as {
      readonly page_size: number | bigint;
    };
    return Number(pages.page_count) * Number(pageSize.page_size);
  }

  /** 在每条公共操作前检查连接生命周期。 / Check connection lifetime before each public operation. */
  private ensureOpen(): void {
    if (this.#closed) throw new Error("D1 test database is closed");
  }
}

/**
 * 创建数据库并按文件名顺序原子应用 `migrations/*.sql`。
 * Create a database and atomically apply `migrations/*.sql` in filename order.
 */
export async function createMigratedD1(
  migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../migrations",
  ),
): Promise<TestD1Database> {
  const database = new TestD1Database();
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
  try {
    for (const name of names) {
      const migration = await readFile(join(migrationsDirectory, name), "utf8");
      await database.exec(`BEGIN IMMEDIATE;\n${migration}\nCOMMIT;`);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** 把 Worker D1 值转换成 node:sqlite 值。 / Convert a Worker D1 value into a node:sqlite value. */
function normalizeBinding(value: unknown): BoundValue {
  if (value === undefined)
    throw new TypeError(
      "D1 bindings do not accept undefined; use null explicitly",
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  )
    return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(
    `Unsupported D1 binding type: ${Object.prototype.toString.call(value)}`,
  );
}

/** 将只读绑定投影为 node:sqlite 的调用数组。 / Project readonly bindings into node:sqlite's call-array type. */
function asSqlValues(values: readonly BoundValue[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

/** 移除 node:sqlite 的 null prototype，使结果与 D1 JSON 行一致。 / Remove node:sqlite's null prototype to match D1 JSON rows. */
function toPlainRow(
  row: Record<string, SQLOutputValue>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

/** 为 D1 exec 元数据近似计算语句数量。 / Approximately count statements for D1 exec metadata. */
function countStatements(sql: string): number {
  return sql
    .split(";")
    .filter(
      (statement) =>
        statement.trim().length > 0 && !/^--/u.test(statement.trim()),
    ).length;
}
