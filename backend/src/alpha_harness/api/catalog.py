"""Data Explorer: syncing the catalog and querying it."""

from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel

from ..brain.schemas import REGION_AGNOSTIC_REGION
from ..brain.settings_schema import valid_values
from ..catalog.pyramids import pyramid_grid
from ..catalog.queries import FieldFilter, Tuple4
from ..catalog.sync import SyncTarget
from ..schemas import Out, SyncAllRun
from .deps import State, refuse

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def scope(
    region: Annotated[str, Query(description="e.g. USA, EUR, GLB")],
    delay: Annotated[int, Query(ge=0, le=1)],
    universe: Annotated[str, Query(description="e.g. TOP3000")],
    instrument_type: Annotated[str, Query(alias="instrumentType")] = "EQUITY",
) -> Tuple4:
    """The (instrumentType, region, delay, universe) scope every query needs."""
    return Tuple4(instrument_type=instrument_type, region=region, delay=delay, universe=universe)


Scope = Annotated[Tuple4, Depends(scope)]


# --- wire shapes: DuckDB rows keep their snake_case column names ------------


class Market(Out):
    instrument_type: str
    region: str
    delay: int
    universe: str


class Cancelled(Out):
    cancelled: bool


class PyramidColumn(Out):
    region: str
    delay: int


class PyramidCategory(Out):
    id: str
    name: str


class PyramidCell(Out):
    category_id: str
    region: str
    delay: int
    multiplier: float | None
    alpha_count: int
    #: 3+ alphas this quarter.
    lit: bool
    synced: bool


class Quarter(Out):
    """Calendar quarter in platform time; ``end`` is the next quarter's first day."""

    start: str
    end: str
    today: str


class PyramidGrid(Out):
    columns: list[PyramidColumn]
    categories: list[PyramidCategory]
    cells: list[PyramidCell]
    quarter: Quarter
    #: Submitted Alphas a pyramid needs before BRAIN counts it as formulated.
    alphas_per_pyramid: int


class CatalogScopeRow(BaseModel):
    instrument_type: str
    region: str
    delay: int
    universe: str
    fields: int
    synced_at: datetime | None


class CatalogCounts(BaseModel):
    fields: int
    datasets: int
    categories: int
    subcategories: int


class CatalogSize(BaseModel):
    """What the catalog's data occupies, which is smaller than its file."""

    used_bytes: int


class CatalogStats(BaseModel):
    coverage_min: float | None = None
    coverage_max: float | None = None
    coverage_median: float | None = None
    alpha_count_max: int | None = None
    user_count_max: int | None = None
    pyramid_multiplier_max: float | None = None


class DataFieldRow(BaseModel):
    field_id: str
    dataset_id: str | None
    category_id: str | None
    category_name: str | None
    subcategory_id: str | None
    subcategory_name: str | None
    description: str | None
    field_type: str | None
    #: BRAIN's "Instrument Coverage": the share of the universe the field has a value for.
    coverage: float | None
    #: BRAIN's "Date Coverage": the share of the history it has a value for. A field can be
    #: complete on one and threadbare on the other, so neither stands in for the other.
    date_coverage: float | None
    user_count: int | None
    alpha_count: int | None
    pyramid_multiplier: float | None
    #: JSON array text.
    themes: str | None
    #: BRAIN's "Date added": when the field first appeared in this market. Null until the
    #: market is downloaded again, because it was not stored before.
    date_created: date | None


class DataFieldDetail(DataFieldRow):
    instrument_type: str
    region: str
    delay: int
    universe: str
    synced_at: datetime | None


class FieldPage(BaseModel):
    total: int
    limit: int
    offset: int
    results: list[DataFieldRow]


class CategoryFacet(BaseModel):
    id: str
    name: str | None
    n: int


class SubcategoryFacet(CategoryFacet):
    category_id: str | None


class DatasetFacet(BaseModel):
    id: str
    category_id: str | None
    subcategory_id: str | None
    n: int


class TypeFacet(BaseModel):
    id: str
    n: int


class CatalogFacets(BaseModel):
    categories: list[CategoryFacet]
    subcategories: list[SubcategoryFacet]
    datasets: list[DatasetFacet]
    types: list[TypeFacet]


class FieldAvailabilityRow(BaseModel):
    instrument_type: str
    region: str
    delay: int
    universe: str
    coverage: float | None
    alpha_count: int | None
    field_type: str | None


class DatasetRow(BaseModel):
    dataset_id: str
    name: str | None
    description: str | None
    category_id: str | None
    category_name: str | None
    subcategory_id: str | None
    subcategory_name: str | None
    coverage: float | None
    value_score: float | None
    user_count: int | None
    alpha_count: int | None
    field_count: int | None
    pyramid_multiplier: float | None


# --- syncing --------------------------------------------------------------


async def _markets(state: State) -> list[SyncTarget]:
    """Every EQUITY market the account can simulate, from BRAIN's own settings schema.

    A new region or universe is picked up without a code change. Region ``ALL`` is in here
    like any other: it is drawn in the sync matrix so an account that can run region-agnostic
    alphas can see whether it holds them. What it is *not* is part of a sync by default —
    see :func:`start_sync_all`.
    """
    schema = (
        await state.metadata.cached_settings_schema() or await state.metadata.refresh_metadata()
    )
    # EQUITY only, the one instrument type the Data Explorer offers.
    base: dict[str, Any] = {"instrumentType": "EQUITY"}
    return [
        SyncTarget(instrument_type="EQUITY", region=region, delay=int(delay), universe=universe)
        for region in valid_values(schema, "region", base)
        for delay in valid_values(schema, "delay", {**base, "region": region})
        for universe in valid_values(schema, "universe", {**base, "region": region, "delay": delay})
    ]


