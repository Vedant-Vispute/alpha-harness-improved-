"""The alpha pool on BRAIN: summary, the Alpha page, check, correlate, edit properties.

**There is no submit endpoint, deliberately.** Submitting an alpha is irreversible, so the
guard against doing it by accident is that no route, service or client wrapper for it
exists. Correlations are slow, rate-limited jobs, so their answers are kept in
``brain_cache`` until the user refreshes.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field, RootModel
from sqlalchemy import delete, func, select

from ..brain.errors import BrainError
from ..db.models import BrainCache, SimulationRecord, Study, Trial, TrialState, utcnow
from ..labs.fastexpr import ParseError, data_fields, operator_count, operator_names, parse
from ..labs.params import TASK_SAMPLERS
from ..schemas import Out
from ..tools import portfolio
from ..vault.yields import (
    PLATFORM_ALPHA_URL,
    Verdict,
    checks_of,
    verdict,
    without_quota_checks,
)
from .deps import State
from .portfolio import PortfolioResult

router = APIRouter(prefix="/api/alphas", tags=["alphas"])

CorrelationKind = Literal["self", "prod", "power-pool"]
Refresh = Annotated[bool, Query(description="Ask BRAIN again instead of reading the cache.")]
CachedOnly = Annotated[
    bool, Query(description="Answer only from the cache; never spend BRAIN's budget.")
]


class BrainPayload(RootModel[dict[str, Any]]):
    """BRAIN's own JSON, passed through as the platform sent it."""


class AlphaStats(Out):
    pnl: float | None = None
    book_size: float | None = None
    long_count: int | None = None
    short_count: int | None = None
    turnover: float | None = None
    returns: float | None = None
    drawdown: float | None = None
    margin: float | None = None
    sharpe: float | None = None
    fitness: float | None = None


class AlphaYear(AlphaStats):
    year: str
    stage: str | None = None


class AlphaClassification(Out):
    id: str
    name: str


class AlphaInfo(Out):
    alpha_id: str
    type: str | None
    author: str | None
    code: str | None
    description: str | None
    operator_count: int | None
    name: str | None
    category: str | None
    color: str | None
    tags: list[str]
    stage: str | None
    status: str | None
    date_created: str | None
    date_submitted: str | None
    date_modified: str | None
    #: Every simulation setting BRAIN reports, as it named them.
    settings: dict[str, Any]
    classifications: list[AlphaClassification]
    in_sample: AlphaStats | None
    investability: AlphaStats | None
    #: BRAIN's checks as sent, extras included (pyramids, themes, competitions).
    checks: list[dict[str, Any]]
    brain_url: str
    #: Operators as Power Pool counts them (backfills excluded); null when the code is unreadable.
    power_pool_operators: int | None
    #: Distinct data fields, grouping fields excluded; null when the code is unreadable.
    data_fields: list[str] | None
    #: Operators called, once each, for the Power Pool description template.
    operators: list[str] | None
    #: ``vault.yields.verdict`` on its checks: the same rule the Planner and Tasks use.
    verdict: Verdict | None


class LineageSibling(Out):
    alpha_id: str
    expression: str | None
    value: float | None


class AlphaLineage(Out):
    task: str
    lab: str | None
    lab_name: str | None
    study_id: int | None
    study_name: str | None
    template_name: str | None
    #: What the user named the task, if anything.
    task_name: str | None = None
    #: What the lab chose for this Alpha: its dataset, template variables, generation.
    params: dict[str, Any]
    generation: int | None
    simulated_at: str | None
    #: The task's best other Alphas on what it searches for.
    siblings: list[LineageSibling]


class AlphaView(Out):
    alpha: AlphaInfo
    dates: list[str]
    #: Cumulative, one per trading day.
    pnl: list[float | None]
    investability_pnl: list[float | None]
    #: First day of the held-out test years, as BRAIN reports it; ``None`` without a test period.
    test_start: str | None
    yearly: list[AlphaYear]
    lineage: AlphaLineage | None
    #: When the Alpha itself was last read from BRAIN; series are kept until refreshed.
    fetched_at: str
    #: Anything that could not be loaded, said plainly.
    problems: list[str]


