import asyncio
import json

import pytest

from lazurio_module_kit import (
    HealthResponse,
    Listener,
    ModuleKitError,
    health,
    listener,
    listener_variable_key,
)

APP = {
    "LAZURIO_RUNTIME_LISTENER_APP_HOST": "127.0.0.1",
    "LAZURIO_RUNTIME_LISTENER_APP_PORT": "43100",
}


def test_reads_host_and_port() -> None:
    assert listener("app", APP) == Listener("127.0.0.1", 43100, None)


def test_id_maps_hyphen_and_case() -> None:
    assert listener_variable_key("admin-api") == "ADMIN_API"
    env = {
        "LAZURIO_RUNTIME_LISTENER_ADMIN_API_HOST": "127.0.0.1",
        "LAZURIO_RUNTIME_LISTENER_ADMIN_API_PORT": "43101",
    }
    assert listener("admin-api", env).port == 43101
    assert listener("APP", APP).port == 43100


def test_reads_external_origin() -> None:
    env = {**APP, "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN": "https://deals.example.lazurio.io"}
    assert listener("app", env).external_origin == "https://deals.example.lazurio.io"


def test_missing_host_names_variable() -> None:
    with pytest.raises(ModuleKitError, match="LAZURIO_RUNTIME_LISTENER_APP_HOST") as error:
        listener("app", {"LAZURIO_RUNTIME_LISTENER_APP_PORT": "43100"})
    assert error.value.code == "listener-missing"


def test_missing_port_names_variable() -> None:
    with pytest.raises(ModuleKitError, match="LAZURIO_RUNTIME_LISTENER_APP_PORT") as error:
        listener("app", {"LAZURIO_RUNTIME_LISTENER_APP_HOST": "127.0.0.1"})
    assert error.value.code == "listener-missing"


@pytest.mark.parametrize("port", ["", "0", "65536", "80a", "-1", "4.5", " 80"])
def test_invalid_port(port: str) -> None:
    with pytest.raises(ModuleKitError, match="LAZURIO_RUNTIME_LISTENER_APP_PORT"):
        listener("app", {**APP, "LAZURIO_RUNTIME_LISTENER_APP_PORT": port})


def test_never_falls_back_to_port() -> None:
    env = {"PORT": "3000", "LAZURIO_RUNTIME_HOST": "127.0.0.1", "LAZURIO_RUNTIME_PORT": "43100"}
    with pytest.raises(ModuleKitError):
        listener("app", env)


@pytest.mark.parametrize(
    "origin",
    ["deals.example.lazurio.io", "https://deals.example.lazurio.io/", "ftp://deals.example.lazurio.io"],
)
def test_invalid_origin(origin: str) -> None:
    with pytest.raises(ModuleKitError, match="EXTERNAL_ORIGIN"):
        listener("app", {**APP, "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN": origin})


def test_reads_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in APP.items():
        monkeypatch.setenv(name, value)
    assert listener("app").port == 43100


def _run(ready: object) -> HealthResponse:
    return asyncio.run(health(ready)())  # type: ignore[arg-type]


def test_health_ok() -> None:
    response = _run(lambda: True)
    assert response.status == 200
    assert json.loads(response.body) == {"status": "ok"}
    assert response.content_type == "application/json"


def test_health_starting() -> None:
    async def not_ready() -> bool:
        return False

    response = _run(not_ready)
    assert response.status == 503
    assert json.loads(response.body) == {"status": "starting"}


def test_health_raising_is_starting() -> None:
    def broken() -> bool:
        raise RuntimeError("db down")

    assert _run(broken).status == 503
