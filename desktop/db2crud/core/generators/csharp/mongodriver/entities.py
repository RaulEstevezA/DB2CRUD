"""The entity of each collection, for the MongoDB driver: the stored name and type of every field and a class per nested
document. Fields the classes do not know are left alone. Mirrors
web/src/core/generators/csharp/mongodriver/entities.ts."""

import re

from ...types import lines
from ..context import namespace_of, path_of
from ..csharp import CsUsings, cs_string
from ..documents import identified_lists


def _innermost(type_: dict) -> dict:
    return _innermost(type_["items"]) if type_["kind"] == "array" else type_


def _attributes(field: dict) -> list[str]:
    """How a field is stored: its name, its type when C#'s is another, and left out when it has no value."""
    type_ = _innermost(field["column"]["type"])
    return [
        ("[BsonId]" if field["column"]["name"] == "_id" else f"[BsonElement({cs_string(field['column']['name'])})]"),
        *(["[BsonRepresentation(BsonType.ObjectId)]"] if type_["kind"] == "text" and type_.get("objectId") else []),
        *(["[BsonRepresentation(BsonType.Decimal128)]"] if type_["kind"] == "decimal" else []),
        *(["[BsonGuidRepresentation(GuidRepresentation.Standard)]"] if type_["kind"] == "uuid" else []),
        *(["[BsonIgnoreIfNull]"] if field["optional"] else []),
    ]


def _properties(fields: list) -> list[str]:
    return [
        line
        for index, field in enumerate(fields)
        for line in [
            *([""] if index > 0 else []),
            *(
                [
                    (
                        "/// <summary>"
                        + re.sub(r"\s+", " ", field["column"]["comment"].replace("&", "&amp;").replace("<", "&lt;"))
                        + "</summary>"
                    )
                ]
                if field["column"].get("comment")
                else []
            ),
            *_attributes(field),
            f"public {field['propType']} {field['prop']} {{ get; set; }}{('' if field['optional'] or field['valueType'] else ' = null!;')}",
        ]
    ]


def _indented(items: list[str]) -> list[str]:
    return [("" if line == "" else f"    {line}") for line in items]


def _nested_block(item: dict) -> list[str]:
    return [
        "/// <summary>A nested document: it is stored with the one that holds it.</summary>",
        "[BsonIgnoreExtraElements]",
        f"public class {item['name']}",
        "{",
        *(
            _indented(
                [
                    *_properties(item["fields"]),
                    *(line for inner in item["classes"] for line in ["", *_nested_block(inner)]),
                ]
            )
        ),
        "}",
    ]


def entity_file(context: dict, info: dict) -> dict:
    ns = namespace_of(context, info, "entity")
    usings = CsUsings(ns).add("MongoDB.Bson", "MongoDB.Bson.Serialization.Attributes")
    lists = identified_lists(info)
    identify = (
        [
            "",
            "    /// <summary>Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents.</summary>",
            "    public void IdentifyItems()",
            "    {",
            *(
                f"        foreach (var item in {column['prop']} ?? []) item.Id ??= ObjectId.GenerateNewId().ToString();"
                for column in lists
            ),
            "    }",
        ]
        if len(lists) > 0
        else []
    )
    content = lines(
        usings.write(),
        "",
        f"namespace {ns};",
        "",
        f'/// <summary>A document of the "{info["name"]}" collection.</summary>',
        "[BsonIgnoreExtraElements]",
        f"public class {info['entity']}",
        "{",
        *_indented(_properties(info["columns"])),
        *identify,
        *[line for item in [*(info["nested"].values())] for line in ["", *(_indented(_nested_block(item)))]],
        "}",
        "",
    )
    return {"path": path_of(ns, info["entity"]), "content": content}
