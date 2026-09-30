"""LLM Power Pool Lab: datasets, a model, cores and simulations, then add the task to Tasks.

Nothing here calls the LLM or simulates; the preview shows the exact first prompt.
"""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db.models import utcnow
from ..labs import power_pool, search
from ..labs.launch import (
    MAX_PICKED_FIELDS,
    NO_SIMULATIONS,
    OPERATORS_UNREAD,
    AddedTask,
    account_operators,
    add_study,
    choices,
    legal_choices,
    synced_universes,
)
from ..labs.params import POWER_POOL_SAMPLER, PowerPoolParams
from ..llm.text import estimate_tokens
from ..schemas import Out
from .deps import State, refuse
from .prompts import chosen

router = APIRouter(prefix="/api/power-pool-lab", tags=["power-pool-lab"])


class PowerPoolRequest(BaseModel):
    region: str
    delay: int = Field(ge=0, le=1)
    universe: str
    dataset_ids: list[str] = Field(default_factory=list, max_length=50)
    #: Single fields, ranked; the LLM sees only these, in this order.
    field_ids: list[str] = Field(default_factory=list, max_length=MAX_PICKED_FIELDS)
    #: How ``field_ids`` were ranked, in words the prompt can use.
    rank_by: str | None = Field(default=None, max_length=160)
    model: str | None = None
    #: A saved prompt from LLM Prompts; null sends the built-in.
    prompt_id: int | None = None
    #: Empty keeps every neutralization BRAIN offers; anything here is drawn from instead.
    neutralizations: list[str] = Field(default_factory=list, max_length=20)
    cores: int = Field(default=search.MAX_CORES, ge=1, le=search.MAX_CORES)
    simulations: int = Field(default=0, ge=0, le=search.MAX_SIMULATIONS)


class PowerPoolModel(Out):
    id: str
    #: How the request names it: provider and id together.
    ref: str
    provider: str
    remaining_today: int


class PowerPoolOptions(Out):
    models: list[PowerPoolModel]
    default_model: str | None
    max_simulations: int


class PowerPoolPrompt(Out):
    #: The chosen prompt's name, or the built-in's label.
    name: str
    system: str
    user: str
    tokens: int


class PowerPoolPreview(Out):
    fields: int
    universes: list[str]
    neutralizations: list[str]
    llm_calls: int
    prompt: PowerPoolPrompt | None
    problems: list[str]
    warnings: list[str]


async def llm_models(state: Any) -> list[dict[str, Any]]:
    """Set-up models whose provider has an enabled Key, most requests left today first."""
    keys = [k for k in await state.llm.keys.list_keys() if k.enabled]
    out = []
    for m in state.llm.registry.all():
        mine = [k for k in keys if k.provider == m.provider]
        if not mine:
            continue
        left = sum(
            [
                (await state.llm.ledger.headroom(k.id, m, cap=k.daily_limit)).daily_remaining
                for k in mine
            ]
        )
        out.append({"id": m.id, "ref": m.ref, "provider": m.provider, "remainingToday": left})
    return sorted(out, key=lambda m: -m["remainingToday"])


@router.get("/options")
async def options(state: State) -> PowerPoolOptions:
    models = await llm_models(state)
    return PowerPoolOptions.model_validate(
        {
            "models": models,
            "defaultModel": models[0]["ref"] if models else None,
            "maxSimulations": search.MAX_SIMULATIONS,
        }
    )


