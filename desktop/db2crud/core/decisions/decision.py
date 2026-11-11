"""Decisions the tool proposes and the user reviews: the proposed value, how sure the proposal is and why. Review and
conflict proposals are never applied on their own; the generated code leaves a `TODO` in their place. Mirrors
web/src/core/decisions/decision.ts.

A decision is a dictionary: {"value", "status": "active" | "pending", "confidence", "manual"?, "reasons", "options"}.
Confidence follows personal_web_style (patterns/confidence-states.md): "exact", "high", "probable", "review",
"conflict" or "none". A reason is {"code", "params"?}; the interface translates its code.
"""

import json


def same_value(a, b) -> bool:
    """Whether two decision values are the same (they are plain JSON, compared as text like the web)."""
    return json.dumps(a) == json.dumps(b)


def decision(value, confidence: str, reasons: list[dict], options: list) -> dict:
    """A proposal: review and conflict wait for the user, the others are applied."""
    status = "pending" if confidence in ("review", "conflict") else "active"
    return {"value": value, "status": status, "confidence": confidence, "reasons": reasons, "options": options}


def reason(code: str, params: dict | None = None) -> dict:
    return {"code": code, "params": params} if params is not None else {"code": code}