class AlphaProperties(BaseModel):
    name: str | None = None
    category: str | None = None
    color: str | None = None
    tags: list[str] = Field(default_factory=list)
    description: str | None = None


# -- cache ---------------------------------------------------------------


type Fetch = Callable[[], Awaitable[dict[str, Any]]]


async def _stored(state: State, key: str) -> BrainCache | None:
    async with state.db.session() as session:
        return await session.get(BrainCache, key)


async def _store(state: State, key: str, body: dict[str, Any]) -> datetime:
    now = utcnow()
    async with state.db.session() as session:
        await session.merge(BrainCache(key=key, body=body, fetched_at=now))
    return now


async def _forget(state: State, *keys: str) -> None:
    async with state.db.session() as session:
        await session.execute(delete(BrainCache).where(BrainCache.key.in_(keys)))


async def _cached(
    state: State, key: str, fetch: Fetch, *, refresh: bool
) -> tuple[dict[str, Any], datetime]:
    """A cached BRAIN answer, fetched and stored when missing or when ``refresh``."""
    if not refresh and (row := await _stored(state, key)) is not None:
        return row.body, row.fetched_at
    body = await fetch()
    return body, await _store(state, key, body)


def _copy(row: BrainCache) -> str:
    # Stored in UTC; unlabelled it read as local.
    return f"showing the copy from {row.fetched_at:%b %d, %H:%M} UTC."


async def _cached_or_stale(
    state: State, key: str, fetch: Fetch, *, refresh: bool, what: str, problems: list[str]
) -> dict[str, Any]:
    """:func:`_cached`, falling back to the last copy (or ``{}``) when BRAIN fails, with the
    reason added to ``problems``."""
    try:
        return (await _cached(state, key, fetch, refresh=refresh))[0]
    except BrainError as exc:
        stale = await _stored(state, key)
        if stale is None:
            problems.append(f"The {what} could not be loaded: {exc.message}")
            return {}
        problems.append(f"The {what} could not be refreshed ({exc.message}); {_copy(stale)}")
        return stale.body


async def _kept(
    state: State, key: str, fetch: Fetch, *, refresh: bool, cached_only: bool
) -> BrainPayload:
    """A kept answer stamped with ``fetchedAt``, or ``{"cached": false}`` when ``cached_only``
    finds none."""
    if cached_only:
        row = await _stored(state, key)
        if row is None:
            return BrainPayload({"cached": False})
        body, fetched = row.body, row.fetched_at
    else:
        body, fetched = await _cached(state, key, fetch, refresh=refresh)
    return BrainPayload(body | {"cached": True, "fetchedAt": fetched.isoformat()})


# -- reading BRAIN's shapes ---------------------------------------------------


def _stats(raw: Any) -> AlphaStats | None:
    return AlphaStats.model_validate(raw) if isinstance(raw, dict) else None


def _power_pool_counts(code: Any) -> tuple[int | None, list[str] | None, list[str] | None]:
    """Operators and data fields the way Power Pool counts them, from the expression itself."""
    try:
        tree = parse(code) if isinstance(code, str) else None
    except ParseError:
        tree = None
    if tree is None:
        return None, None, None
    return operator_count(tree), data_fields(tree), operator_names(tree)


