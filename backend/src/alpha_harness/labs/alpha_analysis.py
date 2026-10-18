"""Quality diagnostics run before an LLM-generated Alpha is shown to the model again."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

# A useful activity year has about one trading quarter of observations.
MIN_TRADING_DAYS_PER_YEAR = 60
REQUIRED_CONSECUTIVE_ACTIVE_YEARS = 3
MAX_ZERO_ACTIVITY_YEARS_AFTER_START = 2
# Increment whenever verdict rules change so old verdicts are analyzed again.
QUALITY_VERSION = 3


def _key(value: Any) -> str:
    return "".join(c for c in str(value).lower() if c.isalnum())


def _text(row: Mapping[str, Any], name: str) -> str:
    wanted = _key(name)
    for key, value in row.items():
        if _key(key) == wanted and value is not None:
            return str(value)
    return ""


def _year(value: Any) -> int | None:
    try:
        return int(str(value)[:4])
    except ValueError, TypeError:
        return None


def diagnose(
    yearly: Sequence[dict[str, Any]], trading_days_by_year: Mapping[int, int]
) -> dict[str, Any]:
    """Reject only broken yearly trading activity, allowing limited initial data coverage.

    An activity day is a stored trading date with positive turnover. Up to two zero-activity
    years after trading starts are tolerated. Leading zero years are tolerated when followed
    by at least three consecutive years with 60 or more trading days each. BRAIN's held-out
    test years are excluded from the in-sample timeline.
    """
    if not trading_days_by_year:
        return {
            "status": "insufficient_data",
            "rejected": False,
            "reason": None,
            "reasons": [],
            "years": 0,
            "tradingDaysByYear": {},
            "qualityVersion": QUALITY_VERSION,
        }

    stages: dict[int, set[str]] = {}
    for row in yearly:
        year = _year(_text(row, "year"))
        if year is None:
            continue
        stages.setdefault(year, set()).add(_text(row, "stage").upper())

    # A split year can have both TRAIN and TEST rows; keep its in-sample portion. If BRAIN
    # has no yearly recordset, the locally stored daily series still defines the timeline.
    in_sample_years = {
        year
        for year, year_stages in stages.items()
        if "TEST" not in year_stages or "TRAIN" in year_stages or "IS" in year_stages
    }
    if not stages:
        in_sample_years = set(trading_days_by_year)
    timeline = sorted(in_sample_years | set(trading_days_by_year))

    if timeline:
        timeline = list(range(timeline[0], timeline[-1] + 1))
    else:
        return {
            "status": "insufficient_data",
            "rejected": False,
            "reason": None,
            "reasons": [],
            "years": 0,
            "tradingDaysByYear": {},
            "qualityVersion": QUALITY_VERSION,
        }

    counts = {year: max(0, int(trading_days_by_year.get(year, 0))) for year in timeline}
    first_active_index = next((i for i, year in enumerate(timeline) if counts[year] > 0), None)
    if first_active_index is None:
        # A short or unavailable series cannot justify rejecting an Alpha.
        if len(timeline) <= MAX_ZERO_ACTIVITY_YEARS_AFTER_START:
            return _result([], timeline, counts)
        reasons = ["No trading activity was detected in any in-sample year."]
        return _result(reasons, timeline, counts)

    zero_years_after_start = [year for year in timeline[first_active_index:] if counts[year] == 0]
    reasons = []
    if len(zero_years_after_start) > MAX_ZERO_ACTIVITY_YEARS_AFTER_START:
        years = ", ".join(str(year) for year in zero_years_after_start)
        reasons.append(
            f"No trading days were detected in {len(zero_years_after_start)} in-sample years "
            f"after activity began ({years}); at most {MAX_ZERO_ACTIVITY_YEARS_AFTER_START} "
            "zero-activity years are allowed."
        )

    leading_zero_years = timeline[:first_active_index]
    if leading_zero_years:
        longest_good_run = 0
        current_good_run = 0
        for year in timeline[first_active_index:]:
            if counts[year] >= MIN_TRADING_DAYS_PER_YEAR:
                current_good_run += 1
                longest_good_run = max(longest_good_run, current_good_run)
            else:
                current_good_run = 0
        if longest_good_run < REQUIRED_CONSECUTIVE_ACTIVE_YEARS:
            reasons.append(
                f"Initial years have no trading activity, but only {longest_good_run} "
                f"consecutive years reached {MIN_TRADING_DAYS_PER_YEAR} trading days; "
                f"{REQUIRED_CONSECUTIVE_ACTIVE_YEARS} are required to confirm low initial "
                "field coverage."
            )

    return _result(reasons, timeline, counts)


def _result(
    reasons: list[str], timeline: Sequence[int], counts: Mapping[int, int]
) -> dict[str, Any]:
    return {
        "status": "rejected" if reasons else "accepted",
        "rejected": bool(reasons),
        "reason": " ".join(reasons) if reasons else None,
        "reasons": reasons,
        "years": len(timeline),
        "tradingDaysByYear": {str(year): counts[year] for year in timeline},
        "qualityVersion": QUALITY_VERSION,
    }