@router.get("/markets")
async def markets(state: State) -> list[Market]:
    """Every market BRAIN offers: what the sync matrix draws."""
    return [
        Market(
            instrument_type=t.instrument_type, region=t.region, delay=t.delay, universe=t.universe
        )
        for t in await _markets(state)
    ]


@router.post("/sync-all")
async def start_sync_all(state: State) -> SyncAllRun:
    """Download every ordinary market: all fields first, then dataset details.

    Region ``ALL`` is not one of them; it has :func:`start_sync_region_agnostic` to itself.

    Runs in the background; progress, including each market's state, arrives over the
    WebSocket ``sync`` topic.
    """
    targets = [t for t in await _markets(state) if t.region != REGION_AGNOSTIC_REGION]
    if not targets:
        raise refuse(
            503,
            "no_markets",
            "BRAIN's settings list no markets to download. Sign in again and retry.",
        )
    return SyncAllRun.model_validate(await state.sync.start_all(targets))


@router.post("/sync-region-agnostic")
async def start_sync_region_agnostic(state: State) -> SyncAllRun:
    """Download the region-agnostic market: every universe of region ``ALL``.

    Its own route because it is its own download. BRAIN serves this market only fifty fields
    at a time, so it is read dataset by dataset — about ten minutes per universe where an
    ordinary market is seconds — and only an account running region-agnostic alphas needs it.
    """
    targets = [t for t in await _markets(state) if t.region == REGION_AGNOSTIC_REGION]
    if not targets:
        raise refuse(
            403,
            "no_region_agnostic",
            "This account cannot run region-agnostic simulations, so BRAIN offers no "
            "all-regions market to download.",
        )
    return SyncAllRun.model_validate(await state.sync.start_all(targets))


@router.post("/sync/runs/{run_id}/cancel")
async def cancel_run(run_id: int, state: State) -> Cancelled:
    return Cancelled(cancelled=await state.sync.cancel(run_id))


@router.get("/pyramids")
async def pyramids(state: State) -> PyramidGrid:
    """Every pyramid: its multiplier, this quarter's alpha count, and download state."""
    return PyramidGrid.model_validate(await pyramid_grid(state.endpoints, state.catalog))


@router.get("/scopes")
async def scopes(state: State) -> list[CatalogScopeRow]:
    """Which scopes hold data locally, and how much."""
    return [CatalogScopeRow.model_validate(r) for r in await state.queries.synced_tuples()]


# --- reading --------------------------------------------------------------


@router.get("/counts")
async def counts(scope: Scope, state: State) -> CatalogCounts:
    """Datasets / categories / subcategories / fields for one scope."""
    return CatalogCounts.model_validate(await state.queries.counts(scope))


@router.get("/size")
async def size(state: State) -> CatalogSize:
    """How much the catalog's data actually takes up."""
    return CatalogSize(used_bytes=await state.catalog.used_bytes())


@router.get("/stats")
async def stats(scope: Scope, state: State) -> CatalogStats:
    """Value ranges, so filter controls can bound themselves to real data."""
    return CatalogStats.model_validate(await state.queries.stats(scope))


#: Module-level singleton so the default is not rebuilt per request.
DEFAULT_FIELD_FILTER = FieldFilter()


@router.post("/fields")
async def fields(
    scope: Scope,
    state: State,
    filters: Annotated[FieldFilter, Body()] = DEFAULT_FIELD_FILTER,
) -> FieldPage:
    """Filtered, sorted, paginated data fields.

    POST rather than GET because the filter set is large and structured; the operation
    is still a pure read.
    """
    return FieldPage.model_validate(await state.queries.fields(scope, filters))


@router.post("/facets")
async def facets(
    scope: Scope,
    state: State,
    filters: Annotated[FieldFilter, Body()] = DEFAULT_FIELD_FILTER,
) -> CatalogFacets:
    """Categories / subcategories / datasets / types with counts under the other filters."""
    return CatalogFacets.model_validate(await state.queries.facets(scope, filters))


@router.get("/fields/{field_id}")
async def field_detail(field_id: str, scope: Scope, state: State) -> DataFieldDetail:
    row = await state.queries.field(scope, field_id)
    if row is None:
        raise HTTPException(404, f"{field_id} is not in the catalog for {scope.label}")
    return DataFieldDetail.model_validate(row)


@router.get("/fields/{field_id}/availability")
async def field_availability(field_id: str, state: State) -> list[FieldAvailabilityRow]:
    """Every scope this field exists in.

    Not every field is available in every region/delay/universe, so this is the check
    that stops a template being expanded into simulations that cannot run.
    """
    return [
        FieldAvailabilityRow.model_validate(r)
        for r in await state.queries.field_availability(field_id)
    ]


@router.get("/datasets")
async def datasets(scope: Scope, state: State) -> list[DatasetRow]:
    return [DatasetRow.model_validate(r) for r in await state.queries.datasets(scope)]
