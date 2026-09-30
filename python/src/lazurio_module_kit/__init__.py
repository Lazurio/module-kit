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
from typing import Literal, NamedTuple
from urllib.parse import urlsplit

__all__ = [
    "HealthResponse",
    "Listener",
    "ModuleKitError",
    "health",
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
