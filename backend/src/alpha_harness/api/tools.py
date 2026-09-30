"""Tools: helpers that act on an Alpha the consultant already has.

The Settings Sampler re-runs one proven expression everywhere BRAIN will accept it. The
Correlation Breaker does the opposite — it holds the settings still and re-shapes the
expression, for an Alpha the platform says is already in the production pool. The
Submission Planner then decides which of the results are worth submitting, and in what order.
Neither simulates on its own: previews only read, and queueing hands work to the scheduler
like any lab.
"""

import asyncio
import json
from typing import Any, Literal, Self

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, select

from ..db.models import Submission, Trial, TrialState, utcnow
from ..engine.packer import MAX_BATCH
from ..engine.slots import DEFAULT_SLOTS
from ..labs.launch import AddedTask, add_study
from ..labs.params import CORRELATION_BREAKER, SETTINGS_SAMPLER, BreakerParams, SettingsParams
from ..schemas import Out
from ..tools import correlation_breaker, settings_sampler, submission_planner
from ..vault.yields import checks_of, verdict
from .deps import State, refuse
from .vault import AlphaSettings

router = APIRouter(prefix="/api/tools", tags=["tools"])


class Pair(Out):
    max_trade: str
    max_position: str


class MarketRow(Out):
    region: str
    delay: int
    universe: str
    #: Of the thinnest data field the expression reads. BRAIN sometimes reports zero for
    #: markets that simulate fine (DEU, GBR), so it is shown, never used to exclude.
    coverage: float
    #: Simulations this market is worth: its neutralizations times its legal pairs.
    total: int


class RegionPlan(Out):
    region: str
    delays: list[int]
    universes: list[str]
    neutralizations: list[str]
    pairs: list[Pair]
    #: Whether BRAIN accepts Max Position here, measured rather than assumed.
    position_available: bool
    markets: list[MarketRow]
    total: int


class PlanTotals(Out):
    total: int
    batches: int


class SourceSettings(Out):
    region: str | None
    universe: str | None
    delay: int | None
    neutralization: str | None
    decay: int | None
    truncation: float | None
    nan_handling: str
    test_period: str
    max_trade: str
    max_position: str


class SettingsPlan(Out):
    alpha_id: str
    expression: str
    data_fields: list[str]
    #: Read by the expression but not counted as data by BRAIN, e.g. ``industry``.
    grouping_fields: list[str]
    settings: SourceSettings
    regions: list[RegionPlan]
    totals: PlanTotals
    #: Most concurrent slots one task may hold: the engine's own, so a lone sweep can use it all.
    max_cores: int
    problems: list[str]
    warnings: list[str]


class PreviewRequest(BaseModel):
    """An Alpha to read, or a bare expression with the decay and truncation to hold it at."""

    alpha_id: str = Field(default="", max_length=64, alias="alphaId")
    expression: str | None = Field(default=None, max_length=20_000)
    #: Each one left out keeps the source Alpha's own value, or the platform default when
    #: there is no Alpha.
    decay: int | None = Field(default=None, ge=0, le=512)
    truncation: float | None = Field(default=None, ge=0, le=1)
    nan_handling: Literal["ON", "OFF"] | None = Field(default=None, alias="nanHandling")
    #: ``P{years}Y{months}M0D``, the shape BRAIN's own field takes; its bounds are
    #: ``P0Y0M0D`` to ``P6Y0M0D``.
    test_period: str | None = Field(
        default=None, alias="testPeriod", pattern=r"^P[0-6]Y(?:[0-9]|1[01])M0D$"
    )

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _one_source(self) -> Self:
        if bool(self.alpha_id.strip()) == bool((self.expression or "").strip()):
            raise ValueError("Give either an Alpha ID or an expression.")
        return self

    async def plan(self, state: Any) -> dict[str, Any]:
        return await settings_sampler.plan(
            state,
            self.alpha_id.strip(),
            expression=self.expression.strip() if self.expression else None,
            decay=self.decay,
            truncation=self.truncation,
            nan_handling=self.nan_handling,
            test_period=self.test_period,
        )


class MarketPick(BaseModel):
    region: str
    delay: int
    universe: str


class PairPick(BaseModel):
    max_trade: Literal["ON", "OFF"] = Field(alias="maxTrade")
    max_position: Literal["ON", "OFF"] = Field(alias="maxPosition")

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _one_at_most(self) -> Self:
        # BRAIN refuses the pair outright; catching it here costs no round trip.
        if self.max_trade == "ON" and self.max_position == "ON":
            raise ValueError("Max Trade and Max Position cannot both be ON.")
        return self


