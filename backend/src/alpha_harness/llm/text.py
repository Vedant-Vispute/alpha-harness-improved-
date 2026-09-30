"""Text going to a model and coming back: a token estimate, a clipped line, a JSON reply."""

import json
import re
from typing import Any

#: Roughly four characters per token. Only used to warn before a call, never to bill.
CHARS_PER_TOKEN = 4

#: A fenced block in a reply, tried when the whole reply is not JSON: some models wrap it in
#: one even when asked for JSON alone.
FENCE = re.compile(r"```(?:ya?ml|json)?\s*\n(.*?)```", re.DOTALL)


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def loads_or(text: str) -> dict[str, Any]:
    """A model's JSON reply as a dict, or an empty one when it is not usable.

    A reply the consultant can read is worth more than a parse error, so callers degrade
    rather than raise.
    """
    for candidate in (text, *(m.group(1) for m in FENCE.finditer(text))):
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError, TypeError:
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def clip(text: Any, limit: int) -> str:
    """One line, at most ``limit`` characters, broken on a word.

    Whitespace is collapsed first: descriptions arrive from the platform with newlines
    in them, and a prompt or a table cell wants one line.
    """
    clean = " ".join(str(text or "").split())
    return clean if len(clean) <= limit else clean[:limit].rsplit(" ", 1)[0] + "…"
