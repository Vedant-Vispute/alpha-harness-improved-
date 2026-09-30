"""The Portfolio page: submitted Alphas combined at equal weight.

Equal weight is what BRAIN itself does. Its own pool figure (``before-and-after-performance``)
is the mean of the members' cumulative PnL, to within half a dollar a day, with turnover the
plain mean of theirs, measured. Filtered to one region and delay, this reproduces it.

Across regions the calendars differ, so the headline puts every Alpha on the union of their
trading days, counting a day an Alpha did not trade as zero: once it has started, each Alpha
keeps an equal share of capital whether or not its market was open.
"""

from bisect import bisect_left
from collections import Counter
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import numpy as np

from ..vault import metrics
from . import submission_planner

if TYPE_CHECKING:
    from datetime import date

    from ..vault.metrics import Floats, Stats
    from .submission_planner import Bools


def _blocks(found: dict[str, Stats | None]) -> dict[str, Any]:
    return {name: None if block is None else asdict(block) for name, block in found.items()}


def _split(meta: dict[str, dict[str, Any]], alpha_ids: list[str]) -> date | None:
    """The test start most members share. Every Alpha simulated with the default settings
    has the same one; a mixed pool takes the majority rather than failing."""
    starts = Counter(meta[a]["test_start"] for a in alpha_ids if meta.get(a, {}).get("test_start"))
    return starts.most_common(1)[0][0] if starts else None


def compute(
    series: dict[str, dict[date, tuple[float, float]]],
    meta: dict[str, dict[str, Any]],
    alpha_ids: list[str],
    cost_bps: float,
) -> dict[str, Any]:
    """Everything the Portfolio page shows for these Alphas. Ids without a series are left
    to the caller to report."""
    ids = [a for a in dict.fromkeys(alpha_ids) if series.get(a)]
    if not ids:
        return {
            "alphas": 0,
            "ids": [],
            "test_start": None,
            "stats": None,
            "after_cost": None,
            "yearly": [],
            "dates": [],
            "curve": [],
            "periods": None,
            "after_cost_curve": [],
            "correlation": [],
            "top_pairs": [],
            "measured_pairs": 0,
            "highest": None,
        }
    dates, pnl, turnover, closing = frame(series, meta, ids)
    filled = np.nan_to_num(pnl)
    count = len(ids)
    # BRAIN averages over the Alphas already trading that day: one that has not made its
    # first trade yet is left out of the count rather than diluting the others with zeros.
    started = np.maximum.accumulate((filled != 0) | (turnover != 0), axis=0)
    live = np.maximum(started.sum(axis=1), 1)
    book = filled.sum(axis=1) / live
    traded = turnover.sum(axis=1) / live
    split = _split(meta, ids)
    net = metrics.after_cost(book, traded, cost_bps)

    return {
        "alphas": count,
        "ids": ids,
        "test_start": split.isoformat() if split else None,
        "stats": _blocks(metrics.windows(dates, book, traded, split)),
        "after_cost": _blocks(metrics.windows(dates, net, traded, split)),
        # Whole calendar years, without the final days, as BRAIN's yearly rows are.
        "yearly": _yearly(dates, book, traded, ~closing.any(axis=1)),
        "dates": [d.isoformat() for d in dates],
        "curve": np.cumsum(book).tolist(),
        "after_cost_curve": np.cumsum(net).tolist(),
        "periods": _periods(dates, book, traded, split),
        # Without the final days: BRAIN's correlations match to four decimals without them.
        **_correlation(ids, dates, np.where(closing, np.nan, pnl)),
    }


def frame(
    series: dict[str, dict[date, tuple[float, float]]],
    meta: dict[str, dict[str, Any]],
    ids: list[str],
) -> tuple[list[date], Floats, Floats, Bools]:
    """These Alphas laid out day by day: the calendar, PnL, turnover, and which cells are
    closing days.

    A cell is NaN where the Alpha has no row for that day. ``closing`` marks the final days
    rebuilt from the Alpha's own figures rather than exported by BRAIN; correlations leave
    them out, which is what makes them match BRAIN's to four decimals.
    """
    # Each Alpha's stored days, oldest first, plus the final days BRAIN counts in its IS and
    # test figures but exports in no recordset (see :func:`metrics.closing_days`).
    days = {
        a: metrics.with_closing(
            [(d, p, t) for d, (p, t) in sorted(series[a].items())], meta.get(a, {})
        )
        for a in ids
    }
    dates = sorted({d for a in ids for d, _, _ in days[a]})
    at = {d: i for i, d in enumerate(dates)}
    pnl = np.full((len(dates), len(ids)), np.nan)
    turnover = np.zeros((len(dates), len(ids)))
    closing = np.zeros((len(dates), len(ids)), dtype=bool)
    for col, alpha_id in enumerate(ids):
        for day, value, traded in days[alpha_id]:
            pnl[at[day], col] = value
            turnover[at[day], col] = traded
            closing[at[day], col] = day not in series[alpha_id]
    return dates, pnl, turnover, closing


def _yearly(dates: list[date], book: Floats, traded: Floats, keep: Bools) -> list[dict[str, Any]]:
    kept = [d for d, k in zip(dates, keep, strict=True) if k]
    return [
        {"year": year} | asdict(found)
        for year, _, found in metrics.yearly(kept, book[keep], traded[keep], None)
    ]


def _periods(
    dates: list[date], book: Floats, traded: Floats, split: date | None
) -> dict[str, dict[str, str] | None]:
    """First and last day of each block, from the first trade on as the stats count them."""
    active = np.flatnonzero((book != 0) | (traded != 0))
    start = dates[int(active[0])] if active.size else dates[0]
    end = dates[-1]

    def span(first: date, last: date) -> dict[str, str]:
        return {"start": first.isoformat(), "end": last.isoformat()}

    return {
        "in_sample": span(start, end),
        "train": span(start, split) if split else None,
        "test": span(split, end) if split else None,
    }


#: Past this many Alphas a full grid is too dense to read, and too large to send: only the
#: most correlated pairs are returned.
GRID_LIMIT = 30
TOP_PAIRS = 20


def _correlation(ids: list[str], dates: list[date], pnl: Floats) -> dict[str, Any]:
    """Pairwise daily PnL correlation over the last four calendar years, as BRAIN measures it,
    and the pair that collides most. The full grid only up to ``GRID_LIMIT`` Alphas; past it,
    the ``TOP_PAIRS`` most correlated, so the answer does not grow with the square of them."""
    since = submission_planner.window_start(dates[-1])
    rho = submission_planner.correlations(pnl[bisect_left(dates, since) :])
    value, pair, _ = submission_planner.worst_pair(rho, list(range(len(ids))))
    highest = (
        {"a": ids[pair[0]], "b": ids[pair[1]], "correlation": value}
        if value is not None and pair is not None
        else None
    )
    left, right = np.triu_indices(len(ids), k=1)
    measured = ~np.isnan(rho[left, right])
    if len(ids) <= GRID_LIMIT:
        matrix = [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in rho]
        return {
            "correlation": matrix,
            "top_pairs": [],
            "measured_pairs": int(measured.sum()),
            "highest": highest,
        }
    left, right = left[measured], right[measured]
    values = rho[left, right]
    top = np.argsort(-values, kind="stable")[:TOP_PAIRS]
    return {
        "correlation": [],
        "top_pairs": [
            {"a": ids[left[k]], "b": ids[right[k]], "correlation": round(float(values[k]), 4)}
            for k in top
        ],
        "measured_pairs": int(values.size),
        "highest": highest,
    }