class SampleRequest(PreviewRequest):
    """What to queue. An empty list means "everything the plan offers"."""

    markets: list[MarketPick] = Field(default_factory=list, max_length=500)
    neutralizations: list[str] = Field(default_factory=list, max_length=50)
    pairs: list[PairPick] = Field(default_factory=list, max_length=4)
    #: Bounded by the engine rather than by ``search.MAX_CORES``, which is the labs' own cap.
    #: The real ceiling is the engine's slot count, checked in the route where it is known.
    cores: int = Field(default=DEFAULT_SLOTS, ge=1)
    #: Drop the one combination that is not market neutral -- ``NONE`` neutralization with
    #: neither Max Trade nor Max Position. On by default: those simulations cost the same as
    #: any other and produce an Alpha carrying the market's own direction.
    market_neutral_only: bool = Field(default=True, alias="marketNeutralOnly")


@router.post("/settings-sampler/preview")
async def preview(body: PreviewRequest, state: State) -> SettingsPlan:
    """Where one Alpha's expression could also run, and what that would cost.

    Reads the Alpha from BRAIN rather than the vault, because the vault stores no
    maxTrade/maxPosition and may not hold the Alpha at all.
    """
    found = await body.plan(state)
    return SettingsPlan.model_validate({**found, "maxCores": state.engine.slots})


@router.post("/settings-sampler/tasks", status_code=201)
async def add_task(body: SampleRequest, state: State) -> AddedTask:
    """Add the chosen settings as a background task."""
    if body.cores > state.engine.slots:
        raise refuse(
            422,
            "too_many_cores",
            f"The engine has {state.engine.slots} slots, so a task cannot hold {body.cores}.",
        )
    found = await body.plan(state)
    if found["problems"]:
        raise refuse(422, "settings_sampler_blocked", found["problems"][0])

    chosen = {(m.region, m.delay, m.universe) for m in body.markets}
    source: dict[str, Any] = {**found["settings"], "expression": found["expression"]}
    requests = settings_sampler.expand(
        found["regions"],
        chosen,
        set(body.neutralizations),
        {(p.max_trade, p.max_position) for p in body.pairs},
        source,
        market_neutral_only=body.market_neutral_only,
    )
    if not requests:
        raise refuse(
            422,
            "no_simulations",
            "Nothing to run: choose a market, a neutralization and a "
            "Max Trade / Max Position pair.",
        )

    markets = len(chosen) or sum(len(r["markets"]) for r in found["regions"])
    return await add_study(
        state,
        now=utcnow(),
        sampler=SETTINGS_SAMPLER,
        params=SettingsParams(
            region=str(found["settings"]["region"] or ""),
            delay=int(found["settings"]["delay"] or 0),
            alpha_id=body.alpha_id,
            markets=markets,
            decay=int(found["settings"]["decay"] or 0),
            truncation=float(found["settings"]["truncation"] or 0.08),
            nan_handling=str(found["settings"]["nanHandling"] or "ON"),
            test_period=str(found["settings"]["testPeriod"] or ""),
            cores=body.cores,
        ),
        simulations=len(requests),
        # One batch more than the cores can run, so a finished batch is replaced from the
        # queue on the engine's next 2s tick instead of waiting out the scheduler's 5s poll.
        # Measured: without the spare, 29% of this task's slot-time sat idle.
        batch_size=(body.cores + 1) * MAX_BATCH,
        template_source=found["expression"],
        template_name=f"Settings Sampler · {body.alpha_id or 'Expression'}",
        seeds=settings_sampler.seed_trials(requests, has_source=bool(body.alpha_id)),
    )


# -- Submission Planner ---------------------------------------------------


class Pick(Out):
    alpha_id: str
    #: On its own, over the whole history. The portfolio beats every one of these.
    sharpe: float
    #: Already submitted on BRAIN, so it is carried rather than chosen.
    submitted: bool


class PlannedPortfolio(Out):
    #: Submittable Alphas the chosen tasks produced.
    candidates: int
    #: Of those, already submitted.
    locked: int
    #: Chosen but with no stored daily PnL, so they could not be judged.
    missing: list[str]
    size: int
    #: Submit in this order, strongest first.
    order: list[Pick]
    #: Combined Sharpe at each size over the training window; the peak sets ``size``.
    sizes: list[float]
    train_sharpe: float
    #: The same portfolio over the last fifth of history, which the search never saw.
    held_out_sharpe: float
    #: Combined Sharpe over the whole history.
    sharpe: float
    best_single: float
    #: ``None`` when no pair shared enough history to measure, which is not the same as zero.
    max_correlation: float | None
    #: The two Alphas that collision is between, empty when there is nothing to measure.
    worst_pair: list[str]
    #: Whether that pair is over the ceiling and admitted by BRAIN's 10% Sharpe rule.
    escape_used: bool
    days: int
    curve: list[float]
    dates: list[str]


