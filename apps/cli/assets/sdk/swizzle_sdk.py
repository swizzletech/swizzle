#!/usr/bin/env python3

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NoReturn
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

_STATE_CACHE: dict[str, Any] | None = None
_STATE_CACHE_FILE: str | None = None
_STEPS_CACHE: dict[str, Any] | None = None
_STEPS_CACHE_FILE: str | None = None
_COMPLETED_STEPS: dict[str, Any] = {}
_CLAIM_PREFIX = "claim:"
_PACE_LAST_CALL_BY_NAME: dict[str, float] = {}
_WARNED_UNKNOWN_PACE_NAMES: set[str] = set()
_REPORTED_API_CONTACTS: set[tuple[str, int, str | None, str | None]] = set()


@dataclass(frozen=True)
class AutomationMetadata:
    attempt: int | None
    automation_id: str | None
    automation_name: str | None
    automation_version: str | None
    environment: str | None
    execution_number: int | None
    run_id: str | None
    trigger_type: str | None
    version_id: str | None


@dataclass(frozen=True)
class AutomationContext:
    payload: Any
    metadata: AutomationMetadata

    def log_step(self, message: str, details: Any | None = None) -> None:
        log_step(message, details)


def read_payload() -> Any:
    raw = sys.stdin.read().strip()
    if raw == "":
        return {}
    return json.loads(raw)


def get_automation_metadata() -> AutomationMetadata:
    return AutomationMetadata(
        attempt=_parse_optional_int(os.getenv("SWIZZLE_ATTEMPT")),
        automation_id=os.getenv("SWIZZLE_AUTOMATION_ID"),
        automation_name=os.getenv("SWIZZLE_AUTOMATION_NAME"),
        automation_version=os.getenv("SWIZZLE_AUTOMATION_VERSION"),
        environment=os.getenv("SWIZZLE_ENV"),
        execution_number=_parse_optional_int(os.getenv("SWIZZLE_EXECUTION")),
        run_id=os.getenv("SWIZZLE_RUN_ID"),
        trigger_type=os.getenv("SWIZZLE_TRIGGER_TYPE"),
        version_id=os.getenv("SWIZZLE_VERSION_ID"),
    )


def _connection_env_var_name(connection_name: str) -> str:
    sanitized = "".join(
        character if character.isalnum() else "_" for character in connection_name.upper()
    )
    return f"SWIZZLE_CONNECTION_{sanitized}"


def get_connection_token(connection_name: str) -> str:
    token = os.getenv(_connection_env_var_name(connection_name))
    if token is None or token == "":
        raise RuntimeError(
            f'Connection "{connection_name}" is not available. Declare it under '
            f"connections: in config.yaml and authorize it with "
            f"`swizzle connections authorize {connection_name} "
            f"--provider <provider> --client-id <id> --client-secret-env <VAR>`."
        )
    return token


def get_connection_token_expiry(connection_name: str) -> str | None:
    return os.getenv(f"{_connection_env_var_name(connection_name)}_EXPIRES_AT")


def _read_state_snapshot() -> dict[str, Any]:
    global _STATE_CACHE, _STATE_CACHE_FILE
    state_file = _normalize_snapshot_file(os.getenv("SWIZZLE_STATE_FILE"))
    if _STATE_CACHE is not None and _STATE_CACHE_FILE == state_file:
        return _STATE_CACHE
    _STATE_CACHE_FILE = state_file
    if state_file is None:
        _STATE_CACHE = {}
        return _STATE_CACHE
    with open(state_file, encoding="utf-8") as handle:
        parsed = json.load(handle)
    _STATE_CACHE = parsed if isinstance(parsed, dict) else {}
    return _STATE_CACHE


def state_get(key: str, default: Any = None) -> Any:
    return _read_state_snapshot().get(key, default)


def state_set(key: str, value: Any) -> None:
    line = _platform_json(
        {"type": "state_set", "key": key, "value": value}, f"Swizzle state value {key!r}"
    )
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def state_delete(key: str) -> None:
    sys.stderr.write(json.dumps({"type": "state_delete", "key": key}) + "\n")
    sys.stderr.flush()


def _read_steps_snapshot() -> dict[str, Any]:
    global _STEPS_CACHE, _STEPS_CACHE_FILE
    steps_file = _normalize_snapshot_file(os.getenv("SWIZZLE_STEPS_FILE"))
    if _STEPS_CACHE is not None and _STEPS_CACHE_FILE == steps_file:
        return _STEPS_CACHE
    _STEPS_CACHE_FILE = steps_file
    if steps_file is None:
        _STEPS_CACHE = {}
        return _STEPS_CACHE
    try:
        with open(steps_file, encoding="utf-8") as handle:
            parsed = json.load(handle)
    except FileNotFoundError:
        _STEPS_CACHE = {}
        return _STEPS_CACHE
    _STEPS_CACHE = parsed if isinstance(parsed, dict) else {}
    return _STEPS_CACHE


