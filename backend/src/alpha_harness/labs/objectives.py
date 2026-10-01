"""What a study is trying to maximise, and what it must not violate.

Two different things come out of a finished alpha:

**Objectives** are the numbers being optimised — Sharpe, fitness, train fitness.
They come from the in-sample statistics block.

**Constraints** are the submission checks, read from the response rather than written down
here because the limits differ by region and delay.

The encoding follows Optuna's convention — at or below zero is feasible, and the magnitude
says by how much — so a sampler that understands constraints prefers a nearly-passing alpha
over a badly-failing one.
"""

import math
from dataclasses import dataclass
from typing import Any

from ..brain.schemas import QUICK_MODE, Alpha, Check, CheckResult, SampleStats
from ..vault.yields import without_quota_checks

#: A missing number scores this: deliberately terrible, so a broken trial is never mistaken
#: for a good one. Every objective is maximised.
FAILURE = -10.0


class StudyError(ValueError):
    """A study configured in a way that cannot work. Understood and refused."""


class StudyNotFoundError(StudyError):
    """No such study. Separate because "does not exist" is not "cannot work"."""

    def __init__(self, study_id: int | str) -> None:
        super().__init__(f"No study {study_id!r}.")
        self.study_id = study_id


@dataclass(frozen=True, slots=True)
class Objective:
    key: str
    label: str


OBJECTIVES: dict[str, Objective] = {
    "sharpe": Objective("sharpe", "Sharpe"),
    # Over the train years only, so the held-out test years stay unseen by the search.
    "train_sharpe": Objective("train_sharpe", "Train Sharpe"),
    "train_fitness": Objective("train_fitness", "Train Fitness"),
}


def resolve(keys: list[str]) -> list[Objective]:
    unknown = [k for k in keys if k not in OBJECTIVES]
    if unknown:
        raise StudyError(
            f"Unknown objective(s): {', '.join(unknown)}. "
            f"Available: {', '.join(sorted(OBJECTIVES))}."
        )
    if not keys:
        raise StudyError("A study needs at least one objective.")
    return [OBJECTIVES[k] for k in keys]


def extract(
    stats: SampleStats | None,
    objectives: list[Objective],
    extra: dict[str, float | None] | None = None,
) -> list[float]:
    """Objective values from an alpha's in-sample statistics.

    ``extra`` carries numbers the statistics block does not have, such as the train-years
    fitness. A missing number becomes the objective's failure value: Optuna needs one number
    per objective, and a zero would make a broken simulation look mediocre instead of bad.
    """
    values: list[float] = []
    for objective in objectives:
        if extra is not None and objective.key in extra:
            raw = extra[objective.key]
        else:
            raw = _value(stats, objective.key)
        values.append(FAILURE if raw is None else float(raw))
    return values


def _value(stats: SampleStats | None, key: str) -> float | None:
    if stats is None:
        return None
    value = getattr(stats, key, None)
    return None if value is None else float(value)


def train_extra(alpha: Alpha, objectives: list[Objective]) -> dict[str, float | None]:
    """Objectives read from the ``train`` block.

    A simulation with a test period reports its train years there, while ``is`` stays the
    whole period.
    """
    return {
        o.key: getattr(alpha.train, o.key.removeprefix("train_"), None) if alpha.train else None
        for o in objectives
        if o.key.startswith("train_")
    }


# --- constraints ----------------------------------------------------------


def constraints(alpha: Alpha) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Violation magnitudes from the alpha's own submission checks.

    Keyed by the platform's check name — ``LOW_SHARPE``, ``HIGH_TURNOVER`` — so BRAIN
    adding a check later cannot shift the meaning of an existing position the way a bare
    vector would. Each value is ``0.0`` when the check passed, and otherwise how far the
    value sits the wrong side of its limit.
    """
    checks = alpha.in_sample.checks if alpha.in_sample else []
    violations: dict[str, float] = {}
    detail: list[dict[str, Any]] = []

    for index, check in enumerate(checks):
        violation = _violation(check)
        # Duplicate names are not expected, but silently overwriting one would hide a
        # failing check from the sampler.
        key = check.name if check.name not in violations else f"{check.name}#{index}"
        violations[key] = violation
        detail.append(
            {
                "name": check.name,
                "key": key,
                "result": str(check.result) if check.result else None,
                "value": check.value,
                "limit": check.limit,
                "violation": violation,
            }
        )

    return violations, detail


def _violation(check: Check) -> float:
    if check.result in (CheckResult.PASS, CheckResult.WARNING, CheckResult.PENDING, None):
        return 0.0
    numbers = check.numbers
    if numbers is None or not all(math.isfinite(n) for n in numbers):
        # Failed, but gave us no usable numbers — a check whose limit is a neutralization
        # name, or none at all. Feasibility is binary here; a NaN would be refused by Optuna
        # and leave the trial RUNNING in the sampler for good.
        return 1.0
    value, limit = numbers
    # The distance alone: the platform does not label a check as a floor or a ceiling, and a
    # table of check names would go stale as BRAIN adds them.
    return abs(limit - value)


def feasible(violations: dict[str, float]) -> bool:
    """Optuna's convention: at or below zero on every constraint."""
    return all(v <= 0.0 for v in violations.values())


def summarise(alpha: Alpha) -> dict[str, Any]:
    """The per-trial result row the UI shows, with nothing dropped."""
    stats = alpha.in_sample
    violations, detail = constraints(alpha)
    detail = without_quota_checks(detail)
    return {
        "alphaId": alpha.id,
        "grade": alpha.grade,
        "stats": stats.model_dump(by_alias=True, exclude={"checks"}) if stats else None,
        "checks": detail,
        "constraint": violations,
        "feasible": feasible(violations),
        "failedChecks": [d["name"] for d in detail if d["violation"] > 0],
        "quick": alpha.settings is not None and alpha.settings.simulation_mode == QUICK_MODE,
    }
