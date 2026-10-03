"""Settings Sampler: run one proven expression everywhere BRAIN will accept it.

The expression, decay and truncation are held exactly as the source Alpha has them, unless
the Truncation Agent sets truncation market by market. What
varies is the market — region, delay, universe — plus neutralization and the
maxTrade/maxPosition pair. A market only counts when every data field the expression reads
is downloaded there, so a two-field Alpha is judged on the intersection.
"""

import asyncio
import contextlib
import math
import random
import time
from datetime import timedelta
from itertools import batched, product
from typing import TYPE_CHECKING, Any

import structlog
from sqlalchemy import func, select

from ..brain.errors import BrainError, BrainValidationError
from ..brain.schemas import (
    REGION_AGNOSTIC_REGION,
    TEST_PERIOD,
    SimulationRequest,
    SimulationSettings,
)
from ..brain.settings_schema import valid_values
from ..db.models import MetadataCache, StudyStatus, Trial, TrialState, utcnow
from ..engine.lifecycle import RA_CHILDREN, extract_simulation_id
from ..engine.packer import MAX_BATCH
from ..labs import scheduler
from ..labs.fastexpr import GROUPING, ParseError, data_fields, parse
from ..labs.truncation import truncation_for

if TYPE_CHECKING:
    from ..db.models import Study
    from ..labs.study import Optimizer

log = structlog.get_logger(__name__)

PENDING_SEND = scheduler.PENDING_SEND

#: Which regions accept Max Position is not in any schema, so it is measured. It changes only
#: when BRAIN adds a market, so the answer keeps for a day.
POSITION_CACHE_KEY = "max_position_regions_v2"
POSITION_MAX_AGE = timedelta(hours=24)
#: Probes in flight at once. Measured 3.3x faster than one at a time with no throttling, but
#: bounded so the burst does not grow with the number of markets BRAIN offers.
PROBE_CONCURRENCY = 4
#: One probing sweep at a time. Two previews opened together would otherwise each fan a probe
#: at every market, and a rate-limited probe is an unusable reading rather than a slow one.
_PROBE_LOCK = asyncio.Lock()
#: An incomplete sweep is not kept for the day, but neither is it repeated on every preview:
#: the Template Lab previews as its form is typed in.
PROBE_RETRY_SECONDS = 600.0
_last_probe: list[tuple[float, set[str]]] = []


def pairs_for(position_ok: bool) -> list[tuple[str, str]]:
    """The maxTrade/maxPosition pairs BRAIN accepts.

    Both ON is refused everywhere — *"Max Position and Max Trade cannot both be set to On
    simultaneously"* — so a market offers three pairs where Max Position exists and two
    where it does not.
    """
    positions = ["OFF", "ON"] if position_ok else ["OFF"]
    return [(t, p) for t in ("OFF", "ON") for p in positions if not (t == "ON" and p == "ON")]


async def position_regions(state: Any) -> set[str]:
    """Regions whose Alphas may set Max Position, asked of BRAIN and cached.

    Probing costs nothing: ``maxTrade=ON`` with ``maxPosition=ON`` is *always* rejected, and
    a rejected simulation spends no quota. Only the reason differs — a complaint about the
    pair means Max Position exists in that region, a complaint about the field means it does
    not. Measured rather than listed, so a new market needs no code change.
    """
    if (cached := await _cached_regions(state)) is not None:
        return cached
    async with _PROBE_LOCK:
        # Asked again behind the lock: whoever held it was probably probing this, and its
        # answer is as good as a fresh sweep.
        if (cached := await _cached_regions(state)) is not None:
            return cached
        if _last_probe and time.monotonic() - _last_probe[0][0] < PROBE_RETRY_SECONDS:
            return set(_last_probe[0][1])
        found = await _probe_regions(state)
        _last_probe[:] = [(time.monotonic(), found)]
        return found


async def _cached_regions(state: Any) -> set[str] | None:
    """The cached answer, or ``None`` when it is missing or too old to trust."""
    async with state.db.session() as session:
        row = await session.get(MetadataCache, POSITION_CACHE_KEY)
        if row is not None and utcnow() - row.fetched_at < POSITION_MAX_AGE:
            return {str(r) for r in (row.value or {}).get("regions", [])}
    return None