def _validate_step_name(name: str) -> None:
    if not isinstance(name, str) or name == "":
        raise ValueError("Swizzle step names must be non-empty strings.")
    if name.startswith(_CLAIM_PREFIX):
        raise ValueError(f"Swizzle step names starting with {_CLAIM_PREFIX!r} are reserved for claim().")


def _normalize_snapshot_file(value: str | None) -> str | None:
    if value is None or value.strip() == "":
        return None
    return value


def run_step(name: str, fn: Callable[[], Any]) -> Any:
    _validate_step_name(name)
    if name in _COMPLETED_STEPS:
        return _COMPLETED_STEPS[name]

    snapshot = _read_steps_snapshot()
    if name in snapshot:
        _COMPLETED_STEPS[name] = snapshot[name]
        return snapshot[name]

    sys.stderr.write(json.dumps({"type": "step_start", "key": name}) + "\n")
    sys.stderr.flush()
    value = fn()
    line = _platform_json(
        {"type": "step_result", "key": name, "value": value}, f"Swizzle step {name!r} result"
    )
    sys.stderr.write(line + "\n")
    sys.stderr.flush()
    _COMPLETED_STEPS[name] = value
    return value


def _memoized_step(name: str) -> tuple[bool, Any]:
    _validate_step_name(name)
    if name in _COMPLETED_STEPS:
        return True, _COMPLETED_STEPS[name]

    snapshot = _read_steps_snapshot()
    if name in snapshot:
        _COMPLETED_STEPS[name] = snapshot[name]
        return True, snapshot[name]
    return False, None


