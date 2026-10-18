"""LLM Prompts: the built-in system prompts, and the user's own saved beside them.

Built-ins are read-only; copying one is how it is changed. A saved prompt is edited in
place and every task that uses it reads the new text on its next LLM call.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from ..db.models import SavedPrompt
from ..llm.library import BUILT_IN, PromptNotFoundError, resolve
from ..llm.prompts import PROMPTS
from ..llm.text import estimate_tokens
from ..schemas import Out
from .deps import State, refuse

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

MAX_BODY = 60_000
METRICS = ("sharpe", "fitness", "turnover", "returns", "drawdown")
Metric = Literal["sharpe", "fitness", "turnover", "returns", "drawdown"]


def _metrics(value: str | None) -> list[Metric]:
    if not value:
        return ["sharpe"]
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = [value]
    return [m for m in parsed if m in METRICS] or ["sharpe"]


class PromptKind(Out):
    """One job a prompt can do: a built-in's slug, and where it is chosen."""

    slug: str
    label: str
    purpose: str


class LibraryPrompt(Out):
    #: Null for a built-in, whose ``kind`` is its slug.
    id: int | None
    kind: str
    name: str
    body: str
    read_metrics: list[Metric]
    built_in: bool
    based_on: str | None
    characters: int
    words: int
    estimated_tokens: int
    updated_at: datetime | None


class PromptLibrary(Out):
    kinds: list[PromptKind]
    prompts: list[LibraryPrompt]


def _out(
    prompt_id: int | None,
    kind: str,
    name: str,
    body: str,
    read_metrics: list[Metric],
    based_on: str | None,
    at: datetime | None,
) -> LibraryPrompt:
    return LibraryPrompt(
        id=prompt_id,
        kind=kind,
        name=name,
        body=body,
        read_metrics=read_metrics,
        built_in=prompt_id is None,
        based_on=based_on,
        characters=len(body),
        words=len(body.split()),
        estimated_tokens=estimate_tokens(body),
        updated_at=at,
    )


def _row(r: SavedPrompt) -> LibraryPrompt:
    return _out(r.id, r.kind, r.name, r.body, _metrics(r.read_metrics), r.based_on, r.updated_at)


@router.get("")
async def library(state: State) -> PromptLibrary:
    """Every prompt: each built-in first, then the saved ones, newest edit first."""
    async with state.db.session() as session:
        rows = (
            await session.scalars(select(SavedPrompt).order_by(SavedPrompt.updated_at.desc()))
        ).all()
    return PromptLibrary(
        kinds=[PromptKind(slug=p.slug, label=p.label, purpose=p.purpose) for p in PROMPTS],
        prompts=[
            *(_out(None, p.slug, p.label, p.body, ["sharpe"], None, None) for p in PROMPTS),
            *(_row(r) for r in rows if r.kind in BUILT_IN),
        ],
    )


class NewPrompt(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str
    body: str = Field(default="", max_length=MAX_BODY)
    based_on: str | None = Field(default=None, max_length=160)
    read_metrics: list[Metric] = Field(
        default_factory=lambda: ["sharpe"], min_length=1, max_length=5
    )

    @field_validator("read_metrics")
    @classmethod
    def unique_metrics(cls, value: list[Metric]) -> list[Metric]:
        if len(set(value)) != len(value):
            raise ValueError("read_metrics must not contain duplicates")
        return value


@router.post("", status_code=201)
async def create(body: NewPrompt, state: State) -> LibraryPrompt:
    """A new prompt, blank or a copy: a copy sends the text it starts from."""
    if body.kind not in BUILT_IN:
        raise refuse(422, "unknown_prompt_kind", f"There is no {body.kind!r} prompt.")
    row = SavedPrompt(
        name=body.name.strip(),
        kind=body.kind,
        body=body.body,
        based_on=body.based_on,
        read_metrics=json.dumps(body.read_metrics),
    )
    async with state.db.session() as session:
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return _row(row)


class EditPrompt(BaseModel):
    """Only what is sent changes."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = Field(default=None, max_length=MAX_BODY)
    read_metrics: list[Metric] | None = Field(default=None, min_length=1, max_length=5)

    @field_validator("read_metrics")
    @classmethod
    def unique_metrics(cls, value: list[Metric] | None) -> list[Metric] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("read_metrics must not contain duplicates")
        return value


@router.put("/{prompt_id}")
async def edit(prompt_id: int, body: EditPrompt, state: State) -> LibraryPrompt:
    async with state.db.session() as session:
        row = await session.get(SavedPrompt, prompt_id)
        if row is None:
            raise refuse(404, "prompt_not_found", f"Prompt {prompt_id} was deleted.")
        if body.name is not None:
            row.name = body.name.strip()
        if body.body is not None:
            row.body = body.body
        if body.read_metrics is not None:
            row.read_metrics = json.dumps(body.read_metrics)
        await session.flush()
        await session.refresh(row)
    return _row(row)


@router.delete("/{prompt_id}", status_code=204)
async def remove(prompt_id: int, state: State) -> None:
    """A task already using it keeps the text it had when it was added."""
    async with state.db.session() as session:
        row = await session.get(SavedPrompt, prompt_id)
        if row is not None:
            await session.delete(row)


async def chosen(state: State, kind: str, prompt_id: int | None) -> tuple[str, str]:
    """``(name, body)`` for a request that names a prompt, refused plainly if it is gone."""
    try:
        return await resolve(state.db, kind, prompt_id)
    except PromptNotFoundError as exc:
        raise refuse(422, "prompt_not_found", str(exc)) from exc