def _info(alpha_id: str, body: dict[str, Any]) -> AlphaInfo:
    code = body.get("regular") or body.get("combo") or body.get("selection") or {}
    sample = body.get("is") or {}
    settings = body.get("settings") or {}
    counted, fields, operators = _power_pool_counts(code.get("code"))
    # BRAIN sends the day's submission quota alongside the Alpha's own checks; it says
    # nothing about the Alpha and resets tomorrow, so it is dropped here as everywhere.
    checks = without_quota_checks([c for c in sample.get("checks") or [] if isinstance(c, dict)])
    return AlphaInfo(
        alpha_id=alpha_id,
        type=body.get("type"),
        author=body.get("author"),
        code=code.get("code"),
        description=code.get("description"),
        operator_count=code.get("operatorCount"),
        name=body.get("name"),
        category=body.get("category"),
        color=body.get("color"),
        tags=[t for t in body.get("tags") or [] if isinstance(t, str)],
        stage=body.get("stage"),
        status=body.get("status"),
        date_created=body.get("dateCreated"),
        date_submitted=body.get("dateSubmitted"),
        date_modified=body.get("dateModified"),
        settings=settings,
        classifications=[
            AlphaClassification.model_validate(c)
            for c in body.get("classifications") or []
            if isinstance(c, dict) and c.get("id") and c.get("name")
        ],
        in_sample=_stats(sample),
        investability=_stats(sample.get("investabilityConstrained")),
        checks=checks,
        brain_url=f"{PLATFORM_ALPHA_URL}{alpha_id}",
        power_pool_operators=counted,
        data_fields=fields,
        operators=operators,
        # The mode matters as much as the checks: a quick-mode alpha is sent the performance
        # checks and none of the submission ones, so the checks alone read as "all clear".
        verdict=verdict(checks, settings.get("simulationMode")),
    )


def _columns(recordset: dict[str, Any]) -> tuple[list[str], list[list[Any]]]:
    names = [p.get("name") for p in (recordset.get("schema") or {}).get("properties") or []]
    return [str(n) for n in names], [r for r in recordset.get("records") or [] if r]


def _series(recordset: dict[str, Any]) -> tuple[list[str], list[float | None], list[float | None]]:
    names, records = _columns(recordset)
    if "date" not in names:
        return [], [], []
    at = {name: i for i, name in enumerate(names)}

    def column(name: str) -> list[float | None]:
        i = at.get(name)
        return [r[i] if i is not None and i < len(r) else None for r in records]

    return (
        [str(r[at["date"]]) for r in records],
        column("pnl"),
        column("investability-constrained-pnl"),
    )


def _yearly(recordset: dict[str, Any]) -> list[AlphaYear]:
    names, records = _columns(recordset)
    if "year" not in names:
        return []
    # By name, not by position: the records are positional against ``schema.properties``, and
    # nothing promises ``year`` stays the first of the twelve columns.
    at = names.index("year")
    return [
        AlphaYear.model_validate(dict(zip(names, r, strict=False)) | {"year": str(r[at])})
        for r in records
        if at < len(r)
    ]


async def _lineage(state: State, alpha_id: str) -> AlphaLineage | None:
    """Where this Alpha came from locally: the task, lab and choices that produced it."""
    async with state.db.session() as session:
        record = await session.scalar(
            select(SimulationRecord)
            .where(SimulationRecord.alpha_id == alpha_id)
            .order_by(SimulationRecord.id)
            .limit(1)
        )
        trial = await session.scalar(
            select(Trial).where(Trial.alpha_id == alpha_id).order_by(Trial.id).limit(1)
        )
        study = await session.get(Study, trial.study_id) if trial is not None else None
        if study is None and record is not None:
            study = await session.scalar(select(Study).where(Study.task == record.task).limit(1))
        if record is None and study is None:
            return None

        siblings: list[LineageSibling] = []
        if study is not None:
            best = func.max(func.json_extract(Trial.values, "$[0]"))
            rows = await session.execute(
                select(Trial.alpha_id, func.min(Trial.expression), best)
                .where(
                    Trial.study_id == study.id,
                    Trial.state == TrialState.COMPLETE,
                    Trial.alpha_id.is_not(None),
                    Trial.alpha_id != alpha_id,
                )
                # Trials answered from cache share an Alpha; it is one sibling.
                .group_by(Trial.alpha_id)
                .order_by(best.desc())
                .limit(5)
            )
            siblings = [
                LineageSibling(alpha_id=a, expression=e, value=float(v) if v is not None else None)
                for a, e, v in rows.tuples()
                if a
            ]

    sent = record.submitted_at if record is not None else None
    return AlphaLineage(
        task=study.task if study is not None else record.task if record is not None else "",
        lab=study.sampler if study is not None else None,
        lab_name=TASK_SAMPLERS.get(study.sampler) if study is not None else None,
        study_id=study.id if study is not None else None,
        study_name=study.name if study is not None else None,
        template_name=study.template_name if study is not None else None,
        task_name=study.label if study is not None else None,
        params=dict(trial.params or {}) if trial is not None else {},
        generation=trial.generation if trial is not None else None,
        simulated_at=sent.isoformat() if sent is not None else None,
        siblings=siblings,
    )