class PlanRequest(BaseModel):
    # The screen plans over every task by default, and an account passes 50 within weeks. The
    # ids only fill an IN list, so the bound is SQLite's 32,766 parameters, not the search.
    task_ids: list[int] = Field(min_length=1, max_length=10_000, alias="taskIds")

    model_config = {"populate_by_name": True}


class SubmittedRequest(BaseModel):
    alpha_id: str = Field(min_length=1, max_length=64, alias="alphaId")
    submitted: bool

    model_config = {"populate_by_name": True}


async def _candidates(state: State, task_ids: list[int]) -> tuple[list[str], set[str], int]:
    """Every submittable Alpha those tasks produced, which are marked submitted, and how many
    BRAIN has not finished judging.

    Reads the frozen ``Trial.result`` rather than the vault: that is where a task's own view
    of its Alphas lives, and it is what the Tasks screen already shows.

    Judged the vault's way, not the Tasks screen's. ``labs.study.submittable`` answers "has
    anything refused this yet", which is right for a list that fills in as checks resolve --
    but a submission is permanent, and a check still ``PENDING`` is not agreement. So the
    strict reading is used here, and the ones still being judged are counted rather than
    dropped, because "not submittable" and "not judged yet" are different news.
    """
    async with state.db.session() as session:
        # Two columns, not whole rows: a sweep's trials carry their expression, settings and
        # distributions, and none of that is read here.
        rows = (
            await session.execute(
                select(Trial.alpha_id, Trial.result).where(
                    Trial.study_id.in_(task_ids),
                    Trial.state == TrialState.COMPLETE,
                    Trial.alpha_id.is_not(None),
                )
            )
        ).all()
        marked = {str(a) for a in (await session.scalars(select(Submission.alpha_id))).all()}

    # The vault holds the checks BRAIN has since finished; a trial's copy is frozen at
    # simulation time, still PENDING on the correlation checks, and only stands in for an
    # Alpha the vault does not hold.
    stored = await state.alphas.by_ids(list({str(a) for a, _ in rows}))
    found: list[str] = []
    seen: set[str] = set()
    pending = 0
    for alpha_id, result in rows:
        found_id = str(alpha_id)
        if found_id in seen:
            continue
        seen.add(found_id)
        row = stored.get(found_id) or {}
        checks = row.get("checks") or json.dumps((result or {}).get("checks") or [])
        judged = verdict(checks_of(checks), row.get("simulation_mode"))
        if judged == "submittable":
            found.append(found_id)
        elif judged == "pending":
            pending += 1
    return found, marked, pending


@router.post("/submission-planner/plan")
async def plan_submissions(body: PlanRequest, state: State) -> PlannedPortfolio:
    """Which Alphas to submit and in what order.

    The search is a few seconds of numpy over every pair, so it runs off the event loop.
    """
    alpha_ids, marked, pending = await _candidates(state, body.task_ids)
    if not alpha_ids:
        raise refuse(
            422,
            "no_candidates",
            f"BRAIN is still checking {pending} of those Alphas. Nothing is refused yet, so "
            "try again once the checks resolve."
            if pending
            else "Those tasks produced no submittable Alphas, so there is nothing to plan.",
        )
    # Every submission on the account, not just the ones these tasks produced. BRAIN measures
    # the ceiling against all of them, so a plan that ignores one is a plan it will refuse.
    locked_ids = sorted(marked)
    days = await state.alphas.daily_pnl(list(dict.fromkeys([*alpha_ids, *locked_ids])))
    found = await asyncio.to_thread(submission_planner.plan, days, alpha_ids, locked_ids=locked_ids)
    if not found["size"]:
        raise refuse(422, *_why(found, len(alpha_ids)))
    return PlannedPortfolio.model_validate(found)


def _why(found: dict[str, Any], candidates: int) -> tuple[str, str]:
    """Why no plan came back. Every one of these used to read as "nothing to plan yet"."""
    match found.get("reason"):
        case "short_history":
            return (
                "short_history",
                f"These Alphas share {found.get('days', 0)} trading days of PnL. Judging a "
                "portfolio needs 1250 -- a thousand to choose its size on and 250 held back to "
                "check that size against.",
            )
        case "nothing_legal":
            return (
                "nothing_legal",
                "Every candidate correlates at 0.50 or above with an Alpha you have already "
                "submitted, and none beats the one it collides with by the 10% BRAIN wants.",
            )
        case _:
            return (
                "too_few",
                f"{candidates} Alphas had stored daily PnL, and a portfolio needs at least two. "
                "Download their PnL in the Pool first.",
            )


