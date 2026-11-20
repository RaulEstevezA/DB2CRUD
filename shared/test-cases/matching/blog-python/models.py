from datetime import datetime

from pydantic import BaseModel, Field


class Author(BaseModel):
    id: int
    name: str = Field(max_length=80)
    created_at: datetime


class Posts(BaseModel):
    id: int
    author_id: int
    title: str
    body: str | None = None
    comment_ids: list[int] = []
