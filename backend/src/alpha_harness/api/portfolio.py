"""Portfolio: submitted Alphas combined at equal weight, as BRAIN combines its own pool."""

import asyncio
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..schemas import Out
from ..tools import portfolio
from ..vault.store import json_list
from .deps import State, refuse

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])

Investability = Literal["max_trade", "max_position", "none"]


class PortfolioMember(Out):
    alpha_id: str
    name: str | None
    region: str | None
    delay: int | None
    universe: str | None
    #: How the Alpha is held to its instruments' liquidity. BRAIN refuses Max Trade and Max
    #: Position both ON, so one of three.
    investability: Investability
    tags: list[str]
    #: BRAIN's names, e.g. "Power Pool Alpha".
    classifications: list[str]
    #: e.g. "ASI/D1/OTHER": region, delay and the data category the Pyramid pays on.
    pyramids: list[str]
    categories: list[str]
    #: ``False`` until a sync has read the Alpha's classifications and pyramids.
    labelled: bool
    #: BRAIN's own figures for the Alpha, as it reported them. The combination of several
    #: Alphas is worked out here because BRAIN does not publish one; a single Alpha's is not.
    sharpe: float | None
    turnover: float | None
    fitness: float | None
    returns: float | None
    drawdown: float | None
    margin: float | None
    has_series: bool


class PortfolioMembers(Out):
    members: list[PortfolioMember]


class PortfolioStats(Out):
    pnl: float
    returns: float
    turnover: float
    drawdown: float
    margin: float
    sharpe: float | None
    fitness: float | None
    days: int


class Windows(Out):
    in_sample: PortfolioStats | None
    train: PortfolioStats | None
    test: PortfolioStats | None


class YearRow(PortfolioStats):
    year: int


class Period(Out):
    start: str
    end: str


class Periods(Out):
    in_sample: Period
    train: Period | None
    test: Period | None


class CorrelatedPair(Out):
    a: str
    b: str
    correlation: float


class PortfolioResult(Out):
    alphas: int
    #: Asked for but with no PnL and turnover stored; a sync downloads them.
    missing: list[str]
    ids: list[str]
    test_start: str | None
    periods: Periods | None
    stats: Windows | None
    after_cost: Windows | None
    yearly: list[YearRow]
    dates: list[str]
    curve: list[float]
    after_cost_curve: list[float]
    #: Pairwise daily PnL correlation in ``ids`` order; ``None`` where too few days overlap.
    #: Empty past ``tools.portfolio.GRID_LIMIT`` Alphas, where ``top_pairs`` stands in for it.
    correlation: list[list[float | None]]
    #: The most correlated pairs, highest first, when the grid is too large to send.
    top_pairs: list[CorrelatedPair]
    #: Pairs sharing enough days to be measured.
    measured_pairs: int
    highest: CorrelatedPair | None
    #: Why a series is missing, when the single-Alpha route tried to download one and could
    #: not. Null everywhere else: on this page a missing series is listed in ``missing``.
    problem: str | None = None


class PortfolioRequest(BaseModel):
    alpha_ids: list[str] = Field(min_length=1, max_length=2000)
    cost_bps: float = Field(default=5.0, ge=0, le=100)


def _investability(row: dict[str, Any]) -> Investability:
    if row.get("max_trade") == "ON":
        return "max_trade"
    if row.get("max_position") == "ON":
        return "max_position"
    return "none"


class PortfolioSyncStarted(Out):
    task_id: str


@router.get("/members")
async def members(state: State) -> PortfolioMembers:
    """Every submitted Alpha stored locally."""
    rows = await state.alphas.submitted_members()
    out: list[PortfolioMember] = []
    for r in rows:
        pyramids = json_list(r["pyramids"])
        out.append(
            PortfolioMember(
                alpha_id=str(r["alpha_id"]),
                name=r["name"],
                region=r["region"],
                delay=r["delay"],
                universe=r["universe"],
                investability=_investability(r),
                tags=json_list(r["tags"]),
                classifications=json_list(r["classifications"]),
                pyramids=pyramids,
                categories=sorted({p.rsplit("/", 1)[-1] for p in pyramids}),
                labelled=r["pyramids"] is not None,
                sharpe=r["sharpe"],
                turnover=r["turnover"],
                fitness=r["fitness"],
                returns=r["returns"],
                drawdown=r["drawdown"],
                margin=r["margin"],
                has_series=bool(r["has_series"]),
            )
        )
    return PortfolioMembers(members=out)


@router.post("/sync")
async def sync(state: State) -> PortfolioSyncStarted:
    """Refresh the submitted Alphas from BRAIN and download the PnL and turnover of any not
    stored yet. Nothing else is listed."""
    try:
        return PortfolioSyncStarted(task_id=await state.backfill.start_submitted())
    except RuntimeError as exc:
        raise refuse(409, "already_running", str(exc)) from exc


@router.post("/compute")
async def compute(body: PortfolioRequest, state: State) -> PortfolioResult:
    """These Alphas combined at equal weight: stats, yearly rows, partitions, correlations."""
    ids = list(dict.fromkeys(body.alpha_ids))
    series = await state.alphas.series(ids)
    missing = [a for a in ids if a not in series]
    meta = await state.alphas.by_ids(ids)
    found = await asyncio.to_thread(portfolio.compute, series, meta, ids, body.cost_bps)
    return PortfolioResult.model_validate(found | {"missing": missing})
