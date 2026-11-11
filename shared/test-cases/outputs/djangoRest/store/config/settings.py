"""Settings of the API. Everything secret comes from the environment: see .env.example."""

import os
import secrets
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

# Without DJANGO_SECRET_KEY a random key is used: fine to try the API, set your own before deploying it
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(50)
DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"
ALLOWED_HOSTS = [host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if host.strip()]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "rest_framework",
    "api",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

# Paths have no trailing slash, as openapi.yaml describes them
APPEND_SLASH = False
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# DATABASE_URL, for example postgres://user:password@host:5432/name; TEST_DATABASE_URL replaces it in the tests
DATABASES = {
    "default": dj_database_url.parse(os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", "postgres://api:change-me@localhost:5432/api")),
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

USE_TZ = True
TIME_ZONE = "UTC"

REST_FRAMEWORK = {
    "EXCEPTION_HANDLER": "config.errors.exception_handler",
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}