async def _probe_regions(state: Any) -> set[str]:
    schema = await state.metadata.cached_settings_schema()
    if not schema:
        return set()
    base = {"instrumentType": "EQUITY"}
    regions = [str(r) for r in valid_values(schema, "region", base)]
    gate = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def ask(region: str) -> bool | None:
        async with gate:
            return await _accepts_position(state, schema, region)

    answers = await asyncio.gather(*(ask(region) for region in regions))
    found = {region for region, answer in zip(regions, answers, strict=True) if answer}
    if not all(answer is not None for answer in answers):
        # Offering fewer pairs for a day because BRAIN was busy for one request is worse than
        # asking again on the next preview.
        log.warning("settings_sampler.position_probe_incomplete", regions=sorted(found))
        return found

    async with state.db.session() as session:
        row = await session.get(MetadataCache, POSITION_CACHE_KEY)
        if row is None:
            session.add(MetadataCache(key=POSITION_CACHE_KEY, value={"regions": sorted(found)}))
        else:
            row.value = {"regions": sorted(found)}
            row.fetched_at = utcnow()
    return found


async def _accepts_position(state: Any, schema: dict[str, Any], region: str) -> bool | None:
    """Whether BRAIN takes Max Position here, or ``None`` when the probe could not tell.

    Both flags ON is refused everywhere, so the probe spends nothing; the answer is in *which*
    refusal comes back. Anything else — a rate limit, a complaint about some other field — is
    not an answer, and saying so keeps a bad reading out of the day-long cache.
    """
    market = {"instrumentType": "EQUITY", "region": region}
    delays = valid_values(schema, "delay", market)
    if not delays:
        return False
    market["delay"] = delays[0]
    universes = valid_values(schema, "universe", market)
    neutralizations = valid_values(schema, "neutralization", market)
    if not universes or not neutralizations:
        return None
    request = SimulationRequest(
        settings=SimulationSettings(
            region=region,
            universe=str(universes[0]),
            delay=int(delays[0]),
            neutralization=str(neutralizations[0]),
            max_trade="ON",
            max_position="ON",
        ),
        regular="close",
    )
    try:
        response = await state.endpoints.create_simulation(request)
    except BrainValidationError as exc:
        settings = (getattr(exc, "fields", None) or {}).get("settings") or {}
        if "maxPosition" in settings:
            return False
        # Only the pair rule proves the field exists here. Any other complaint is about
        # something else entirely and says nothing either way.
        if any("max position and max trade" in str(m).lower() for m in settings.get("errors", [])):
            return True
        return None
    except BrainError:
        return None
    # Not expected — BRAIN took a pair it documents as illegal. Cancel it rather than leave
    # a simulation running that nothing is tracking.
    if sim_id := extract_simulation_id(response.location):
        with contextlib.suppress(BrainError):
            await state.endpoints.cancel_simulation(sim_id)
    return True


