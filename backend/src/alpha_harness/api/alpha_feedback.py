"""Local Power Pool analysis attached to stored Alpha rows."""

from typing import Any

from sqlalchemy import select

from ..db.models import Trial, TrialState
from ..labs.alpha_analysis import QUALITY_VERSION


def _current_diagnostic(value: Any) -> bool:
    return value.get("qualityVersion") == QUALITY_VERSION


async def feedback_for(
    db: Any, alpha_ids: list[str], vault: Any | None = None
) -> dict[str, dict[str, Any]]:
    """Persisted vault verdicts, falling back to task feedback for older installations."""
    if not alpha_ids:
        return {}
    found = await vault.quality_for(alpha_ids) if vault is not None else {}
    async with db.session() as session:
        rows = await session.execute(
            select(Trial.alpha_id, Trial.result)
            .where(
                Trial.alpha_id.in_(alpha_ids),
                Trial.state == TrialState.COMPLETE,
            )
            .order_by(Trial.id.desc())
        )
        for alpha_id, result in rows:
            if alpha_id and alpha_id not in found and isinstance(result, dict):
                analysis = result.get("analysis")
                if isinstance(analysis, dict) and _current_diagnostic(analysis):
                    found[str(alpha_id)] = analysis
        return found
