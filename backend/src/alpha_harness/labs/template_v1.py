"""Template Lab tasks added while templates were built from blocks, run as they were planned.

Kept so those tasks finish on the code that planned them; nothing new is written in this
shape. A tree's FIELD tags share one field pool, and its other variables, choice blocks and
neutralization are asked of the search exactly as they were when the task was added.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..brain.schemas import SimulationRequest, SimulationSettings
from . import search
from .fastexpr import Node
from .fastexpr import render as write
from .search import coverage, field_choices, first_pass

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .params import TemplateParams

__all__ = ["coverage", "draw", "field_choices", "first_pass"]

#: Operators written between their inputs when no option is set.
SYMBOLS = {
    "add": "+",
    "subtract": "-",
    "multiply": "*",
    "divide": "/",
    "equal": "==",
    "not_equal": "!=",
    "greater": ">",
    "greater_equal": ">=",
    "less": "<",
    "less_equal": "<=",
}


def _walk(slot: dict[str, Any] | None, path: str = "r") -> Iterator[tuple[str, dict[str, Any]]]:
    """Every block with its path (``r``, ``r.0``, ``r.0.1``), parents first."""
    if slot is None:
        return
    yield path, slot
    if slot["kind"] == "op":
        for index, child in enumerate(slot["args"]):
            yield from _walk(child, f"{path}.{index}")


@dataclass(frozen=True, slots=True)
class Used:
    """What a tree asks the search for."""

    #: FIELD tags in order; the first is the field the first pass covers.
    fields: tuple[str, ...]
    #: ``(variable, tag)`` for every other variable, sorted.
    values: tuple[tuple[str, str], ...]
    #: ``(path, operators)`` for every choice block, parents first.
    choices: tuple[tuple[str, tuple[str, ...]], ...]


def used(tree: dict[str, Any]) -> Used:
    fields: set[str] = set()
    values: set[tuple[str, str]] = set()
    choices: list[tuple[str, tuple[str, ...]]] = []
    for path, node in _walk(tree.get("root")):
        if node["kind"] == "var":
            if node["name"] == "FIELD":
                fields.add(node["tag"])
            else:
                values.add((node["name"], node["tag"]))
        elif node["kind"] == "op" and len(node["ops"]) > 1:
            choices.append((path, tuple(node["ops"])))
    return Used(tuple(sorted(fields)), tuple(sorted(values)), tuple(choices))


def field_key(tag: str, fields: tuple[str, ...]) -> str:
    """The first FIELD tag is ``field``, as in Search Lab, so the first pass covers it."""
    return "field" if fields and tag == fields[0] else f"field_{tag}"


def vector_key(key: str) -> str:
    return "vector_op" if key == "field" else f"vector_op_{key.removeprefix('field_')}"


def suggest(trial: Any, run: TemplateParams, choices: dict[str, list[str]]) -> dict[str, Any]:
    """One point, asked define-by-run in a fixed order so every name keeps one distribution."""
    space, use = run.space, used(run.tree or {})
    universes = list(space["universes"])
    universe = (
        universes[0] if len(universes) == 1 else trial.suggest_categorical("universe", universes)
    )
    params: dict[str, Any] = {"universe": universe}
    for tag in use.fields:
        key = field_key(tag, use.fields)
        params[key] = trial.suggest_categorical(f"{key}@{universe}", choices[universe])
        if space["fields"][params[key]] == "VECTOR":
            vector = vector_key(key)
            params[vector] = trial.suggest_categorical(vector, list(space["vector"]))
    for name, tag in use.values:
        key = f"{name}#{tag}"
        params[key] = trial.suggest_categorical(key, list(space["variables"][name]))
    for path, ops in use.choices:
        params[f"op@{path}"] = trial.suggest_categorical(f"op@{path}", list(ops))
    neutralizations = list(space["neutralizations"])
    params["neutralization"] = (
        neutralizations[0]
        if len(neutralizations) == 1
        else trial.suggest_categorical("neutralization", neutralizations)
    )
    return params


def render(tree: dict[str, Any], params: dict[str, Any]) -> str:
    """The Fast Expression for one point of the search."""
    return write(_written(tree["root"], "r", params, used(tree)))


def _written(node: dict[str, Any], path: str, params: dict[str, Any], use: Used) -> Node:
    kind = node["kind"]
    if kind == "op":
        name = node["ops"][0] if len(node["ops"]) == 1 else params[f"op@{path}"]
        args = tuple(
            _written(child, f"{path}.{index}", params, use)
            for index, child in enumerate(node["args"])
        )
        options = node.get("options") or {}
        if name in SYMBOLS and not options and len(args) == 2:
            return Node("binary", SYMBOLS[name], args)
        return Node("call", name, args, tuple((k, _literal(v)) for k, v in options.items()))
    if kind == "var":
        if node["name"] == "FIELD":
            key = field_key(node["tag"], use.fields)
            inner = Node("name", params[key])
            vector = params.get(vector_key(key))
            if vector:
                inner = Node("call", vector, (inner,))
            return inner
        value = params[f"{node['name']}#{node['tag']}"]
        return Node("name", str(value)) if node["name"] == "GROUP" else _literal(value)
    if kind == "data":
        return Node("name", node["name"])
    return _literal(node["value"])


def _literal(value: float | bool | str) -> Node:
    if isinstance(value, bool):
        return Node("name", "true" if value else "false")
    if isinstance(value, str):
        return Node("str", f'"{value}"')
    number = float(value)
    text = str(int(abs(number))) if number.is_integer() else repr(abs(number))
    return Node("unary", "-", (Node("num", text),)) if number < 0 else Node("num", text)


def request_for(params: dict[str, Any], run: TemplateParams) -> SimulationRequest:
    return SimulationRequest(
        settings=SimulationSettings(
            region=run.region,
            delay=run.delay,
            universe=params["universe"],
            neutralization=params["neutralization"],
            decay=run.decay,
            truncation=search.TRUNCATION,
        ),
        regular=render(run.tree or {}, params),
    )


def draw(
    trial: Any, run: TemplateParams, choices: dict[str, list[str]]
) -> tuple[dict[str, Any], SimulationRequest | None]:
    """One point and its simulation; none when two FIELD or two GROUP tags landed on one value."""
    params = suggest(trial, run, choices)
    use = used(run.tree or {})
    fields = [params[field_key(tag, use.fields)] for tag in use.fields]
    groups = [params[f"GROUP#{tag}"] for name, tag in use.values if name == "GROUP"]
    if len(set(fields)) < len(fields) or len(set(groups)) < len(groups):
        return params, None
    return params, request_for(params, run)
