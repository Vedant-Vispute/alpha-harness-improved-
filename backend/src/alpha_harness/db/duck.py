"""DuckDB store for the data catalog.

A second engine because the catalog is ~85k fields *per* (instrumentType, region, delay,
universe) tuple and the Data Explorer's queries are columnar set operations across those
tuples. SQLite keeps the transactional state that must never be lost; DuckDB keeps the
bulk data that can always be re-synced.

The driver is synchronous and a connection is not safe for concurrent use, so writes are
serialised behind a lock, all off the event loop. Reads take their own cursor instead, which
MVCC lets run beside a write, so a long correlation read never stalls a sync.
"""

import asyncio
import contextlib
import re
from typing import TYPE_CHECKING, Any

import duckdb
import pyarrow as pa
import structlog

if TYPE_CHECKING:
    from collections.abc import Callable, Generator
    from pathlib import Path

log = structlog.get_logger(__name__)

# One row per field per (instrumentType, region, delay, universe). The composite key is
# what makes availability checks and set operations a single indexed scan.
SCHEMA = """
CREATE TABLE IF NOT EXISTS data_field (
    field_id          VARCHAR NOT NULL,
    dataset_id        VARCHAR,
    category_id       VARCHAR,
    category_name     VARCHAR,
    subcategory_id    VARCHAR,
    subcategory_name  VARCHAR,
    description       VARCHAR,
    field_type        VARCHAR,
    coverage          DOUBLE,
    date_coverage     DOUBLE,
    user_count        INTEGER,
    alpha_count       INTEGER,
    pyramid_multiplier DOUBLE,
    themes            VARCHAR,
    date_created      DATE,
    instrument_type   VARCHAR NOT NULL,
    region            VARCHAR NOT NULL,
    delay             INTEGER NOT NULL,
    universe          VARCHAR NOT NULL,
    synced_at         TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_set (
    dataset_id        VARCHAR NOT NULL,
    name              VARCHAR,
    description       VARCHAR,
    category_id       VARCHAR,
    category_name     VARCHAR,
    subcategory_id    VARCHAR,
    subcategory_name  VARCHAR,
    coverage          DOUBLE,
    value_score       DOUBLE,
    user_count        INTEGER,
    alpha_count       INTEGER,
    field_count       INTEGER,
    pyramid_multiplier DOUBLE,
    themes            VARCHAR,
    instrument_type   VARCHAR NOT NULL,
    region            VARCHAR NOT NULL,
    delay             INTEGER NOT NULL,
    universe          VARCHAR NOT NULL,
    synced_at         TIMESTAMP,
    PRIMARY KEY (dataset_id, instrument_type, region, delay, universe)
);

CREATE TABLE IF NOT EXISTS data_category (
    category_id       VARCHAR NOT NULL,
    name              VARCHAR,
    parent_id         VARCHAR,
    dataset_count     INTEGER,
    field_count       INTEGER,
    value_score       DOUBLE,
    instrument_type   VARCHAR NOT NULL,
    region            VARCHAR NOT NULL,
    delay             INTEGER NOT NULL,
    universe          VARCHAR NOT NULL,
    synced_at         TIMESTAMP,
    PRIMARY KEY (category_id, instrument_type, region, delay, universe)
);

-- Only region ALL sends it: how many regions hold the field, which is what says whether it
-- can survive a region-agnostic simulation's intersection of regions.
ALTER TABLE data_field ADD COLUMN IF NOT EXISTS region_coverage INTEGER;
ALTER TABLE data_field ADD COLUMN IF NOT EXISTS date_coverage DOUBLE;
ALTER TABLE data_field ADD COLUMN IF NOT EXISTS date_created DATE;

CREATE INDEX IF NOT EXISTS ix_field_tuple
    ON data_field (instrument_type, region, delay, universe);
CREATE INDEX IF NOT EXISTS ix_set_tuple
    ON data_set (instrument_type, region, delay, universe);

-- Every alpha ever simulated, and its daily profit-and-loss series. Here rather than in
-- SQLite because pairwise correlation over ~2,500 daily values per alpha is a columnar
-- query, and because it is all re-fetchable from the platform.
CREATE TABLE IF NOT EXISTS alpha (
    alpha_id          VARCHAR PRIMARY KEY,
    expression        VARCHAR,
    sim_type          VARCHAR,
    instrument_type   VARCHAR,
    region            VARCHAR,
    delay             INTEGER,
    universe          VARCHAR,
    neutralization    VARCHAR,
    decay             INTEGER,
    truncation        DOUBLE,
    sharpe            DOUBLE,
    fitness           DOUBLE,
    turnover          DOUBLE,
    returns           DOUBLE,
    drawdown          DOUBLE,
    margin            DOUBLE,
    long_count        INTEGER,
    short_count       INTEGER,
    grade             VARCHAR,
    stage             VARCHAR,
    status            VARCHAR,
    operator_count    INTEGER,
    date_created      TIMESTAMP,
    checks            VARCHAR,
    fetched_at        TIMESTAMP
);

-- Computed from alpha_pnl on demand, so it survives re-imports of the alpha row.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS name VARCHAR;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS date_submitted TIMESTAMP;
-- A simulation that holds its last years out as a test reports its train years apart.
-- Written only from Alphas that carry them, so a listing without them never blanks them.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS train_sharpe DOUBLE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS train_fitness DOUBLE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS test_sharpe DOUBLE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS test_fitness DOUBLE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS test_start DATE;
-- What the Portfolio page filters on. Tags, classifications ("Power Pool Alpha") and
-- pyramids ("ASI/D1/OTHER") are JSON arrays of names; an empty array means "none".
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS max_trade VARCHAR;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS max_position VARCHAR;
-- Quick mode alphas carry every performance metric and none of the submission checks,
-- so nothing in `checks` reveals that BRAIN will never take one.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS simulation_mode VARCHAR;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS tags VARCHAR;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS classifications VARCHAR;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS pyramids VARCHAR;
-- What rebuilds the final day BRAIN counts in IS and test but exports in no recordset.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS is_pnl DOUBLE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS test_turnover DOUBLE;
-- How the stored daily series was built (``vault.store.SERIES_VERSION``); older ones are refetched.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS series_version INTEGER;
-- The same, for a daily PnL stored without its turnover: enough to correlate, not to cost.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS pnl_version INTEGER;
-- The after-cost t-stat over sqrt(10) (``vault.metrics.after_cost_sharpe``), worked out when the
-- series is stored so a table of a thousand Alphas need not read a thousand series to show it.
-- An older database also carries `after_cost_sharpe`, the plain after-cost Sharpe, which
-- nothing reads now; a new column rather than a rewrite, so startup rebuilds every value.
ALTER TABLE alpha ADD COLUMN IF NOT EXISTS after_cost_t10 DOUBLE;
-- In-sample figures rebuilt from the stored series (final days included), kept so the Portfolio
-- list need not read every series. Apart from BRAIN's own, which a listing overwrites.
-- An older database still carries `series_sharpe` and its five siblings, rebuilt locally
-- from the stored series before the Portfolio page read BRAIN's own per-Alpha figures, and
-- `k_ratio`. Nothing reads or writes any of them now; they stay because DuckDB refuses to
-- drop a column from a table an index depends on, and rebuilding this one to tidy seven
-- unread doubles would cost far more than it saves.
DROP TABLE IF EXISTS k_ratio_2003;

-- One row per alpha per trading day. ~2,500 rows per alpha.
CREATE TABLE IF NOT EXISTS alpha_pnl (
    alpha_id          VARCHAR NOT NULL,
    date              DATE NOT NULL,
    pnl               DOUBLE,
    PRIMARY KEY (alpha_id, date)
);
-- NULL on every row of an alpha means its series predates the pnl + turnover download and
-- is re-fetched: the old daily-pnl recordset is rounded separately from the platform's stats.
ALTER TABLE alpha_pnl ADD COLUMN IF NOT EXISTS turnover DOUBLE;

CREATE INDEX IF NOT EXISTS ix_alpha_scope
    ON alpha (instrument_type, region, delay, universe);
CREATE INDEX IF NOT EXISTS ix_alpha_sharpe ON alpha (sharpe);
CREATE INDEX IF NOT EXISTS ix_pnl_date ON alpha_pnl (date);
"""

