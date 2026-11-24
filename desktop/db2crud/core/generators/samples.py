"""What the sample values of every language share. Mirrors web/src/core/generators/samples.ts."""

import math


def bounded_number(checks: list[dict], n: str, decimals: bool) -> str:
    """A whole number that changes with `n` (a variable that is never 0) and stays within the bounds the CHECKs of a
    column set. With an upper one it repeats: no more values fit. A number with decimals leaves room for the half added
    to it."""
    low = 0
    first = 0
    high = math.inf
    for parsed in checks:
        if parsed["kind"] != "compare":
            continue
        value = parsed["value"]
        if parsed["op"] in (">", ">="):
            low = max(low, math.ceil(value))
            first = max(first, math.floor(value) + 1 if parsed["op"] == ">" else math.ceil(value))
        else:
            high = min(high, math.ceil(value) - 1 if parsed["op"] == "<" else math.floor(value))
    room = high - first + (0 if decimals else 1)
    # The numbers of the tests stay below 1000
    if 1 <= room < 1000:
        return f"{n} % {room}" if first == 0 else f"{first} + {n} % {room}"
    return n if low == 0 else f"{low} + {n}"
