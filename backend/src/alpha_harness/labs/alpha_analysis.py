"""Quality diagnostics run before an LLM-generated Alpha is shown to the model again."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Sequence

# A day that contributes this share of all positive daily PnL is too influential to trust.
MAX_SINGLE_DAY_PROFIT_SHARE = 0.40
# A daily move this large relative to a typical move and the whole path is a spike.
SPIKE_MEDIAN_MULTIPLE = 12.0
SPIKE_TOTAL_SHARE = 0.20


def _key(value: Any) -> str:
    return "".join(c for c in str(value).lower() if c.isalnum())


def _number(row: dict[str, Any], name: str) -> float | None:
    wanted = _key(name)
    for key, value in row.items():
        if _key(key) == wanted and isinstance(value, int | float) and math.isfinite(value):
            return float(value)
    return None


def _text(row: dict[str, Any], name: str) -> str:
    wanted = _key(name)
    for key, value in row.items():
        if _key(key) == wanted and value is not None:
            return str(value)
    return ""


def diagnose(yearly: Sequence[dict[str, Any]], daily_pnl: Sequence[float]) -> dict[str, Any]:
    """Return the persistent feedback packet for one Alpha.

    Only gaps between active in-sample years are treated as broken. Leading years may be
    empty while the asset universe gains coverage, and a trailing partial year is not a gap.
    """
    reasons: list[str] = []
    years = []
    for row in yearly:
        stage = _text(row, "stage").upper()
        if stage == "TEST":
            continue
        raw_year = _text(row, "year")
        try:
            year = int(raw_year[:4])
        except ValueError, TypeError:
            continue
        long_count, short_count = _number(row, "longCount"), _number(row, "shortCount")
        if long_count is None and short_count is None:
            active: bool | None = None
        else:
            active = (long_count or 0) + (short_count or 0) > 0
        years.append(
            {
                "year": year,
                "stage": stage,
                "active": active,
                "sharpe": _number(row, "sharpe"),
                "fitness": _number(row, "fitness"),
                "returns": _number(row, "returns"),
            }
        )
    years.sort(key=lambda item: item["year"])
    if years:
        by_year = {row["year"]: row for row in years}
        years = [
            by_year.get(
                year,
                {
                    "year": year,
                    "stage": "IS",
                    "active": False,
                    "sharpe": None,
                    "fitness": None,
                    "returns": None,
                },
            )
            for year in range(years[0]["year"], years[-1]["year"] + 1)
        ]

    active_indices = [i for i, row in enumerate(years) if row["active"] is True]
    if years and not active_indices and all(row["active"] is False for row in years):
        reasons.append("No long or short trading activity was reported in any In-Sample year.")
    if active_indices:
        first, last = active_indices[0], active_indices[-1]
        for i in range(first + 1, last):
            row = years[i]
            if row["active"] is False:
                reasons.append(
                    f"Zero trading volume detected in {row['year']} between active in-sample years."
                )
                break
            zero = [
                metric
                for metric in ("sharpe", "fitness", "returns")
                if row[metric] is not None and row[metric] == 0
            ]
            if zero and any(years[j]["active"] is True for j in range(i + 1, last + 1)):
                reasons.append(
                    f"Zero {', '.join(zero)} detected in {row['year']} inside the active "
                    "in-sample timeline."
                )
                break

    values = [float(v) for v in daily_pnl if math.isfinite(float(v))]
    insufficient = not years or not values
    positive = [v for v in values if v > 0]
    total_profit = sum(positive)
    if total_profit > 0:
        best = max(positive)
        share = best / total_profit
        if share >= MAX_SINGLE_DAY_PROFIT_SHARE:
            reasons.append(f"One trading day contributed {share:.0%} of all positive daily PnL.")

    moves = [abs(v) for v in values if v != 0]
    if len(moves) >= 20:
        typical = sorted(moves)[len(moves) // 2]
        largest = max(moves)
        total_movement = sum(moves)
        if (
            typical > 0
            and largest >= SPIKE_MEDIAN_MULTIPLE * typical
            and total_movement > 0
            and largest / total_movement >= SPIKE_TOTAL_SHARE
        ):
            reasons.append(
                "Abnormal PnL spike detected: one day moved "
                f"{largest / total_movement:.0%} of the full path."
            )

    return {
        "status": ("rejected" if reasons else "insufficient_data" if insufficient else "accepted"),
        "rejected": bool(reasons),
        "reason": " ".join(reasons) if reasons else None,
        "reasons": reasons,
        "years": len(years),
        "dailyObservations": len(values),
    }


def daily_values(rows: Sequence[dict[str, Any]]) -> list[float]:
    """AlphaVault stores daily changes, already differenced from the cumulative recordset."""
    return [
        float(value)
        for row in rows
        if isinstance((value := row.get("pnl")), int | float) and math.isfinite(value)
    ]