FIELD_COLUMNS = (
    "field_id",
    "dataset_id",
    "category_id",
    "category_name",
    "subcategory_id",
    "subcategory_name",
    "description",
    "field_type",
    "coverage",
    "date_coverage",
    "user_count",
    "alpha_count",
    "pyramid_multiplier",
    "themes",
    "date_created",
    "region_coverage",
    "instrument_type",
    "region",
    "delay",
    "universe",
    "synced_at",
)

DATASET_COLUMNS = (
    "dataset_id",
    "name",
    "description",
    "category_id",
    "category_name",
    "subcategory_id",
    "subcategory_name",
    "coverage",
    "value_score",
    "user_count",
    "alpha_count",
    "field_count",
    "pyramid_multiplier",
    "themes",
    "instrument_type",
    "region",
    "delay",
    "universe",
    "synced_at",
)

CATEGORY_COLUMNS = (
    "category_id",
    "name",
    "parent_id",
    "dataset_count",
    "field_count",
    "value_score",
    "instrument_type",
    "region",
    "delay",
    "universe",
    "synced_at",
)

ALPHA_COLUMNS = (
    "alpha_id",
    "expression",
    "sim_type",
    "instrument_type",
    "region",
    "delay",
    "universe",
    "neutralization",
    "decay",
    "truncation",
    "sharpe",
    "fitness",
    "turnover",
    "returns",
    "drawdown",
    "margin",
    "long_count",
    "short_count",
    "grade",
    "stage",
    "status",
    "operator_count",
    "date_created",
    "checks",
    "fetched_at",
    "name",
    "date_submitted",
    "max_trade",
    "max_position",
    "tags",
    "classifications",
    "pyramids",
    "is_pnl",
    "end_date",
    "simulation_mode",
)