async def plan(
    state: Any,
    alpha_id: str,
    *,
    expression: str | None = None,
    decay: int | None = None,
    truncation: float | None = None,
    nan_handling: str | None = None,
    test_period: str | None = None,
) -> dict[str, Any]:
    """Everything the screen needs: the expression, its fields, and the space they open up.

    From an Alpha, the expression and every setting are its own to begin with. Each of decay,
    truncation, NaN handling and the test period can be overridden anyway: re-running a proven
    expression at a different decay is as much a sweep as re-running it in another market, and
    refusing to let the source Alpha be varied would be an arbitrary line.
    """
    problems: list[str] = []
    warnings: list[str] = []

    if expression is not None:
        source: dict[str, Any] = {}
    else:
        body = await state.endpoints.alpha_body(alpha_id)
        code = body.get("regular") or body.get("combo") or body.get("selection") or {}
        expression = code.get("code") if isinstance(code, dict) else None
        source = dict(body.get("settings") or {})
    # An override supplied stands; anything left out keeps the Alpha's own, or the platform
    # default when there is no Alpha to inherit from.
    source["decay"] = source.get("decay", 0) if decay is None else decay
    source["truncation"] = source.get("truncation", 0.08) if truncation is None else truncation
    source["nanHandling"] = nan_handling or source.get("nanHandling") or "ON"
    source["testPeriod"] = test_period or source.get("testPeriod") or TEST_PERIOD
    if not expression:
        problems.append(f"{alpha_id or 'The expression'} has no expression to re-run.")
        return _empty(alpha_id, "", [], source, problems, warnings)

    try:
        tree = parse(expression)
        fields = data_fields(tree)
        # Grouping fields do not count as data but must exist where it runs, so the markets
        # are placed on everything it reads.
        placed = data_fields(tree, grouping=True)
    except ParseError:
        problems.append("Its expression could not be parsed, so its data fields are unknown.")
        return _empty(alpha_id, expression, [], source, problems, warnings)
    if not fields:
        problems.append("Its expression reads no data field, so there is nothing to place.")
        return _empty(alpha_id, expression, [], source, problems, warnings)

    # Read in parallel: catalog reads run off the event loop in threads and take no write
    # lock, so a multi-field Alpha waits once rather than once per field.
    per_field = await asyncio.gather(*(state.queries.field_availability(f) for f in placed))
    held: dict[tuple[str, int, str], float] = {}
    for index, (field, rows) in enumerate(zip(placed, per_field, strict=True)):
        here = {
            (str(r["region"]), int(r["delay"]), str(r["universe"])): float(r["coverage"] or 0.0)
            for r in rows
            if r["instrument_type"] == "EQUITY"
        }
        if not here:
            problems.append(f"{field} is not downloaded in any market. Sync from BRAIN first.")
            return _empty(
                alpha_id, expression, fields, source, problems, warnings, _grouping(placed)
            )
        # The Alpha needs every field present, and is only as covered as its thinnest one.
        held = here if index == 0 else {k: min(v, here[k]) for k, v in held.items() if k in here}
    if not held:
        problems.append(f"No downloaded market holds all of {', '.join(fields)} together.")
        return _empty(alpha_id, expression, fields, source, problems, warnings, _grouping(placed))

    schema = await state.metadata.cached_settings_schema()
    if not schema:
        problems.append("BRAIN's settings list is not loaded. Sign in again.")
        return _empty(alpha_id, expression, fields, source, problems, warnings, _grouping(placed))

    if missing := await _unsynced(state, schema):
        warnings.append(
            f"{missing} market{'s' if missing > 1 else ''} are not downloaded, so this is what "
            "your catalog can see rather than everything BRAIN offers."
        )

    accepts = await position_regions(state)
    regions = _regions(held, schema, accepts)
    totals = _totals(regions)
    return {
        "alphaId": alpha_id,
        "expression": expression,
        "dataFields": fields,
        "groupingFields": _grouping(placed),
        "settings": _settings(source),
        "regions": regions,
        "totals": totals,
        "problems": problems,
        "warnings": warnings,
    }


def _regions(
    held: dict[tuple[str, int, str], float],
    schema: dict[str, Any],
    accepts: set[str],
) -> list[dict[str, Any]]:
    by_region: dict[str, dict[int, dict[str, float]]] = {}
    for (region, delay, universe), coverage in held.items():
        by_region.setdefault(region, {}).setdefault(delay, {})[universe] = coverage

    out: list[dict[str, Any]] = []
    for region, delays in by_region.items():
        market = {"instrumentType": "EQUITY", "region": region, "delay": next(iter(delays))}
        neutralizations = [str(n) for n in valid_values(schema, "neutralization", market)]
        pairs = pairs_for(region in accepts)
        markets: list[dict[str, Any]] = [
            {
                "region": region,
                "delay": delay,
                "universe": universe,
                "coverage": coverage,
                "total": len(neutralizations) * len(pairs),
                "agentTruncation": truncation_for(region, delay, universe),
            }
            for delay in sorted(delays)
            for universe, coverage in sorted(delays[delay].items())
        ]
        out.append(
            {
                "region": region,
                "delays": sorted(delays),
                "universes": sorted({m["universe"] for m in markets}),
                "neutralizations": neutralizations,
                "pairs": [{"maxTrade": t, "maxPosition": p} for t, p in pairs],
                "positionAvailable": region in accepts,
                # All regions sends region-agnostic simulations, each charged per region it
                # reaches. Said per region so every estimate can count it, not hide it.
                "cost": simulation_cost(region),
                "markets": markets,
                "total": sum(int(m["total"]) for m in markets),
            }
        )
    # Richest first: the regions worth the most simulations lead, ties alphabetical.
    out.sort(key=lambda r: (-int(r["total"]), str(r["region"])))
    return out


def simulation_cost(region: str) -> int:
    """Simulations of the day's allowance one run in this region uses."""
    return RA_CHILDREN if region == REGION_AGNOSTIC_REGION else 1


def batch_size(region: str) -> int:
    """How many runs one multi-simulation carries: BRAIN fails a batch of region-agnostic ones."""
    return 1 if region == REGION_AGNOSTIC_REGION else MAX_BATCH


def _totals(regions: list[dict[str, Any]]) -> dict[str, Any]:
    batches = 0
    for region in regions:
        per_delay: dict[int, int] = {}
        for market in region["markets"]:
            delay = int(market["delay"])
            per_delay[delay] = per_delay.get(delay, 0) + int(market["total"])
        size = batch_size(str(region["region"]))
        batches += sum(math.ceil(n / size) for n in per_delay.values())
    return {"total": sum(int(r["total"]) * int(r["cost"]) for r in regions), "batches": batches}


