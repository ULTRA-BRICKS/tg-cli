"""Canonical guard for parsed JSON objects, excluding arrays and null."""

from typing import TypeGuard


def is_record(value: object) -> TypeGuard[dict[str, object]]:
    return isinstance(value, dict)
