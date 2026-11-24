"""Nested documents in a TypeScript project: src/documents.ts, which checks them against their rules, the rules of each
collection, and the items of its lists that operations add and remove one by one. Mirrors
web/src/core/generators/typescript/common/documents.ts."""

import re

from ....js import number_text
from ....schema.documents import item_key
from ...types import lines
from ..typescript import member_name, quote, ts_literal
from .context import column_of, ts_type


def _key(name: str) -> str:
    return name if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name) else quote(name)


_LIMITS = {">=": "min", ">": "above", "<=": "max", "<": "below"}


def _limits(checks: list[dict]) -> list[str]:
    """The limits of the CHECKs of a field, as settings of its rule."""
    result = []
    for check in checks:
        parsed = check.get("parsed")
        if not parsed:
            continue
        if parsed["kind"] == "in":
            result.append(f"values: [{', '.join(ts_literal(value) for value in parsed['values'])}]")
        elif parsed["kind"] == "compare":
            result.append(f"{_LIMITS[parsed['op']]}: {number_text(parsed['value'])}")
        elif parsed["op"] in (">=", "<="):
            name = "minLength" if parsed["op"] == ">=" else "maxLength"
            result.append(f"{name}: {number_text(parsed['value'])}")
    return result


def _type_rule(schema: dict, column_type: dict) -> list[str]:
    kind = column_type["kind"]
    if kind == "array":
        return [f"items: {_braces(_type_rule(schema, column_type['items']))}"]
    if kind == "json" and column_type.get("fields") is not None:
        fields = [
            f"{_key(field['name'])}: {_field_rule(schema, field)}"
            for field in column_type["fields"]
            if field["name"] != "_id"
        ]
        return [f"fields: {_braces(fields)}"]
    if kind == "enum":
        item = next((item for item in schema["enums"] if item["name"] == column_type["name"]), None)
        return [f"values: [{', '.join(quote(value) for value in (item['values'] if item else []))}]"]
    if kind == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        return [f"maxLength: {number_text(column_type['length'])}"]
    return []


def _braces(items: list[str]) -> str:
    return f"{{ {', '.join(items)} }}" if items else "{}"


def _field_rule(schema: dict, field: dict) -> str:
    required = [] if field["nullable"] or field.get("default") else ["required: true"]
    return _braces([*required, *_type_rule(schema, field["type"]), *_limits(field.get("checks") or [])])


_SAYS = re.compile(r"\b(required|values|min|max|above|below|minLength|maxLength|fields|items: \{ )")


def document_rules(context: dict, info: dict) -> list[dict]:
    """The columns that hold documents, or lists, with the rule of each: {column, rule}."""
    result = []
    for column in info["columns"]:
        column_type = column["column"]["type"]
        if column_type["kind"] == "array" or (column_type["kind"] == "json" and column_type.get("fields") is not None):
            rule = _type_rule(context["schema"], column_type)
            if _SAYS.search(",".join(rule)):
                result.append({"column": column, "rule": _braces(rule)})
    return result


def uses_documents(context: dict) -> bool:
    return any(info["service"] and document_rules(context, info) for info in context["tables"])


_DOCUMENTS = [
    "/** The rules of the documents inside others, and what does not follow them. */",
    "import type { FieldError } from './errors.js'",
    "",
    "/** What a value must be: the fields of a document, the items of a list, the values or limits of anything else. */",
    "export interface Rule {",
    "  required?: boolean",
    "  fields?: Record<string, Rule>",
    "  items?: Rule",
    "  values?: readonly unknown[]",
    "  min?: number",
    "  above?: number",
    "  max?: number",
    "  below?: number",
    "  minLength?: number",
    "  maxLength?: number",
    "}",
    "",
    "/** What a value does not follow of its rule, each with the path of its field: `lines.0.quantity`. Fields the rules do not name are left alone. */",
    "export function problems(value: unknown, rule: Rule, path: string): FieldError[] {",
    "  if (value === null || value === undefined) return rule.required ? [{ field: path, message: 'is required' }] : []",
    "  const errors: FieldError[] = []",
    "  const wrong = (message: string) => errors.push({ field: path, message })",
    "  if (rule.items) {",
    "    if (!Array.isArray(value)) return [{ field: path, message: 'must be a list' }]",
    "    value.forEach((item, index) => errors.push(...problems(item, { ...rule.items, required: true }, `${path}.${index}`)))",
    "  }",
    "  if (rule.fields) {",
    "    if (typeof value !== 'object' || Array.isArray(value)) return [{ field: path, message: 'must be a document' }]",
    "    for (const [name, field] of Object.entries(rule.fields)) errors.push(...problems((value as Record<string, unknown>)[name], field, `${path}.${name}`))",
    "  }",
    "  if (rule.values && !rule.values.includes(value)) wrong(`must be one of: ${rule.values.join(', ')}`)",
    "  if (rule.min !== undefined && Number(value) < rule.min) wrong(`must be >= ${rule.min}`)",
    "  if (rule.above !== undefined && Number(value) <= rule.above) wrong(`must be > ${rule.above}`)",
    "  if (rule.max !== undefined && Number(value) > rule.max) wrong(`must be <= ${rule.max}`)",
    "  if (rule.below !== undefined && Number(value) >= rule.below) wrong(`must be < ${rule.below}`)",
    "  if (rule.minLength !== undefined && String(value).length < rule.minLength) wrong(`must have >= ${rule.minLength} characters`)",
    "  if (rule.maxLength !== undefined && String(value).length > rule.maxLength) wrong(`is longer than ${rule.maxLength} characters`)",
    "  return errors",
    "}",
    "",
]


def documents_file(context: dict) -> dict | None:
    if not uses_documents(context):
        return None
    return {"path": "src/documents.ts", "content": lines(*_DOCUMENTS)}


def list_of(info: dict, query: dict) -> dict:
    """A list of a collection whose items are added and removed one by one: {column, item, type, by, params}. item is the
    name of one in code, by how it is told from the others, and params those that say which one to remove."""
    column = column_of(info, query["columns"][0])
    items = column["column"]["type"]["items"]
    # The name of the item is that of the operation: addLine adds a line
    name = member_name(re.sub(r"^(add|remove)", "", query["name"]))
    item = f"{name}Item" if any(other["prop"] == name for other in info["key"]) else name
    by = item_key(items)
    if by == "id":
        params = [{"name": f"{item}Id", "type": "string"}]
    elif by == "value":
        params = [{"name": item, "type": ts_type(items)}]
    else:
        params = [{"name": "position", "type": "number"}]
    return {"column": column, "item": item, "type": ts_type(items), "by": by, "params": params}
