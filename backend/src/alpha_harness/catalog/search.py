"""Finding a Data Field by meaning rather than by substring.

BRAIN's field ids are compressed jargon — ``anl44_eps_prevalue``, ``mdl50_bk_analyst_revisn``
— but their descriptions are plain English, and a BM25 index over the id's own words *and*
the description finds a field from the words a person would actually use. Nothing is
translated or guessed at on the way in: the id is split where BRAIN put a separator, and the
description is taken as written.

One row per field id rather than per market: the text is identical across markets, and BM25's
term statistics are better drawn from the whole catalog than from one slice. Narrowing to a
market stays the caller's job.
"""

import re
from typing import TYPE_CHECKING

import structlog

if TYPE_CHECKING:
    from ..db.duck import Catalog

log = structlog.get_logger(__name__)

TABLE = "field_search"
#: Created by ``create_fts_index``, and the only proof the index itself exists.
INDEX_SCHEMA = f"fts_main_{TABLE}"

#: The id's own words plus the description. ``anl44_eps_prevalue`` indexes as
#: ``anl44 eps prevalue`` — split on the separators, and nowhere else.
_TEXT = (
    "regexp_replace(lower(field_id), '[^a-z0-9]+', ' ', 'g') || ' ' || coalesce(description, '')"
)

#: One row per field id, since the text does not vary by market.
_CORPUS = "SELECT field_id, any_value(description) AS description FROM data_field GROUP BY field_id"

#: Scores a row against the query, ``NULL`` when it does not match. The second placeholder
#: picks AND (``1``) or OR (``0``) over the query's terms; :meth:`CatalogQueries.fields`
#: chooses. Neither is right alone — measured on this catalog, OR answers 15,976 fields for
#: "analyst revision momentum", and AND answers nothing when one word is missing everywhere.
MATCH = f"{INDEX_SCHEMA}.match_bm25(field_id, ?, conjunctive := ?)"

_WORDS = re.compile(r"[^0-9a-z]+")


def query_terms(search: str) -> str | None:
    """A typed phrase as terms BM25 will accept, or ``None`` when nothing is left of it."""
    terms = " ".join(w for w in _WORDS.split(search.lower()) if w)
    return terms or None


async def rebuild(catalog: Catalog) -> int:
    """Build the search corpus and its BM25 index. Idempotent, and about two seconds.

    Returns the number of fields indexed, or ``0`` when ``fts`` is not loaded: a machine that
    cannot download it (see :func:`build`) keeps substring search and nothing worse.

    The corpus is dropped again if the index cannot be built on top of it: a corpus without
    its index looks ready while answering every search with ``match_bm25 does not exist``.
    """
    if not catalog.fts:
        return 0
    await catalog.execute(
        f"CREATE OR REPLACE TABLE {TABLE} AS "  # noqa: S608 - every fragment is a module constant
        f"SELECT field_id, description, {_TEXT} AS text FROM ({_CORPUS})"
    )
    try:
        await catalog.execute(
            f"PRAGMA create_fts_index('{TABLE}', 'field_id', 'text', stemmer='porter', overwrite=1)"
        )
    except Exception:
        await catalog.execute(f"DROP TABLE IF EXISTS {TABLE}")
        raise
    # Into the file at once: an index rebuild left in the write-ahead log was reported failing
    # to replay ("Cannot drop entry fts_main_field_search"), which kept the app from starting.
    try:
        await catalog.execute("CHECKPOINT")
    except Exception:
        log.warning("catalog.search_checkpoint_failed", exc_info=True)
    indexed = int(await catalog.scalar(f"SELECT count(*) FROM {TABLE}") or 0)  # noqa: S608
    log.info("catalog.search_indexed", fields=indexed)
    return indexed


async def build(catalog: Catalog) -> int:
    """:func:`rebuild`, downloading ``fts`` first when it is missing.

    Startup's alone, in the background: where DuckDB's repository is blocked the download
    takes minutes to give up, and a sync that ended in it would read as running all along.
    """
    if not catalog.fts:
        await catalog.install_fts()
    return await rebuild(catalog)


async def ready(catalog: Catalog) -> bool:
    """Whether a search can use the index. Cheap enough to ask on every search.

    Asks after the index rather than the corpus: they are built in that order, and the half
    built pair is exactly the state that breaks every query.
    """
    if not catalog.fts:
        return False
    return bool(
        await catalog.scalar("SELECT 1 FROM duckdb_schemas() WHERE schema_name = ?", [INDEX_SCHEMA])
    )