async def _plan(body: PowerPoolRequest, state: Any) -> dict[str, Any]:
    problems: list[str] = []
    warnings: list[str] = []
    operators = await account_operators(state, refresh=False)
    if not operators:
        problems.append(OPERATORS_UNREAD)
    if not body.dataset_ids:
        problems.append("Choose at least one dataset.")
    models = {m["ref"]: m for m in await llm_models(state)}
    ref = body.model or next(iter(models), "")
    info = state.llm.registry.get(ref)
    if not ref:
        problems.append("No model is set up. Set one up under LLM Integration › Models.")
    elif info is None:
        problems.append(f"{ref} is not set up. Set it up under LLM Integration › Models.")
    elif info.ref not in models:
        problems.append(f"{info.id} can't run: no enabled Key for it. Add one in LLM Integration.")

    schema = await state.metadata.cached_settings_schema()
    legal = legal_choices(schema, body.region, body.delay)
    universes = await synced_universes(state, legal, body.region, body.delay, body.universe)
    # Every neutralization BRAIN offers, not only the four the other labs default to: the LLM
    # draws from the market's whole list, which is deliberate diversity. A chosen few narrow
    # that; choosing none keeps the whole list.
    offered = [str(n) for n in choices(legal, "neutralization") if n != "NONE"]
    wanted = set(body.neutralizations)
    neutralizations = [n for n in offered if n in wanted] or offered
    if not universes:
        problems.append(
            f"No {body.region} delay {body.delay} market is downloaded. "
            "Sync it in the Data Explorer."
        )
    if not neutralizations:
        problems.append("BRAIN's settings list is not loaded. Sign in again.")

    prompt_name, system = await chosen(state, power_pool.KIND, body.prompt_id)
    fields = 0
    prompt = None
    run = PowerPoolParams(
        region=body.region,
        delay=body.delay,
        universes=universes,
        neutralizations=neutralizations,
    )
    if universes:
        for ctx, missing in await _contexts(body, state, universes):
            if ctx is None:
                problems.append(missing)
                continue
            if missing:
                warnings.append(missing)
            fields += len(ctx.fields)
            if prompt is None and info is not None and operators:
                user, shown = power_pool.user_prompt(
                    ctx, operators, run, "None yet.", 0, info.prompt_tokens, system
                )
                prompt = {
                    "name": prompt_name,
                    "system": system,
                    "user": user,
                    "tokens": estimate_tokens(system + user),
                }
                if ctx.fields and shown < min(10, len(ctx.fields)):
                    problems.append(
                        f"Only {shown} of {ctx.name}'s fields fit in {info.id}'s "
                        f"{info.prompt_tokens:,} prompt tokens, too few to work with. Raise its "
                        "Max Prompt Tokens, or choose another dataset."
                    )
    calls = -(-body.simulations // power_pool.PER_CALL)
    if not system.strip():
        problems.append(f"“{prompt_name}” is empty. Write it in LLM Prompts, or choose another.")
    left = models[info.ref]["remainingToday"] if info and info.ref in models else None
    if info is not None and left is not None and calls > left:
        warnings.append(
            f"About {calls:,} LLM calls; {info.id} has {left:,} left today, "
            f"so the task waits for its day to reset at midnight, {info.reset_timezone}."
        )
    return {
        "fields": fields,
        "universes": universes,
        "neutralizations": neutralizations,
        "llmCalls": calls,
        "prompt": prompt,
        "problems": problems,
        "warnings": warnings,
        "model": info.ref if info else ref,
        "promptName": prompt_name,
        "system": system,
    }


async def _contexts(
    body: PowerPoolRequest, state: Any, universes: list[str]
) -> list[tuple[power_pool.Context | None, str]]:
    """What each call can be about, with what is missing from it: one pool of the chosen
    fields when there are any, otherwise each dataset in turn."""
    where = f"the downloaded {body.region} delay {body.delay} catalog"
    if body.field_ids:
        ctx = await power_pool.chosen_context(
            state.catalog, body.region, body.delay, universes, body.field_ids, body.rank_by
        )
        if ctx is None:
            return [(None, f"None of the chosen fields is in {where}.")]
        left = [f for f in dict.fromkeys(body.field_ids) if f not in ctx.own]
        note = (
            f"{len(left):,} chosen fields are not in {where} or are grouping fields, so the "
            f"LLM won't see them: {', '.join(left[:5])}{'…' if len(left) > 5 else ''}."
            if left
            else ""
        )
        return [(ctx, note)]
    out: list[tuple[power_pool.Context | None, str]] = []
    for dataset in body.dataset_ids:
        ctx = await power_pool.context_for(
            state.catalog, body.region, body.delay, universes, dataset
        )
        out.append((ctx, "" if ctx else f"{dataset} is not in {where}."))
    return out


@router.post("/preview")
async def preview(body: PowerPoolRequest, state: State) -> PowerPoolPreview:
    """What a task would send. Free: no LLM call, no simulation."""
    return PowerPoolPreview.model_validate(await _plan(body, state))


@router.post("/tasks", status_code=201)
async def add_task(body: PowerPoolRequest, state: State) -> AddedTask:
    if body.simulations < 1:
        raise refuse(422, "no_simulations", NO_SIMULATIONS)
    plan = await _plan(body, state)
    if plan["problems"]:
        raise refuse(422, "power_pool_blocked", plan["problems"][0])
    return await add_study(
        state,
        now=utcnow(),
        sampler=POWER_POOL_SAMPLER,
        params=PowerPoolParams(
            region=body.region,
            delay=body.delay,
            universe=body.universe,
            universes=plan["universes"],
            neutralizations=plan["neutralizations"],
            dataset_ids=body.dataset_ids,
            field_ids=body.field_ids,
            rank_by=body.rank_by if body.field_ids else None,
            model=plan["model"],
            prompt_id=body.prompt_id,
            prompt_name=plan["promptName"] if body.prompt_id is not None else None,
            system=plan["system"] if body.prompt_id is not None else None,
            cores=body.cores,
            llm={"calls": 0},
        ),
        simulations=body.simulations,
        batch_size=body.cores * 10,
        template_source=(
            "# LLM Power Pool Lab writes its expressions with an LLM; there is no template."
        ),
    )