# -- routes --------------------------------------------------------------------


@router.get("/summary")
async def summary(state: State) -> BrainPayload:
    """Counts by stage and status — the shape of your pool at a glance."""
    return BrainPayload(await state.endpoints.alphas_summary())


@router.get("/{alpha_id}/page")
async def page(alpha_id: str, state: State, refresh: Refresh = False) -> AlphaView:
    """Everything the Alpha page shows, in one call.

    The Alpha is read from BRAIN on every open — its checks and properties change — and
    falls back to the last copy if BRAIN cannot answer. Its PnL and yearly series are fixed
    for the in-sample period, so they come from the cache unless ``refresh``.
    """
    problems: list[str] = []
    try:
        body, fetched = await _cached(
            state,
            f"alpha:{alpha_id}",
            lambda: state.endpoints.alpha_body(alpha_id),
            refresh=True,
        )
    except BrainError as exc:
        stale = await _stored(state, f"alpha:{alpha_id}")
        if stale is None:
            raise
        body, fetched = stale.body, stale.fetched_at
        problems.append(f"BRAIN did not answer ({exc.message}); {_copy(stale)}")

    # BRAIN's alpha body keeps the checks it was simulated with; ``/check`` answers land in the
    # vault instead, so its copy is the current one whenever it has one.
    stored = (await state.alphas.by_ids([alpha_id])).get(alpha_id) or {}
    if resolved := checks_of(stored.get("checks")):
        body: dict[str, Any] = {**body, "is": {**(body.get("is") or {}), "checks": resolved}}

    dates, pnl, constrained = _series(
        await _cached_or_stale(
            state,
            f"pnl:{alpha_id}",
            lambda: state.endpoints.recordset_body(alpha_id, "pnl"),
            refresh=refresh,
            what="PnL series",
            problems=problems,
        )
    )
    yearly = _yearly(
        await _cached_or_stale(
            state,
            f"yearly:{alpha_id}",
            lambda: state.endpoints.recordset_body(alpha_id, "yearly-stats"),
            refresh=refresh,
            what="yearly stats",
            problems=problems,
        )
    )

    return AlphaView(
        alpha=_info(alpha_id, body),
        dates=dates,
        pnl=pnl,
        investability_pnl=constrained,
        test_start=(body.get("test") or {}).get("startDate"),
        yearly=yearly,
        lineage=await _lineage(state, alpha_id),
        fetched_at=fetched.isoformat(),
        problems=problems,
    )


