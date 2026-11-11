"""Building proposals. Mirrors web/src/core/design/decision.ts."""


def decision(value, confidence: str, reasons: list[dict], options: list) -> dict:
    """A proposal: review and conflict wait for the user, the others are applied."""
    status = "pending" if confidence in ("review", "conflict") else "active"
    return {"value": value, "status": status, "confidence": confidence, "reasons": reasons, "options": options}


def reason(code: str, params: dict | None = None) -> dict:
    return {"code": code, "params": params} if params else {"code": code}