#: Written only with an Alpha that has a ``train`` block (see ``AlphaVault.save_alphas``).
TRAIN_COLUMNS = (
    "train_sharpe",
    "train_fitness",
    "test_sharpe",
    "test_fitness",
    "test_start",
    "test_turnover",
)

PNL_COLUMNS = ("alpha_id", "date", "pnl", "turnover")

_KEYS = {
    "data_set": ("dataset_id", "instrument_type", "region", "delay", "universe"),
    "data_category": ("category_id", "instrument_type", "region", "delay", "universe"),
    "alpha": ("alpha_id",),
    "alpha_pnl": ("alpha_id", "date"),
}

#: Writes go through Arrow rather than SQL parameter binding, which was the bottleneck on
#: large batches by three orders of magnitude. Each column's Arrow type follows its DuckDB
#: type, read off the schema when the catalog opens, rather than inferred: a column that
#: happens to be all NULL in one batch would otherwise infer as Arrow's null type and fail to
#: insert into a typed column.
_ARROW: dict[str, pa.DataType] = {
    "VARCHAR": pa.string(),
    "DOUBLE": pa.float64(),
    "INTEGER": pa.int32(),
    "DATE": pa.date32(),
    "TIMESTAMP": pa.timestamp("us", tz="UTC"),
}

#: The relation a bulk load is registered as while its statements read from it.
_INCOMING = "_incoming"


def _upsert_sql(table: str, columns: tuple[str, ...], *, overwrite: bool) -> str:
    """``INSERT ... SELECT`` from the loaded Arrow relation, with upsert semantics.

    ``overwrite=False`` inserts only keys not stored yet and leaves existing rows untouched.
    """
    key = _KEYS[table]
    column_list = ", ".join(columns)
    insert = (
        f"INSERT INTO {table} ({column_list}) SELECT {column_list} FROM {_INCOMING} "  # noqa: S608
        f"ON CONFLICT ({', '.join(key)}) "
    )
    if not overwrite:
        return insert + "DO NOTHING"
    updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c not in key)
    return insert + f"DO UPDATE SET {updates}"