@router.post("/submission-planner/submitted", status_code=204)
async def mark_submitted(body: SubmittedRequest, state: State) -> None:
    """Record that an Alpha was submitted on BRAIN, so later plans treat it as permanent."""
    async with state.db.session() as session:
        if body.submitted:
            await session.merge(Submission(alpha_id=body.alpha_id, submitted_at=utcnow()))
        else:
            await session.execute(delete(Submission).where(Submission.alpha_id == body.alpha_id))
        await session.commit()


# --- Correlation Breaker ----------------------------------------------------


class BreakerRecipe(Out):
    id: str
    name: str
    why: str
    #: What it costs, when it costs something worth knowing before running it.
    caution: str
    #: Only the re-shape, written against ``alpha``; the binding is shown once, above.
    transform: str
    #: Why it cannot run here, empty when it can.
    blocked: str
    #: The whole program, counted the way Power Pool counts it.
    operators: int
    data_fields: int
    #: For a Power Pool Alpha, the limit this re-shape would cross; empty when none is.
    over_power_pool: str


class BreakerPlan(Out):
    alpha_id: str
    expression: str
    #: The source Alpha reduced to ``alpha``, shown once above the re-shapes.
    bound: str
    #: What every simulation runs at: the source Alpha's own, never varied.
    settings: AlphaSettings
    #: BRAIN's own production-correlation check, as it last reported it.
    correlation: dict[str, Any] | None
    #: BRAIN judges it as a Power Pool Alpha, so its re-shapes are held to the pool's limits.
    power_pool: bool
    #: The source expression's own counts; null when it could not be read.
    operators: int | None
    data_fields: int | None
    recipes: list[BreakerRecipe]
    problems: list[str]


class BreakerRequest(BaseModel):
    alpha_id: str = Field(min_length=1, max_length=64, alias="alphaId")
    #: Which recipes to run; empty means every one the plan offers.
    recipes: list[str] = Field(default_factory=list, max_length=50)
    cores: int = Field(default=DEFAULT_SLOTS, ge=1)

    model_config = {"populate_by_name": True}


@router.post("/correlation-breaker/preview")
async def breaker_preview(body: BreakerRequest, state: State) -> BreakerPlan:
    """The Alpha, the settings its re-shapes will hold, and every recipe's expression.

    Free: reads the Alpha and the catalog, simulates nothing.
    """
    return BreakerPlan.model_validate(await correlation_breaker.plan(state, body.alpha_id.strip()))


@router.post("/correlation-breaker/tasks")
async def breaker_task(body: BreakerRequest, state: State) -> AddedTask:
    """Queue one simulation per chosen recipe, every one at the Alpha's own settings."""
    if body.cores > state.engine.slots:
        raise refuse(
            422,
            "too_many_cores",
            f"The engine has {state.engine.slots} slots, so a task cannot hold {body.cores}.",
        )
    found = await correlation_breaker.plan(state, body.alpha_id.strip())
    if found["problems"]:
        raise refuse(422, "correlation_breaker_blocked", found["problems"][0])

    wanted = set(body.recipes)
    # A recipe the plan marked blocked is never queued, whether or not it was asked for.
    runnable = {r["id"] for r in found["recipes"] if not r["blocked"]}
    chosen = [r for r in found["recipeSet"] if r.id in runnable and (not wanted or r.id in wanted)]
    if not chosen:
        raise refuse(
            422,
            "no_simulations",
            "Nothing to run: every chosen re-shape needs an operator or a field this market "
            "does not have.",
        )

    compressed = correlation_breaker.compress(found["expression"])
    requests = correlation_breaker.requests(compressed, chosen, found["rawSettings"])
    settings = found["settings"]
    return await add_study(
        state,
        now=utcnow(),
        sampler=CORRELATION_BREAKER,
        params=BreakerParams(
            region=str(settings["region"] or ""),
            delay=int(settings["delay"] or 0),
            alpha_id=body.alpha_id,
            universe=str(settings["universe"] or ""),
            neutralization=str(settings["neutralization"] or ""),
            decay=int(settings["decay"] or 0),
            truncation=float(settings["truncation"] or 0.08),
            recipes=[r.id for r in chosen],
            cores=body.cores,
        ),
        simulations=len(requests),
        batch_size=(body.cores + 1) * MAX_BATCH,
        template_source=found["expression"],
        template_name=f"Correlation Breaker · {body.alpha_id}",
        seeds=settings_sampler.seed_trials(requests, has_source=False),
    )
