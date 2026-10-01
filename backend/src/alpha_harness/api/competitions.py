"""Competitions: what BRAIN is running, and where you stand in each.

BRAIN lists every competition with your status in it, but your rank only comes with one
competition at a time, so only the ongoing ones are read in full.
"""

import asyncio
from datetime import UTC, datetime
from typing import Any

import structlog
from fastapi import APIRouter

from ..schemas import Out
from .deps import State

router = APIRouter(prefix="/api/competitions", tags=["competitions"])
log = structlog.get_logger(__name__)


class CompetitionStanding(Out):
    rank: int | None
    alphas: int | None


class Competition(Out):
    id: str
    name: str
    #: BRAIN's word for your place in it, e.g. ``ACCEPTED`` or ``EXCLUDED``.
    status: str
    enrolled: bool
    ongoing: bool
    scoring: str | None
    start_date: str | None
    end_date: str | None
    sign_up_end_date: str | None
    faq: str | None
    #: Only for an ongoing competition you are enrolled in.
    standing: CompetitionStanding | None


class Competitions(Out):
    competitions: list[Competition]


def _when(value: Any) -> datetime | None:
    """A BRAIN timestamp as an aware datetime. BRAIN sends an offset; one without is read as
    UTC rather than left naive, which could not be compared with ``now``."""
    if not value:
        return None
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


def _is_ongoing(c: dict[str, Any], now: datetime) -> bool:
    start, end = _when(c.get("startDate")), _when(c.get("endDate"))
    return start is not None and end is not None and start <= now <= end


@router.get("")
async def competitions(state: State) -> Competitions:
    listed = await state.endpoints.competitions()
    now = datetime.now(UTC)
    ongoing = [c for c in listed if _is_ongoing(c, now)]
    # One competition BRAIN will not show (restricted, or a passing error) costs only its rank,
    # not the page.
    details = await asyncio.gather(
        *(state.endpoints.competition(str(c["id"])) for c in ongoing), return_exceptions=True
    )
    boards: dict[str, Any] = {}
    for c, d in zip(ongoing, details, strict=True):
        if isinstance(d, BaseException):
            log.warning("competitions.detail_failed", competition=c.get("id"), error=str(d))
        else:
            boards[str(d.get("id"))] = d.get("leaderboard")

    def row(c: dict[str, Any]) -> Competition:
        cid = str(c["id"])
        board = boards.get(cid)
        return Competition(
            id=cid,
            name=str(c.get("name") or cid),
            status=str(c.get("status") or ""),
            enrolled=c.get("signUpDate") is not None,
            ongoing=_is_ongoing(c, now),
            scoring=c.get("scoring"),
            start_date=c.get("startDate"),
            end_date=c.get("endDate"),
            sign_up_end_date=c.get("signUpEndDate"),
            faq=c.get("faq"),
            standing=CompetitionStanding(rank=board.get("rank"), alphas=board.get("alphas"))
            if isinstance(board, dict)
            else None,
        )

    rows = [row(c) for c in listed]

    # Ongoing first, soonest to end; then the rest, most recent first. By the moment, not the
    # text: BRAIN's offsets change with daylight saving, and text sorts ignore them.
    def ends(r: Competition) -> datetime:
        return _when(r.end_date) or datetime.min.replace(tzinfo=UTC)

    live = sorted((r for r in rows if r.ongoing), key=ends)
    past = sorted((r for r in rows if not r.ongoing), key=ends, reverse=True)
    return Competitions(competitions=live + past)
