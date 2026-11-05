"""lazurio-module-kit: the Lazurio Module Standard runtime helpers for Python.

Same semantics as the TypeScript package @lazurio/module-kit: host and port
come only from LAZURIO_RUNTIME_LISTENER_<ID>_HOST/_PORT (LazurioPlatform
decision F26); no PORT, no LAZURIO_RUNTIME_HOST/PORT, no defaults.
"""

from __future__ import annotations

import inspect
import json
import os
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, NamedTuple
from urllib.parse import urlsplit

__all__ = [
    "GATEWAY_HEADERS",
    "AppAccess",
    "AppPerson",
    "HealthResponse",
    "Listener",
    "ModuleKitError",
    "app_access",
    "health",
    "is_lazurio_username",
    "listener",
    "listener_variable_key",
]

ErrorCode = Literal["listener-missing", "listeners-invalid", "environment-missing"]


class ModuleKitError(Exception):
    """A fail-closed runtime environment error with a stable ``code``."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code


@dataclass(frozen=True)
class Listener:
    host: str
    port: int
    external_origin: str | None


def listener_variable_key(listener_id: str) -> str:
    """Upper-cased id, anything but a letter or digit as ``_``."""
    return re.sub(r"[^A-Z0-9]", "_", listener_id.upper())


def _parse_port(value: str | None) -> int | None:
    if value is None or re.fullmatch(r"[0-9]{1,5}", value) is None:
        return None
    port = int(value)
    return port if 1 <= port <= 65535 else None


def _parse_origin(value: str) -> str | None:
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return value if value == f"{parts.scheme}://{parts.netloc}" else None


def listener(listener_id: str, env: Mapping[str, str] | None = None) -> Listener:
    """Host, port and external origin of one declared listener."""
    environment = os.environ if env is None else env
    prefix = f"LAZURIO_RUNTIME_LISTENER_{listener_variable_key(listener_id)}"
    host_name, port_name = f"{prefix}_HOST", f"{prefix}_PORT"
    origin_name = f"{prefix}_EXTERNAL_ORIGIN"
    host = environment.get(host_name, "")
    if host.strip() == "":
        raise ModuleKitError(
            "listener-missing",
            f"{host_name} is not set; start the App through Lazurio (lazurio module start)",
        )
    raw_port = environment.get(port_name)
    port = _parse_port(raw_port)
    if port is None:
        raise ModuleKitError(
            "listener-missing",
            f"{port_name} is not set; start the App through Lazurio (lazurio module start)"
            if raw_port is None
            else f"{port_name} is not a port (1-65535): {json.dumps(raw_port)}",
        )
    raw_origin = environment.get(origin_name, "")
    if raw_origin == "":
        return Listener(host, port, None)
    origin = _parse_origin(raw_origin)
    if origin is None:
        raise ModuleKitError(
            "listener-missing",
            f"{origin_name} is not an origin (https://<host>, no path): {json.dumps(raw_origin)}",
        )
    return Listener(host, port, origin)


class HealthResponse(NamedTuple):
    status: int
    body: bytes
    content_type: str


Ready = Callable[[], bool | Awaitable[bool]]


async def _is_ready(ready: Ready) -> bool:
    try:
        result = ready()
        if inspect.isawaitable(result):
            result = await result
        return result is True
    except Exception:
        return False


def health(ready: Ready) -> Callable[[], Awaitable[HealthResponse]]:
    """A framework-neutral health check: 200 ``{"status":"ok"}`` when ready,
    else (or when ``ready`` raises) 503 ``{"status":"starting"}``."""

    async def check() -> HealthResponse:
        ok = await _is_ready(ready)
        body = json.dumps({"status": "ok" if ok else "starting"}).encode()
        return HealthResponse(200 if ok else 503, body, "application/json")

    return check


GATEWAY_HEADERS: Mapping[str, str] = MappingProxyType(
    {
        "subject": "x-auth-request-user",
        "username": "x-auth-request-preferred-username",
        "entry": "x-lazurio-entry",
        "app_role": "x-lazurio-app-role",
    }
)
"""How the Environment's gateway carries its statement to the App. Internal
transport, not a contract: only ``app_access`` reads it. Exported for a
Module's own tests."""

_SUBJECT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

Entry = Literal["environment", "app", "local", "unknown"]
AppRole = Literal["admin", "user"]
Source = Literal["gateway", "auth"]
Reason = Literal["not-hosted", "not-through-gateway", "local-entry", "no-identity"]


@dataclass(frozen=True)
class AppPerson:
    """A person the Environment's gateway admitted: the account's subject (a
    lowercase UUID, the key to remember them by) and the Lazurio username to
    show, or ``None``."""

    subject: str
    username: str | None


@dataclass(frozen=True)
class AppAccess:
    """Who came to this App and with which application role (decision 0231);
    the same contract as ``appAccess`` of the TypeScript package.

    ``entry`` is ``environment`` (the whole Environment, so ``app_role`` is
    ``admin``), ``app`` (this App only, with the role the Organization gave),
    ``local`` (a request from inside the Environment: an application admin
    without a name) or ``unknown`` (through the gateway without identity: no
    ``app_role``). ``source`` is set with a person, ``reason`` without one.
    Fields and values never change meaning or disappear."""

    entry: Entry
    app_role: AppRole | None
    person: AppPerson | None
    source: Source | None = None
    reason: Reason | None = None


def is_lazurio_username(value: object) -> bool:
    """3 to 39 lowercase letters and digits with single dashes between them,
    never shaped like a UUID and never a service account's."""
    return (
        isinstance(value, str)
        and 3 <= len(value) <= 39
        and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value) is not None
        and _SUBJECT.fullmatch(value.lower()) is None
        and not value.startswith("service-account-")
    )


def _header(headers: Mapping[str, str], name: str) -> str | None:
    """One header, matched case-insensitively; a repeated one reads as none."""
    values = [value for key, value in headers.items() if key.lower() == name]
    return values[0] if len(values) == 1 else None


def app_access(
    headers: Mapping[str, str],
    listener_id: str = "app",
    env: Mapping[str, str] | None = None,
) -> AppAccess:
    """Who came to this App and with which application role, for one request;
    the same rules as ``appAccess`` of the TypeScript package. The gateway's
    statement counts only when the listener has an external origin and the
    request's Host is that origin's host; any other request is ``local``.
    Behind the gateway a missing, repeated or malformed statement is
    ``unknown``, never a role. Read it per request, never cache it. Raises
    ``listener-missing`` like ``listener``."""
    origin = listener(listener_id, env).external_origin
    if origin is None:
        return AppAccess("local", "admin", None, reason="not-hosted")
    if _header(headers, "host") != urlsplit(origin).netloc:
        return AppAccess("local", "admin", None, reason="not-through-gateway")
    entry = _header(headers, GATEWAY_HEADERS["entry"])
    subject = _header(headers, GATEWAY_HEADERS["subject"])
    if entry == "local" and subject is None:
        return AppAccess("local", "admin", None, reason="local-entry")
    unknown = AppAccess("unknown", None, None, reason="no-identity")
    if subject is None or _SUBJECT.fullmatch(subject) is None:
        return unknown
    username = _header(headers, GATEWAY_HEADERS["username"])
    person = AppPerson(subject, username if is_lazurio_username(username) else None)
    if entry == "environment":
        return AppAccess("environment", "admin", person, source="gateway")
    if entry == "app":
        role = _header(headers, GATEWAY_HEADERS["app_role"])
        if role == "admin":
            return AppAccess("app", "admin", person, source="gateway")
        if role == "user":
            return AppAccess("app", "user", person, source="gateway")
    return unknown