def _settings(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "region": source.get("region"),
        "universe": source.get("universe"),
        "delay": source.get("delay"),
        "neutralization": source.get("neutralization"),
        "decay": source.get("decay"),
        "truncation": source.get("truncation"),
        "maxTrade": source.get("maxTrade") or "OFF",
        "maxPosition": source.get("maxPosition") or "OFF",
        "nanHandling": source.get("nanHandling") or "ON",
        "testPeriod": source.get("testPeriod") or TEST_PERIOD,
    }


def _grouping(placed: list[str]) -> list[str]:
    """The grouping fields among those read: shown, though BRAIN counts none as data."""
    return [f for f in placed if f in GROUPING]


def _empty(
    alpha_id: str,
    expression: str,
    fields: list[str],
    source: dict[str, Any],
    problems: list[str],
    warnings: list[str],
    grouping: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "alphaId": alpha_id,
        "expression": expression,
        "dataFields": fields,
        "groupingFields": grouping or [],
        "settings": _settings(source),
        "regions": [],
        "totals": {"total": 0, "batches": 0},
        "problems": problems,
        "warnings": warnings,
    }


async def _unsynced(state: Any, schema: dict[str, Any]) -> int:
    """Markets BRAIN offers that the catalog has never downloaded.

    Availability is read from downloaded fields, so an unsynced market is invisible rather
    than empty. Saying how many are missing keeps a partial catalog from reading as a
    complete answer.
    """
    synced = {
        (str(r["region"]), int(r["delay"]), str(r["universe"]))
        for r in await state.queries.synced_tuples()
        if r["instrument_type"] == "EQUITY"
    }
    base = {"instrumentType": "EQUITY"}
    offered = {
        (str(region), int(delay), str(universe))
        for region in valid_values(schema, "region", base)
        if region != "ALL"
        for delay in valid_values(schema, "delay", {**base, "region": region})
        for universe in valid_values(schema, "universe", {**base, "region": region, "delay": delay})
    }
    return len(offered - synced)


#: Neutralization that neutralizes against nothing.
NO_NEUTRALIZATION = "NONE"


def market_neutral(neutralization: str, trade: str, position: str) -> bool:
    """Whether this combination holds the book against the market at all.

    ``NONE`` with neither Max Trade nor Max Position is the one combination that does not:
    nothing is projected out and nothing is capped, so the Alpha carries the market's own
    direction. Either constraint on its own is enough, which is why this is not simply
    "neutralization is not NONE".
    """
    return neutralization != NO_NEUTRALIZATION or trade == "ON" or position == "ON"


