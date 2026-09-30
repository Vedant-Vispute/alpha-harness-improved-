"""Region Agnostic Lab: region-agnostic fields, the regions to run them in, then a task.

BRAIN runs only two region-agnostic simulations at a time. This lab runs none: the LLM writes
an expression, and it is simulated as an ordinary Alpha in each chosen region that carries all
its fields, with the same settings but the region. Those runs batch ten to a core like any
other. Nothing here calls the LLM or simulates; the preview shows the exact first prompt.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ..brain.schemas import REGION_AGNOSTIC_REGION
from ..db.models import utcnow
from ..labs import power_pool, search
from ..labs.launch import (
    MAX_PICKED_FIELDS,
    OPERATORS_UNREAD,
    AddedTask,
    account_operators,
    add_study,
    choices,
    legal_choices,
    synced_universes,
)
from ..labs.params import REGION_AGNOSTIC_SAMPLER, RegionAgnosticParams
from ..llm.registry import DEFAULT_MODEL
from ..llm.text import estimate_tokens
from ..schemas import Out
from .deps import State, refuse
from .power_pool_lab import PowerPoolModel, PowerPoolPrompt, llm_models
from .prompts import chosen

router = APIRouter(prefix="/api/region-agnostic-lab", tags=["region-agnostic-lab"])


class RegionAgnosticRequest(BaseModel):
    delay: int = Field(ge=0, le=1)
    #: The region-agnostic market's universe the fields were chosen in.
    universe: str | None = None
    #: The regions to run in, and the region-agnostic universe size that says each one's.
    regions: list[str] = Field(default_factory=list, max_length=len(power_pool.RA_MARKETS))
    size: Literal["LARGE", "MEDIUM", "SMALL"] = "LARGE"
    field_ids: list[str] = Field(default_factory=list, max_length=MAX_PICKED_FIELDS)
    dataset_ids: list[str] = Field(default_factory=list, max_length=200)
    rank_by: str | None = Field(default=None, max_length=160)
    model: str | None = None
    prompt_id: int | None = None
    #: Empty draws from every neutralization all chosen regions offer.
    neutralizations: list[str] = Field(default_factory=list, max_length=20)
    cores: int = Field(default=search.MAX_CORES, ge=1, le=search.MAX_CORES)
    simulations: int = Field(default=0, ge=0, le=search.MAX_SIMULATIONS)


class RegionChoice(Out):
    region: str
    #: BRAIN's legal universes here that are downloaded, and the one to start from.
    universes: list[str]
    default_universe: str | None
    neutralizations: list[str]


class RegionAgnosticOptions(Out):
    #: Each size's universe per region, as BRAIN maps its region-agnostic universe setting.
    sizes: dict[str, dict[str, str]]
    models: list[PowerPoolModel]
    default_model: str | None
    regions: list[RegionChoice]
    max_simulations: int


class RegionFieldCount(Out):
    region: str
    fields: int


class RegionAgnosticPreview(Out):
    fields: int
    #: How many of the fields each chosen region carries.
    per_region: list[RegionFieldCount]
    #: Fields that no two chosen regions share, which no Alpha here can use alone.
    lonely: int
    neutralizations: list[str]
    llm_calls: int
    prompt: PowerPoolPrompt | None
    problems: list[str]
    warnings: list[str]


async def _regions(state: Any, delay: int) -> list[dict[str, Any]]:
    schema = await state.metadata.cached_settings_schema()
    out = []
    for region in power_pool.RA_MARKETS:
        legal = legal_choices(schema, region, delay)
        universes = await synced_universes(state, legal, region, delay, None)
        out.append(
            {
                "region": region,
                "universes": universes,
                "defaultUniverse": universes[0] if universes else None,
                "neutralizations": [
                    str(n) for n in choices(legal, "neutralization") if n != "NONE"
                ],
            }
        )
    return out


@router.get("/options")
async def options(
    state: State, delay: Annotated[int, Query(ge=0, le=1)] = 1
) -> RegionAgnosticOptions:
    models = await llm_models(state)
    ids = [m["id"] for m in models]
    return RegionAgnosticOptions.model_validate(
        {
            "models": models,
            "defaultModel": DEFAULT_MODEL if DEFAULT_MODEL in ids else (ids[0] if ids else None),
            "sizes": power_pool.RA_UNIVERSES,
            "regions": await _regions(state, delay),
            "maxSimulations": search.MAX_SIMULATIONS,
        }
    )


async def _plan(body: RegionAgnosticRequest, state: Any) -> dict[str, Any]:
    problems: list[str] = []
    warnings: list[str] = []
    operators = await account_operators(state, refresh=False)
    if not operators:
        problems.append(OPERATORS_UNREAD)
    if not body.field_ids and not body.dataset_ids:
        problems.append(
            "Choose datasets or fields in the Data Explorer's All Regions market: tick whole "
            "datasets in More filters, or single fields in the table."
        )
    models = {m["id"]: m for m in await llm_models(state)}
    model_id = body.model or DEFAULT_MODEL
    info = state.llm.registry.get(model_id)
    if model_id not in models or info is None:
        problems.append(f"{model_id} can't run: no enabled Key for it. Add one in LLM Integration.")

    offered = {r["region"]: r for r in await _regions(state, body.delay)}
    regions = [r for r in dict.fromkeys(body.regions) if r in offered]
    if len(regions) < power_pool.MIN_REGIONS:
        problems.append(f"Choose at least {power_pool.MIN_REGIONS} regions to run in.")
    markets: dict[str, str] = {}
    for region in regions:
        universe = power_pool.RA_UNIVERSES[body.size][region]
        if universe not in offered[region]["universes"]:
            problems.append(
                f"{region} {universe} delay {body.delay} is not downloaded. Sync it in Sync with "
                "BRAIN, or leave the region out."
            )
            continue
        markets[region] = universe
    # Only what every chosen region offers: the settings are the same in each.
    shared: list[str] = []
    if markets:
        lists = [offered[r]["neutralizations"] for r in markets]
        shared = [n for n in lists[0] if all(n in other for other in lists[1:])]
    wanted = set(body.neutralizations)
    neutralizations = [n for n in shared if n in wanted] or shared
    if markets and not neutralizations:
        problems.append("The chosen regions share no neutralization. Choose other regions.")

    prompt_name, system = await chosen(state, power_pool.RA_KIND, body.prompt_id)
    if not system.strip():
        problems.append(f"“{prompt_name}” is empty. Write it in LLM Prompts, or choose another.")
    run = RegionAgnosticParams(
        region=REGION_AGNOSTIC_REGION,
        delay=body.delay,
        universe=body.universe,
        universes=list(markets.values()),
        neutralizations=neutralizations,
        regions=list(markets),
        region_universes=markets,
        field_ids=body.field_ids,
        dataset_ids=body.dataset_ids,
        rank_by=body.rank_by,
        size=body.size,
    )
    fields = 0
    per_region: list[dict[str, Any]] = []
    lonely = 0
    prompt = None
    if len(markets) >= power_pool.MIN_REGIONS and (body.field_ids or body.dataset_ids):
        ctx = await power_pool.ra_context(
            state.catalog, body.delay, markets, body.field_ids, body.rank_by, body.dataset_ids
        )
        if ctx is None:
            problems.append("None of the chosen fields is in the chosen regions' downloads.")
        else:
            fields = len(ctx.fields)
            per_region = [
                {"region": r, "fields": sum(1 for f in ctx.fields if r in ctx.held[f.id])}
                for r in markets
            ]
            lonely = sum(1 for f in ctx.fields if len(ctx.held[f.id]) < power_pool.MIN_REGIONS)
            if lonely:
                warnings.append(
                    f"{lonely:,} of the fields are in only one chosen region, so an Alpha needs "
                    "another field beside them to run anywhere twice."
                )
            left = len(set(body.field_ids)) - fields if body.field_ids else 0
            if left > 0:
                warnings.append(
                    f"{left:,} chosen fields are in none of the chosen regions, or are grouping "
                    "fields, so the LLM won't see them."
                )
            if info is not None and operators:
                user, shown = power_pool.user_prompt(
                    ctx, operators, run, "None yet.", 0, power_pool.budget_for(info), system
                )
                prompt = {
                    "name": prompt_name,
                    "system": system,
                    "user": user,
                    "tokens": estimate_tokens(system + user),
                }
                if ctx.fields and shown < min(10, len(ctx.fields)):
                    problems.append(
                        f"The prompt does not fit {info.label}'s tokens per minute. "
                        "Choose another model."
                    )
    # Each written Alpha is a simulation per region, so a call fills more of the target.
    per_call = power_pool.PER_CALL * max(1, len(markets))
    calls = -(-body.simulations // per_call)
    if model_id in models and calls > models[model_id]["remainingToday"]:
        warnings.append(
            f"About {calls:,} LLM calls; {model_id} has "
            f"{models[model_id]['remainingToday']:,} left today, "
            "so the task waits for the reset at midnight Pacific."
        )
    return {
        "fields": fields,
        "perRegion": per_region,
        "lonely": lonely,
        "neutralizations": neutralizations,
        "llmCalls": calls,
        "prompt": prompt,
        "problems": problems,
        "warnings": warnings,
        "run": run,
        "model": model_id,
        "promptName": prompt_name,
        "system": system,
    }


@router.post("/preview")
async def preview(body: RegionAgnosticRequest, state: State) -> RegionAgnosticPreview:
    """What a task would send. Free: no LLM call, no simulation."""
    return RegionAgnosticPreview.model_validate(await _plan(body, state))


@router.post("/tasks", status_code=201)
async def add_task(body: RegionAgnosticRequest, state: State) -> AddedTask:
    if body.simulations < 1:
        raise refuse(422, "no_simulations", "Assign simulations to the task.")
    plan = await _plan(body, state)
    if plan["problems"]:
        raise refuse(422, "region_agnostic_blocked", plan["problems"][0])
    run: RegionAgnosticParams = plan["run"]
    run.dataset_ids = body.dataset_ids
    run.model = plan["model"]
    run.cores = body.cores
    run.llm = {"calls": 0}
    if body.prompt_id is not None:
        run.prompt_id = body.prompt_id
        run.prompt_name = plan["promptName"]
        run.system = plan["system"]
    return await add_study(
        state,
        now=utcnow(),
        sampler=REGION_AGNOSTIC_SAMPLER,
        params=run,
        simulations=body.simulations,
        batch_size=body.cores * 10,
        template_source=(
            "# Region Agnostic Lab writes its expressions with an LLM; there is no template."
        ),
    )
