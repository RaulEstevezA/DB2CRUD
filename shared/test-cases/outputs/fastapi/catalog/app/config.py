"""Configuration read from the environment. Nothing secret has a default: see .env.example."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Values the application needs from its environment."""

    pass


def get_settings() -> Settings:
    """Reads the settings on every call, so a changed environment (tests, reloads) is always seen."""
    return Settings()