def _normalize_until(until: datetime | str) -> str:
    if isinstance(until, datetime):
        value = until
    elif isinstance(until, str):
        try:
            value = datetime.fromisoformat(until.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(
                "sleep_until requires a valid datetime or ISO timestamp string."
            ) from exc
    else:
        raise ValueError("sleep_until requires a valid datetime or ISO timestamp string.")

    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _platform_json(value: Any, what: str) -> str:
    try:
        return json.dumps(value, allow_nan=False)
    except ValueError as error:
        raise ValueError(f"{what} is not JSON: {error}") from None


def _suspend_and_exit(suspend: dict[str, Any]) -> None:
    envelope = {"$swizzle": {"suspend": suspend}}
    print(_platform_json(envelope, f"Swizzle step {suspend['stepKey']!r}"))
    sys.stdout.flush()
    sys.exit(0)


def sleep_until(name: str, until: datetime | str) -> None:
    hit, _value = _memoized_step(name)
    if hit:
        return

    _suspend_and_exit(
        {
            "reason": "sleep",
            "stepKey": name,
            "until": _normalize_until(until),
        }
    )


def sleep(name: str, duration_seconds: float) -> None:
    if not math.isfinite(duration_seconds):
        raise ValueError("sleep duration_seconds must be finite.")
    sleep_until(name, datetime.now(timezone.utc) + timedelta(seconds=duration_seconds))


def invoke_automation(name: str, automation: str, payload: Any) -> dict[str, Any]:
    hit, value = _memoized_step(name)
    if hit:
        return value

    if not isinstance(automation, str) or automation == "":
        raise ValueError("invoke_automation automation must be a non-empty string.")

    _suspend_and_exit(
        {
            "reason": "child",
            "stepKey": name,
            "automation": automation,
            "payload": payload,
        }
    )
    raise RuntimeError("unreachable")


def wait_for_event(
    name: str,
    *,
    timeout_ms: float | None = None,
    until: datetime | str | None = None,
) -> dict[str, Any]:
    hit, value = _memoized_step(name)
    if hit:
        return value

    _suspend_and_exit(
        {
            "reason": "event",
            "stepKey": name,
            "until": _normalize_optional_event_until(timeout_ms=timeout_ms, until=until),
            "approval": False,
        }
    )
    raise RuntimeError("unreachable")


def request_approval(
    name: str,
    *,
    details: Any | None = None,
    assignee: dict[str, str] | None = None,
    timeout_ms: float | None = None,
    until: datetime | str | None = None,
) -> dict[str, Any]:
    hit, value = _memoized_step(name)
    if hit:
        return value

    _suspend_and_exit(
        {
            "reason": "event",
            "stepKey": name,
            "until": _normalize_optional_event_until(timeout_ms=timeout_ms, until=until),
            "approval": True,
            "assignee": assignee,
            "details": details,
        }
    )
    raise RuntimeError("unreachable")


def get_approval_url(step: str) -> str:
    return _wait_link("approvals", "approval", step)


def get_event_callback_url(step: str) -> str:
    return _wait_link("events", "event", step)


def _wait_link(path: str, kind: str, step: str) -> str:
    _validate_step_name(step)
    base = (os.getenv("SWIZZLE_LINK_URL") or "").strip()
    key = os.getenv("SWIZZLE_LINK_KEY") or ""
    run_id = os.getenv("SWIZZLE_RUN_ID") or ""
    if base == "" or key == "" or run_id == "":
        raise RuntimeError(
            "SWIZZLE_LINK_URL and SWIZZLE_LINK_KEY are not available. Only deployed runs "
            "receive them, when the worker has SWIZZLE_LINK_URL and SWIZZLE_ENCRYPTION_KEY."
        )
    digest = hmac.new(key.encode(), f"{kind}\n{step}".encode(), hashlib.sha256).digest()
    token = f"{run_id}.{_base64url(step.encode())}.{_base64url(digest)}"
    return f"{base.rstrip('/')}/{path}/{token}"


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _normalize_optional_event_until(
    *,
    timeout_ms: float | None,
    until: datetime | str | None,
) -> str | None:
    if until is not None:
        return _normalize_until(until)
    if timeout_ms is None:
        return None
    if not math.isfinite(timeout_ms) or timeout_ms < 0:
        raise ValueError("timeout_ms must be finite and non-negative.")
    return (datetime.now(timezone.utc) + timedelta(milliseconds=timeout_ms)).isoformat()


def claim(key: str) -> bool:
    if not isinstance(key, str) or key == "":
        raise ValueError("Swizzle claim keys must be non-empty strings.")
    if _normalize_snapshot_file(os.getenv("SWIZZLE_STATE_FILE")) is None:
        return True
    step_key = f"{_CLAIM_PREFIX}{key}"
    snapshot = _read_steps_snapshot()
    if step_key in snapshot:
        return snapshot[step_key]["claimed"] is True
    _suspend_and_exit({"reason": "claim", "stepKey": step_key})
    raise RuntimeError("unreachable")


def get_webhook_headers() -> dict[str, str]:
    raw_headers = os.getenv("SWIZZLE_WEBHOOK_HEADERS")
    if raw_headers is None or raw_headers.strip() == "":
        return {}

    parsed = json.loads(raw_headers)
    if not isinstance(parsed, dict):
        return {}

    return {str(key): value for key, value in parsed.items() if isinstance(value, str)}


def get_raw_body() -> bytes:
    raw_body_path = os.getenv("SWIZZLE_WEBHOOK_RAW_BODY_PATH")
    if raw_body_path is None or raw_body_path.strip() == "":
        return b""

    with open(raw_body_path, "rb") as raw_body:
        return raw_body.read()


def verify_hmac(
    *,
    secret: str,
    signature: str | None,
    algorithm: str = "sha256",
    digest: str = "hex",
    payload: bytes | str | None = None,
    prefix: str = "",
) -> bool:
    if signature is None or secret == "":
        return False

    normalized_signature = signature.strip()
    if prefix != "" and normalized_signature.startswith(prefix):
        normalized_signature = normalized_signature[len(prefix) :]
    body = get_raw_body() if payload is None else payload
    body_bytes = body.encode() if isinstance(body, str) else body
    digestmod = getattr(hashlib, algorithm)
    expected_digest = hmac.new(secret.encode(), body_bytes, digestmod)
    if digest == "hex":
        expected_text = expected_digest.hexdigest()
    elif digest == "base64":
        expected_text = base64.b64encode(expected_digest.digest()).decode()
    else:
        raise ValueError("Supported HMAC digests: hex, base64.")
    return hmac.compare_digest(normalized_signature, expected_text)


def log_step(message: str, details: Any | None = None) -> None:
    entry = {
        "level": "info",
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": "step",
    }

    if details is not None:
        entry["details"] = details

    sys.stderr.write(_platform_json(entry, "Swizzle log details") + "\n")
    sys.stderr.flush()


def write_result(result: Any) -> None:
    sys.stdout.write(_platform_json(result, "The automation result") + "\n")
    sys.stdout.flush()


def run_automation(handler: Callable[[AutomationContext], Any]) -> int:
    context = AutomationContext(
        payload=read_payload(),
        metadata=get_automation_metadata(),
    )
    write_result(handler(context))
    return 0


@dataclass(frozen=True)
class ApiResponse:

    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    def text(self) -> str:
        return self.body.decode("utf-8")


def api_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = 30.0,
) -> ApiResponse:
    request = Request(url, data=data, headers=headers or {}, method=method.upper())
    try:
        with urlopen(request, timeout=timeout) as response:
            answer_headers = _lower_headers(response.headers)
            _report_api_contact(response.geturl(), method, response.status, answer_headers)
            return ApiResponse(status=response.status, headers=answer_headers, body=response.read())
    except HTTPError as error:
        answer_headers = _lower_headers(error.headers)
        _report_api_contact(error.geturl(), method, error.code, answer_headers)
        return ApiResponse(status=error.code, headers=answer_headers, body=error.read())