#: Indexes a rebuilt ``data_field`` has to get back.
_FIELD_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_field_tuple ON data_field "
    "(instrument_type, region, delay, universe)",
)

#: Restored after a rebuild: ``CREATE TABLE ... AS SELECT`` copies types but not
#: nullability, and DuckDB has no ``CREATE TABLE (LIKE ...)`` to copy the schema with.
_FIELD_NOT_NULL = ("field_id", "instrument_type", "region", "delay", "universe")


@contextlib.contextmanager
def _transaction(conn: duckdb.DuckDBPyConnection) -> Generator[None]:
    """One transaction: committed when the block finishes, rolled back when it raises."""
    conn.execute("BEGIN TRANSACTION")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


class CatalogUnusableError(RuntimeError):
    """DuckDB rejected everything after a fatal error; only a restart clears it.

    Raised so a caller stops rather than retrying: once the database is invalidated every
    later statement fails the same way.
    """


class CatalogLockedError(RuntimeError):
    """Another Alpha Harness backend already has the catalog open.

    DuckDB allows exactly one writer, so the fix is always the same: stop the other one.
    """

    def __init__(self, path: Path, detail: str) -> None:
        holder = ""
        match = re.search(r"PID (\d+)", detail)
        if match:
            holder = f" (process {match.group(1)})"
        super().__init__(
            f"Another Alpha Harness backend{holder} is already running and has "
            f"{path} open. DuckDB allows only one writer, so stop the other one and "
            "start again. If you believe nothing else is running, the previous process "
            "did not shut down cleanly — end it and retry."
        )
        self.path = path
        self.detail = detail


def _load_fts(conn: duckdb.DuckDBPyConnection) -> bool:
    """Whether full-text search can be used: ``fts`` is on disk and loads.

    DuckDB ships ``fts`` from its repository rather than statically, and fetching it is
    :meth:`Catalog.install_fts`'s job, never opening's. A machine that cannot reach the
    repository keeps substring search, which is worse but not broken.
    """
    try:
        conn.execute("LOAD fts")
    except duckdb.Error:
        return False
    return True


