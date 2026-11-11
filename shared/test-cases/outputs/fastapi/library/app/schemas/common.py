"""Enums and embedded objects shared by the resources."""

from enum import Enum


class Genre(str, Enum):
    """Values of Genre."""

    NOVEL = "novel"
    ESSAY = "essay"
    POETRY = "poetry"
    SCIENCE = "science"
