"""What is running right now.

One endpoint behind the indicator in the top bar: a catalog sync, a returns backfill and a
template sweep all report into the same registry, so "is anything happening?" has one answer.
"""

from typing import Any, Literal

from fastapi import APIRouter

from ..schemas import Out
from .deps import State

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class BackgroundTask(Out):
    id: str
    kind: str
    label: str
    #: 0..1 where it is knowable.
    progress: float | None
    detail: str
    state: Literal["running", "done", "failed", "cancelled"]
    error: str | None
    elapsed_seconds: float
    #: Free-form, for the thing that owns the task: a run id, a scope label.
    meta: dict[str, Any]


class TasksSummary(Out):
    busy: bool
    running: int
    failed: int
    progress: float | None
    tasks: list[BackgroundTask]


@router.get("")
async def running(state: State) -> TasksSummary:
    """Everything in flight, plus the one-glance summary.

    ``progress`` averages only the tasks that can report it, so one that cannot say does
    not drag the rest toward zero. Finished tasks linger briefly so a job that completes
    between two polls is still seen.
    """
    return TasksSummary.model_validate(state.tasks.summary())