def _lower_headers(headers: Any) -> dict[str, str]:
    return {key.lower(): value for key, value in headers.items()}


def _report_api_contact(url: str, method: str, status: int, headers: dict[str, str]) -> None:
    parsed = urlparse(url)
    deprecation = headers.get("deprecation")
    sunset = headers.get("sunset")
    key = (parsed.netloc, status, deprecation, sunset)
    if key in _REPORTED_API_CONTACTS:
        return
    _REPORTED_API_CONTACTS.add(key)
    entry: dict[str, Any] = {
        "host": parsed.netloc,
        "method": method.upper(),
        "path": parsed.path or "/",
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": "api_contact",
    }
    if deprecation is not None:
        entry["deprecation"] = deprecation
    if sunset is not None:
        entry["sunset"] = sunset
    if (deprecation is not None or sunset is not None) and "link" in headers:
        entry["link"] = headers["link"]
    sys.stderr.write(json.dumps(entry) + "\n")
    sys.stderr.flush()


def contract_changed(api: str, field: str, expected: str, got: str) -> NoReturn:
    change = {"api": api, "field": field, "expected": expected, "got": got}
    sys.stderr.write(json.dumps({**change, "type": "contract_changed"}) + "\n")
    sys.stderr.flush()
    raise SystemExit(1)


def record_rate_limit_usage(group: str, count: int = 1) -> None:
    entry = {
        "type": "rate_limit_usage",
        "group": group,
        "count": count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    sys.stderr.write(json.dumps(entry) + "\n")
    sys.stderr.flush()


def pace(name: str) -> None:
    rate_limits = _declared_rate_limits()
    rate = rate_limits.get(name)
    if rate is None:
        if name not in _WARNED_UNKNOWN_PACE_NAMES:
            _WARNED_UNKNOWN_PACE_NAMES.add(name)
            sys.stderr.write(
                json.dumps(
                    {
                        "type": "pace_unknown_rate_limit",
                        "name": name,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                )
                + "\n"
            )
            sys.stderr.flush()
        return

    spacing = _parse_rate_spacing_seconds(rate)
    if spacing is None:
        return
    now = time.monotonic()
    next_allowed = _PACE_LAST_CALL_BY_NAME.get(name, 0.0) + spacing
    wait_seconds = max(0.0, next_allowed - now)
    if wait_seconds > 0:
        time.sleep(wait_seconds)
    _PACE_LAST_CALL_BY_NAME[name] = time.monotonic()


def _declared_rate_limits() -> dict[str, str]:
    raw = os.getenv("SWIZZLE_RATE_LIMITS")
    if raw is None or raw.strip() == "":
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        return {}
    return {str(key): value for key, value in parsed.items() if isinstance(value, str)}


def _parse_rate_spacing_seconds(rate: str) -> float | None:
    if "/" not in rate:
        return None
    amount_raw, unit = rate.strip().split("/", 1)
    try:
        amount = int(amount_raw)
    except ValueError:
        return None
    if amount <= 0:
        return None
    unit_seconds = {"sec": 1.0, "min": 60.0, "hour": 3600.0}.get(unit)
    if unit_seconds is None:
        return None
    return unit_seconds / amount


def _parse_optional_int(value: str | None) -> int | None:
    if value is None:
        return None

    try:
        return int(value)
    except ValueError:
        return None


getWebhookHeaders = get_webhook_headers
getRawBody = get_raw_body
verifyHmac = verify_hmac
getConnectionToken = get_connection_token
getConnectionTokenExpiry = get_connection_token_expiry
runStep = run_step
sleepUntil = sleep_until
invokeAutomation = invoke_automation
waitForEvent = wait_for_event
requestApproval = request_approval
getApprovalUrl = get_approval_url
getEventCallbackUrl = get_event_callback_url