def expand(
    plan_rows: list[dict[str, Any]],
    chosen: set[tuple[str, int, str]],
    neutralizations: set[str],
    pairs: set[tuple[str, str]],
    source: dict[str, Any],
    *,
    market_neutral_only: bool = True,
    truncation_agent: bool = False,
) -> list[SimulationRequest]:
    """Every simulation the selection asks for, ordered for both packing and watching.

    Two things pull against each other here. A multi-simulation's children must share region
    and delay, and the engine fills batches from the head of the queue, so simulations mixed
    one by one would fragment into part-full batches (``engine/packer.py``). But a queue in
    market order means watching one region for minutes before another appears.

    So the shuffling happens a batch at a time: each ten stay in one market, and the order
    those tens go out is random. Packing is untouched and no region waits its turn.

    The Alpha's own settings lead, whatever the shuffle says: it is the reference the rest of
    the sweep is read against. It leads its *own* batch rather than travelling alone — pulled
    out of its market, it would go first as a batch of one and strand its nine fellows in a
    tail at the very back.

    With ``truncation_agent`` each market takes the agent's truncation, except the Alpha's own
    settings: kept as they are, so that simulation is still the Alpha it is compared with.
    """
    expression = str(source.get("expression") or "")
    decay = int(source.get("decay") or 0)
    truncation = float(source.get("truncation") or 0.08)
    nan_handling = str(source.get("nanHandling") or "ON")
    test_period = str(source.get("testPeriod") or TEST_PERIOD)
    origin = (
        str(source.get("region") or ""),
        int(source.get("delay") or 0),
        str(source.get("universe") or ""),
        str(source.get("neutralization") or ""),
        str(source.get("maxTrade") or "OFF"),
        str(source.get("maxPosition") or "OFF"),
    )

    groups: dict[tuple[str, int], list[SimulationRequest]] = {}
    first: SimulationRequest | None = None
    for region in plan_rows:
        legal_pairs = [
            (str(p["maxTrade"]), str(p["maxPosition"]))
            for p in region["pairs"]
            if not pairs or (p["maxTrade"], p["maxPosition"]) in pairs
        ]
        legal_neutral = [
            str(n) for n in region["neutralizations"] if not neutralizations or n in neutralizations
        ]
        markets = [
            m
            for m in region["markets"]
            if not chosen or (str(m["region"]), int(m["delay"]), str(m["universe"])) in chosen
        ]
        for market, neutralization, (trade, position) in product(
            markets, legal_neutral, legal_pairs
        ):
            if market_neutral_only and not market_neutral(neutralization, trade, position):
                continue
            key = (str(market["region"]), int(market["delay"]))
            own = (*key, str(market["universe"]), neutralization, trade, position) == origin
            request = SimulationRequest(
                settings=SimulationSettings(
                    region=key[0],
                    universe=str(market["universe"]),
                    delay=key[1],
                    neutralization=neutralization,
                    decay=decay,
                    truncation=(
                        truncation_for(*key, str(market["universe"]))
                        if truncation_agent and not own
                        else truncation
                    ),
                    nan_handling=nan_handling,
                    test_period=test_period,
                    max_trade=trade,
                    max_position=position,
                ),
                regular=expression,
            )
            groups.setdefault(key, []).append(request)
            if own:
                first = request

    # Whole batches, so every ten still share a market, then those batches interleaved.
    #
    # Only the full tens are shuffled. The engine reads a window of free x 10 rows off the
    # head of the queue, so a run of exact tens always meets that window on a boundary and
    # packs as it was built; a short tail let into the middle would straddle one and split
    # into two part-full batches. Tails therefore go last, where they cost nothing that the
    # remainder was not already going to cost.
    head: list[SimulationRequest] = []
    full: list[tuple[SimulationRequest, ...]] = []
    tails: list[tuple[SimulationRequest, ...]] = []
    for members in groups.values():
        for chunk in batched(members, MAX_BATCH, strict=False):
            # Identity, not equality: two requests differing in nothing the key holds are
            # equal to Pydantic, and hoisting the wrong one would leave the reference buried.
            if first is not None and any(request is first for request in chunk):
                head = [first, *(r for r in chunk if r is not first)]
            else:
                (full if len(chunk) == MAX_BATCH else tails).append(chunk)
    random.shuffle(full)
    random.shuffle(tails)
    return [*head, *(request for chunk in (*full, *tails) for request in chunk)]


def seed_trials(requests: list[SimulationRequest], *, has_source: bool = True) -> Any:
    """Parked trials for every simulation, written with the task in one transaction.

    ``has_source`` is false for a sweep of a bare expression: it has no Alpha of its own, so no
    simulation is the reference.
    """

    def build(study_id: int) -> list[Trial]:
        return [
            Trial(
                study_id=study_id,
                number=number,
                # The first is the Alpha's own settings (``expand`` puts it there): the
                # reference every other row is read against.
                params={"source": True} if has_source and number == 0 else {},
                distributions={},
                expression=request.regular,
                settings=request.settings.model_dump(by_alias=True, exclude_none=True),
                state=TrialState.PRUNED,
                message=PENDING_SEND,
            )
            for number, request in enumerate(requests)
        ]

    return build


async def refill(optimizer: Optimizer, row: Study, want: int, waiting: bool) -> int:
    """Hand the next free cores their share of the written simulations.

    Only ``want`` rows are read. A sweep may carry thousands of parked trials, and loading
    them all on every scheduler tick is a cost that grows with the task.
    """
    parked = (
        Trial.study_id == row.id,
        Trial.state == TrialState.PRUNED,
        Trial.message == PENDING_SEND,
    )
    async with optimizer.db.session() as session:
        batch = (
            (
                await session.scalars(
                    select(Trial).where(*parked).order_by(Trial.number).limit(want)
                )
            ).all()
            if want > 0
            else []
        )
        sent = await scheduler.send_parked(optimizer, row, batch) if batch else 0
        # Counted, not loaded, and after the send so it sees what is left. A task cannot be
        # finished by ``advance`` alone: trials answered from the dedup cache are excluded
        # from its committed count, so one that never spends quota would otherwise run on.
        left = await session.scalar(select(func.count()).select_from(Trial).where(*parked))
    if not (waiting or sent or left):
        # No message: the status is the news, and a notice repeating it is noise.
        await scheduler.finish(optimizer, row.id, StudyStatus.COMPLETE, "")
    return sent