@router.get("/{alpha_id}/after-cost")
async def after_cost(
    alpha_id: str,
    state: State,
    cost_bps: Annotated[float, Query(alias="costBps", ge=0, le=100)] = 5.0,
) -> PortfolioResult:
    """This Alpha's PnL, gross and after a trading cost of ``costBps`` on every dollar traded.

    The cost is charged per day against *that day's* turnover and the statistics are then
    computed from the resulting series — never the gross mean with an average cost subtracted.
    The two differ: turnover is not constant, so a cost changes the volatility of the series
    and not only its mean, and a Sharpe taken from ``mean - c * turnover`` over the gross
    standard deviation flatters a high-turnover Alpha.

    It is the Portfolio page's own arithmetic over a book of one, so an Alpha reads the same
    on both screens. Its daily turnover is downloaded the first time, since the cost of a day
    cannot be known without it.
    """
    problem: str | None = None
    if await state.alphas.lacking_series([alpha_id]):
        try:
            await state.backfill.fetch_returns(alpha_id)
        # Reported rather than raised: the panel says why it is empty instead of vanishing.
        except Exception as exc:  # noqa: BLE001
            problem = f"Could not download the daily turnover: {exc}"
    series = await state.alphas.series([alpha_id])
    meta = await state.alphas.by_ids([alpha_id])
    found = await asyncio.to_thread(portfolio.compute, series, meta, [alpha_id], cost_bps)
    return PortfolioResult.model_validate(
        found | {"missing": [] if series else [alpha_id], "problem": problem}
    )


@router.patch("/{alpha_id}")
async def update_properties(alpha_id: str, body: AlphaProperties, state: State) -> AlphaInfo:
    """Save the Alpha's name, category, colour, tags and description on BRAIN.

    Normalised the way the platform's own client sends them: a blank or ``NONE`` colour,
    a blank name or category become null; an empty description is left out.
    """
    blank = lambda v: v if v and v.strip() and v != "NONE" else None  # noqa: E731
    patch: dict[str, Any] = {
        "name": blank(body.name),
        "category": blank(body.category),
        "color": blank(body.color),
        "tags": [t.strip() for t in body.tags if t.strip()],
    }
    if body.description and body.description.strip():
        patch["regular"] = {"description": body.description}
    updated = await state.endpoints.update_alpha(alpha_id, patch)
    if not updated.get("id"):
        updated = await state.endpoints.alpha_body(alpha_id)
    await _store(state, f"alpha:{alpha_id}", updated)
    return _info(alpha_id, updated)


@router.get("/{alpha_id}/check")
async def check_alpha(alpha_id: str, state: State) -> BrainPayload:
    """Re-run the submission checks without submitting.

    Changes nothing on the platform. It does update the local copy, so an alpha that has
    just resolved appears on the submit screen without waiting for the next backfill.
    """
    body = await state.endpoints.check_alpha(alpha_id)
    checks = ((body.get("is") or {}).get("checks")) or []
    if checks:
        await state.alphas.save_checks(alpha_id, checks)
    await _forget(state, f"alpha:{alpha_id}")
    return BrainPayload(body)


@router.get("/{alpha_id}/correlations/{kind}")
async def correlations(
    alpha_id: str,
    kind: CorrelationKind,
    state: State,
    refresh: Refresh = False,
    cached_only: CachedOnly = False,
) -> BrainPayload:
    """Correlation against your own submitted Alphas, the Power Pool, or production.

    A slow, rate-limited job, so the answer is kept and returned with ``fetchedAt``; only
    ``refresh`` asks BRAIN again. ``cachedOnly`` answers ``{"cached": false}`` when nothing
    is kept, so a page can show old answers without asking.
    """
    return await _kept(
        state,
        f"correlation:{kind}:{alpha_id}",
        lambda: state.endpoints.correlations(alpha_id, kind),
        refresh=refresh,
        cached_only=cached_only,
    )


@router.get("/{alpha_id}/performance")
async def performance(
    alpha_id: str, state: State, refresh: Refresh = False, cached_only: CachedOnly = False
) -> BrainPayload:
    """Your pool's stats before and after this Alpha joins it, kept until refreshed."""
    return await _kept(
        state,
        f"performance:{alpha_id}",
        lambda: state.endpoints.before_and_after(alpha_id),
        refresh=refresh,
        cached_only=cached_only,
    )