class Catalog:
    """Async facade over a DuckDB file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: duckdb.DuckDBPyConnection | None = None
        self._lock = asyncio.Lock()
        #: Reads in flight. Futures rather than a count: a cancelled caller does not stop
        #: its thread, and ``close`` must wait for the thread, not the caller.
        self._reads: set[asyncio.Future[Any]] = set()
        self._closing = False
        #: Whether full-text search is available; see :func:`_load_fts`.
        self.fts = False
        #: Table -> column -> Arrow type, read off the schema on open; see :data:`_ARROW`.
        self._types: dict[str, dict[str, pa.DataType]] = {}

    async def open(self) -> None:
        await asyncio.to_thread(self._open_sync)
        log.info("catalog.opened", path=str(self.path))

    def _open_sync(self) -> None:
        try:
            self._conn = duckdb.connect(str(self.path))
        except duckdb.IOException as exc:
            # DuckDB is single-writer, so a second backend is the likely cause. The raw
            # exception is a wall of text ending in a URL; say the useful thing instead.
            if "lock" not in str(exc).lower():
                raise
            raise CatalogLockedError(self.path, str(exc)) from exc
        # DuckDB's zone otherwise defaults to the machine's, shifting every stored time by the
        # local offset. GLOBAL, so read cursors get it too. Never as a ``connect`` option: that
        # makes DuckDB download its time zone extension before loading the one built in, and
        # where the download is blocked the catalog does not open at all.
        self._conn.execute("SET GLOBAL TimeZone = 'UTC'")
        self._conn.execute(SCHEMA)
        for table, column, kind in self._conn.execute(
            "SELECT table_name, column_name, data_type FROM duckdb_columns() "
            "WHERE schema_name = 'main'"
        ).fetchall():
            if kind in _ARROW:
                self._types.setdefault(table, {})[column] = _ARROW[kind]
        self.fts = _load_fts(self._conn)

    async def install_fts(self) -> bool:
        """Download ``fts`` from DuckDB's repository, then load it. Whether search can use it.

        On a scratch connection, so the download holds no lock: where the repository is
        blocked, DuckDB retries for up to a couple of minutes before it gives up.
        """

        def download() -> None:
            with duckdb.connect() as scratch:
                scratch.execute("INSTALL fts")

        try:
            await asyncio.to_thread(download)
        except duckdb.Error:
            log.info("catalog.fts_unavailable", exc_info=True)
            return False
        self.fts = await self._locked(_load_fts, self._require())
        return self.fts

    async def execute(self, sql: str, params: list[Any] | None = None) -> None:
        """Run one statement. For DDL and small writes; bulk loads go through Arrow."""
        await self._locked(lambda: self._require().execute(sql, params or []))

    async def close(self) -> None:
        """Refuse new reads, then let in-flight writes and reads finish before closing."""
        self._closing = True
        async with self._lock:
            await asyncio.gather(*self._reads, return_exceptions=True)
            if self._conn is not None:
                await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            conn.close()

    async def _locked[T](self, fn: Callable[..., T], *args: Any) -> T:
        """Run ``fn`` on the one connection, holding the lock until the thread is done.

        A thread cannot be cancelled, so if the awaiting task is, the lock must still not
        be released while the thread holds the non-thread-safe connection.
        """
        async with self._lock:
            work = asyncio.ensure_future(asyncio.to_thread(fn, *args))
            try:
                return await asyncio.shield(work)
            except asyncio.CancelledError:
                with contextlib.suppress(Exception):
                    await work
                raise
            except duckdb.FatalException as exc:
                raise CatalogUnusableError(str(exc)) from exc

    def _require(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            raise RuntimeError("Catalog is not open; call await catalog.open() first")
        return self._conn

    # -- reads -----------------------------------------------------------

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        """Run a read query and return rows as dicts. Does not wait for writes."""
        return await self._read(self._query_sync, sql, params or [])

    async def arrow(self, sql: str, params: list[Any] | None = None) -> pa.Table:
        """:meth:`query` as an Arrow table, for results too large for a Python object per row."""
        return await self._read(self._arrow_sync, sql, params or [])

    async def _read[T](self, fn: Callable[[str, list[Any]], T], sql: str, params: list[Any]) -> T:
        if self._closing or self._conn is None:
            raise RuntimeError("Catalog is closed or shutting down")
        work = asyncio.ensure_future(asyncio.to_thread(fn, sql, params))
        self._reads.add(work)
        work.add_done_callback(self._reads.discard)
        return await asyncio.shield(work)

    def _query_sync(self, sql: str, params: list[Any]) -> list[dict[str, Any]]:
        with self._require().cursor() as cur:
            cur.execute(sql, params)
            columns = [d[0] for d in cur.description or []]
            return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]

    def _arrow_sync(self, sql: str, params: list[Any]) -> pa.Table:
        with self._require().cursor() as cur:
            return cur.execute(sql, params).to_arrow_table()

    async def scalar(self, sql: str, params: list[Any] | None = None) -> Any:
        rows = await self.query(sql, params)
        if not rows:
            return None
        return next(iter(rows[0].values()))

    # -- writes ----------------------------------------------------------

    async def upsert(
        self,
        table: str,
        columns: tuple[str, ...],
        rows: list[tuple[Any, ...]],
        *,
        overwrite: bool = True,
    ) -> int:
        """Insert or update a batch. Returns the number of rows written.

        Goes through Arrow — see :data:`_ARROW` for why. Re-syncing the same scope updates
        rows in place rather than duplicating them; ``overwrite=False`` only adds rows whose
        key is new.
        """
        if not rows:
            return 0
        # Built before the lock, as replace_fields does: no writer waits on the conversion.
        batch = await asyncio.to_thread(self._to_arrow, table, columns, rows)
        await self._locked(
            self._load, batch, (_upsert_sql(table, columns, overwrite=overwrite), [])
        )
        return len(rows)

    def _to_arrow(
        self, table: str, columns: tuple[str, ...], rows: list[tuple[Any, ...]]
    ) -> pa.Table:
        """Transpose row tuples into a typed Arrow table."""
        types = self._types[table]
        transposed = list(zip(*rows, strict=True))
        return pa.table(
            {
                name: pa.array(values, type=types[name])
                for name, values in zip(columns, transposed, strict=True)
            }
        )

    def _load(self, table: pa.Table, *statements: tuple[str, list[Any]]) -> None:
        """Run ``statements`` in one transaction, with ``table`` readable as :data:`_INCOMING`."""
        conn = self._require()
        conn.register(_INCOMING, table)
        try:
            with _transaction(conn):
                for sql, params in statements:
                    conn.execute(sql, params)
        finally:
            conn.unregister(_INCOMING)

    async def used_bytes(self) -> int:
        """What the catalog's data actually occupies.

        The file is larger: DuckDB keeps freed blocks for reuse rather than returning them
        to the operating system, so its size on disk is a high-water mark, not a total.
        """
        return await self._locked(self._used_bytes_sync)

    def _used_bytes_sync(self) -> int:
        conn = self._require()
        row = conn.execute("PRAGMA database_size").fetchone()
        if row is None:
            return 0
        sized = dict(zip([d[0] for d in conn.description], row, strict=False))
        return int(sized.get("used_blocks") or 0) * int(sized.get("block_size") or 0)

    async def compact_fields(self) -> None:
        """Rewrite ``data_field`` so its rows sit in dense row groups again.

        A sync replaces one scope at a time, which leaves around sixty part-filled row
        groups where ten would do. DuckDB compresses per row group, so the same rows cost
        roughly five times the space until the table is rewritten.
        """
        await self._locked(self._compact_sync)

    def _compact_sync(self) -> None:
        conn = self._require()
        with _transaction(conn):
            conn.execute("CREATE TABLE data_field_compact AS SELECT * FROM data_field")
            conn.execute("DROP TABLE data_field")
            conn.execute("ALTER TABLE data_field_compact RENAME TO data_field")
            for column in _FIELD_NOT_NULL:
                conn.execute(f"ALTER TABLE data_field ALTER COLUMN {column} SET NOT NULL")
            for statement in _FIELD_INDEXES:
                conn.execute(statement)
        conn.execute("CHECKPOINT")

    async def replace_fields(self, scope: list[Any], rows: list[tuple[Any, ...]]) -> int:
        """Make one scope's fields exactly ``rows``, in one transaction.

        Delete then insert: a field BRAIN has removed would otherwise stay selectable and
        spend a simulation on an error.
        """
        if not rows:
            return 0
        # Built before the lock: pivoting 85k rows into columns is pure CPU, and doing it
        # while holding the single writer stalls every other market's write behind it.
        table = await asyncio.to_thread(self._to_arrow, "data_field", FIELD_COLUMNS, rows)
        columns = ", ".join(FIELD_COLUMNS)
        await self._locked(
            self._load,
            table,
            (
                "DELETE FROM data_field WHERE instrument_type = ? AND region = ? "
                "AND delay = ? AND universe = ?",
                scope,
            ),
            (f"INSERT INTO data_field ({columns}) SELECT {columns} FROM {_INCOMING}", []),  # noqa: S608
        )
        return len(rows)

    async def replace_pnl(self, alpha_id: str, rows: list[tuple[Any, ...]]) -> int:
        """Make one alpha's daily series exactly ``rows``, in one transaction.

        Delete then insert: an older series may hold dates the current recordset does not.
        """
        if not rows:
            return 0
        table = self._to_arrow("alpha_pnl", PNL_COLUMNS, rows)
        columns = ", ".join(PNL_COLUMNS)
        await self._locked(
            self._load,
            table,
            ("DELETE FROM alpha_pnl WHERE alpha_id = ?", [alpha_id]),
            (f"INSERT INTO alpha_pnl ({columns}) SELECT {columns} FROM {_INCOMING}", []),  # noqa: S608
        )
        return len(rows)
