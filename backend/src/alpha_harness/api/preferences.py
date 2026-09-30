"""The Settings screen's choices."""

from fastapi import APIRouter

from .. import preferences
from ..preferences import Preferences
from .deps import State

router = APIRouter(prefix="/api/preferences", tags=["preferences"])


@router.get("")
async def read(state: State) -> Preferences:
    return await preferences.load(state.db)


@router.put("")
async def write(body: Preferences, state: State) -> Preferences:
    """Replace every choice. Each takes effect at once, not after a restart."""
    await preferences.save(state.db, body)
    preferences.apply(state, body)
    return body
