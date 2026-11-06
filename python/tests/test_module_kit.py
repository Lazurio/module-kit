import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Literal

import pytest

from lazurio_module_kit import (
    GATEWAY_HEADERS,
    AppAccess,
    AppPerson,
    HealthResponse,
    Listener,
    ModuleKitError,
    app_access,
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


def _run(ready: Callable[[], bool | Awaitable[bool]]) -> HealthResponse:
    async def check() -> HealthResponse:
        return await health(ready)()

    return asyncio.run(check())


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


HOST = "deals.vm-01.example.lazurio.io"
HOSTED = {**APP, "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN": f"https://{HOST}"}
ALENA = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
BOB = "9a8b7c6d-5e4f-4321-8fed-cba987654321"
UNKNOWN = AppAccess("unknown", None, None, None, "no-identity")


def _local(reason: Literal["not-hosted", "not-through-gateway", "local-entry"]) -> AppAccess:
    return AppAccess("local", "admin", None, None, reason)


def _person(subject: str = ALENA, entry: str = "environment", host: str = HOST) -> dict[str, str]:
    return {
        "host": host,
        GATEWAY_HEADERS["subject"]: subject,
        GATEWAY_HEADERS["username"]: "alena",
        GATEWAY_HEADERS["entry"]: entry,
    }


def test_whole_environment_is_an_application_admin() -> None:
    headers = {
        "Host": HOST,
        "X-Auth-Request-User": ALENA,
        "X-Auth-Request-Preferred-Username": "alena",
        "X-Lazurio-Entry": "environment",
    }
    assert app_access(headers, "app", HOSTED) == AppAccess(
        "environment", "admin", AppPerson(ALENA, "alena"), "gateway", None
    )


@pytest.mark.parametrize("role", ["admin", "user"])
def test_this_app_only_has_the_stated_role(role: Literal["admin", "user"]) -> None:
    headers = {**_person(entry="app"), GATEWAY_HEADERS["app_role"]: role}
    assert app_access(headers, "app", HOSTED) == AppAccess(
        "app", role, AppPerson(ALENA, "alena"), "gateway", None
    )


@pytest.mark.parametrize("role", [None, "", "Admin", "owner"])
def test_this_app_only_without_a_valid_role_is_unknown(role: str | None) -> None:
    headers = (
        _person(entry="app") if role is None else {**_person(entry="app"), GATEWAY_HEADERS["app_role"]: role}
    )
    assert app_access(headers, "app", HOSTED) == UNKNOWN


@pytest.mark.parametrize(
    "host",
    [
        "DEALS.VM-01.EXAMPLE.LAZURIO.IO",
        f"{HOST}:443",
        f"{HOST}:8443",
        f"{HOST}.",
        "Deals.Vm-01.Example.Lazurio.Io.:443",
    ],
)
def test_the_gateway_hostname_in_any_form_counts_only_by_its_statement(host: str) -> None:
    visitor = {**_person(entry="app", host=host), GATEWAY_HEADERS["app_role"]: "user"}
    assert app_access(visitor, "app", HOSTED).app_role == "user"
    assert app_access({"host": host}, "app", HOSTED) == UNKNOWN


def test_not_hosted_is_local_whatever_it_carries() -> None:
    headers = {**_person(entry="app", host="127.0.0.1:43100"), GATEWAY_HEADERS["app_role"]: "user"}
    assert app_access(headers, "app", APP) == _local("not-hosted")


@pytest.mark.parametrize(
    "host", ["127.0.0.1:43100", "127.0.0.1", "localhost:43100", "LOCALHOST", "[::1]:43100"]
)
def test_a_loopback_host_is_local(host: str) -> None:
    assert app_access(_person(host=host), "app", HOSTED) == _local("not-through-gateway")


@pytest.mark.parametrize(
    "host", ["notes.vm-01.example.lazurio.io", f"{HOST}.evil.test", "evil.test", "", "127.0.0.1.evil.test"]
)
def test_any_other_host_is_unknown(host: str) -> None:
    assert app_access(_person(host=host), "app", HOSTED) == UNKNOWN


def test_local_entry_is_local_without_a_name() -> None:
    headers = {"host": HOST, GATEWAY_HEADERS["entry"]: "local"}
    assert app_access(headers, "app", HOSTED) == _local("local-entry")


@pytest.mark.parametrize(
    "headers",
    [
        {"host": HOST},
        {"host": HOST, GATEWAY_HEADERS["subject"]: ALENA},
        {**_person(), GATEWAY_HEADERS["entry"]: "full"},
        {**_person(), GATEWAY_HEADERS["entry"]: "local"},
        _person(""),
        _person(ALENA.upper()),
        _person(ALENA + "0"),
        _person("alena"),
        {"host": HOST, GATEWAY_HEADERS["entry"]: "local", GATEWAY_HEADERS["username"]: "alena"},
        {"host": HOST, GATEWAY_HEADERS["entry"]: "local", GATEWAY_HEADERS["app_role"]: "user"},
    ],
)
def test_missing_or_malformed_statement_is_unknown(headers: dict[str, str]) -> None:
    assert app_access(headers, "app", HOSTED) == UNKNOWN


def test_repeated_subject_is_unknown() -> None:
    headers = {**_person(), "X-Auth-Request-User": ALENA}
    assert app_access(headers, "app", HOSTED) == UNKNOWN


def test_repeated_subject_with_a_local_entry_is_unknown() -> None:
    headers = {
        "host": HOST,
        GATEWAY_HEADERS["entry"]: "local",
        "x-auth-request-user": ALENA,
        "X-Auth-Request-User": BOB,
    }
    assert app_access(headers, "app", HOSTED) == UNKNOWN


def test_repeated_local_entry_is_unknown() -> None:
    headers = {"host": HOST, "x-lazurio-entry": "local", "X-Lazurio-Entry": "local"}
    assert app_access(headers, "app", HOSTED) == UNKNOWN


def test_repeated_host_is_unknown() -> None:
    headers = {**_person(), "Host": HOST}
    assert app_access(headers, "app", HOSTED) == UNKNOWN


@pytest.mark.parametrize("username", ["Alena", "al", "a" * 40, "-alena", ALENA, "service-account-pilot"])
def test_invalid_username_is_none(username: str) -> None:
    headers = {**_person(), GATEWAY_HEADERS["username"]: username}
    assert app_access(headers, "app", HOSTED).person == AppPerson(ALENA, None)
