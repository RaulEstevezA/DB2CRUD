"""`app/models.py`: the Beanie document of every collection and the models of the documents inside it, as the database
has them (stored names and types). The repositories turn them into the project's entities. Mirrors
web/src/core/generators/python/beanie/models.ts."""

from ....schema.documents import is_object_id
from ...types import lines
from ..common.context import py_type
from ..common.documents import inner_first, nested_types
from ..python import Imports, py_literal, snake_name


def document_class(info: dict) -> str:
    return f"{info['entity']}Document"


def model_class(nested: dict) -> str:
    return f"{nested['name']}Model"


def models_of(info: dict) -> dict[str, dict]:
    """The models of the nested documents of a collection, by column."""
    return nested_types(info["table"]["columns"], info["entity"])


# Names a Beanie document or a Pydantic model uses for something else
_TAKEN = set(
    (
        "add_child aggregate all avg bulk_writer construct copy count create current_date delete delete_all dict distinct "
        "fetch_all_links fetch_link fill_back_refs find find_all find_many find_one from_orm get get_bson_encoders get_changes "
        "get_collection_name get_link_fields get_model_type get_previous_changes get_previous_saved_state get_pymongo_collection "
        "get_saved_state get_settings has_changed id inc insert insert_many insert_one inspect_collection is_changed json lazy_parse "
        "link_from_id max min model_computed_fields model_config model_construct model_copy model_dump model_dump_json model_extra "
        "model_fields model_fields_set model_json_schema model_parametrized_name model_post_init model_rebuild model_validate "
        "model_validate_json model_validate_strings parse_file parse_obj parse_raw parse_store replace replace_many revision_id "
        "rollback save save_changes schema schema_json set set_collection set_collection_name set_database settings "
        "state_management_replace_objects state_management_save_previous sum sync to_ref update update_all update_forward_refs "
        "use_state_management validate validate_self Any Decimal Field bool bytes datetime float int list str"
    ).split(" ")
)


def _stored_type(column_type: dict, nested: dict | None, imports: Imports) -> str:
    """The type of a value as the database keeps it."""
    kind = column_type["kind"]
    if kind == "array":
        return f"list[{_stored_type(column_type['items'], nested, imports)}]"
    if kind == "json" and column_type.get("fields") is not None and nested:
        return model_class(nested)
    if kind == "text":
        if not is_object_id(column_type):
            return "str"
        imports.from_("beanie", "PydanticObjectId")
        return "PydanticObjectId"
    if kind == "integer":
        return "Long" if column_type["bits"] == 64 else "int"
    if kind == "decimal":
        imports.from_("beanie", "DecimalAnnotation")
        return "DecimalAnnotation"
    return py_type(column_type, imports)


def _key_type(column_type: dict, imports: Imports) -> str:
    """Beanie takes only a class as the type of an identifier."""
    return _stored_type(column_type, None, imports) if is_object_id(column_type) else py_type(column_type, imports)


def _field_line(column: dict, nested: dict | None, taken: set[str], imports: Imports) -> str:
    attr = snake_name(column["name"])
    while attr in _TAKEN or attr in taken:
        attr += "_"
    taken.add(attr)
    # Every field may be missing: the services check what must be there, and the documents that are stored are read as
    # they are
    value = "None" if attr == column["name"] else f"Field(default=None, alias={py_literal(column['name'])})"
    if attr != column["name"]:
        imports.from_("pydantic", "Field")
    return f"    {attr}: {_stored_type(column['type'], nested, imports)} | None = {value}"


def _nested_block(nested: dict, imports: Imports) -> list:
    taken: set[str] = set()
    return [
        "",
        "",
        f"class {model_class(nested)}(BaseModel):",
        '    """A document inside another. Fields it does not name are kept."""',
        "",
        '    model_config = ConfigDict(extra="allow", protected_namespaces=())',
        "",
        *(_field_line(field["column"], field["nested"], taken, imports) for field in nested["fields"]),
    ]


def _document_block(info: dict, imports: Imports) -> list:
    types = models_of(info)
    taken: set[str] = set()
    table = info["table"]
    nullable = {column["name"]: column["nullable"] for column in table["columns"]}

    def index(item: dict, options: list[str]) -> str:
        keys = ", ".join(f"({py_literal(name)}, 1)" for name in item["columns"])
        named = [f"name={py_literal(item['name'])}"] if item.get("name") else []
        return f"            IndexModel([{keys}]{''.join(f', {option}' for option in [*named, *options])}),"

    indexes = []
    for unique in table["uniques"]:
        sparse = ["sparse=True"] if all(nullable.get(name) for name in unique["columns"]) else []
        indexes.append(index(unique, ["unique=True", *sparse]))
    indexes += [index(item, []) for item in table["indexes"]]
    if indexes:
        imports.from_("pymongo", "IndexModel")
    nested = [block for item in types.values() for one in inner_first(item) for block in _nested_block(one, imports)]
    fields = []
    for column in info["columns"]:
        db = column["column"]
        if db["name"] == "_id":
            fields.append(f'    id: {_key_type(db["type"], imports)} | None = Field(default=None, alias="_id")')
        else:
            fields.append(_field_line(db, types.get(db["name"]), taken, imports))
    comment = f": {table['comment']}" if table.get("comment") else ""
    return [
        *nested,
        "",
        "",
        f"class {document_class(info)}(Document):",
        f'    """A document of the "{info["name"]}" collection{comment}."""',
        "",
        "    model_config = ConfigDict(populate_by_name=False, protected_namespaces=())",
        "",
        *fields,
        "",
        "    class Settings:",
        f"        name = {py_literal(info['name'])}",
        "        keep_nulls = False",
        *(
            [
                "        # Only the tests create them: in the application the database already has its own",
                "        indexes = [",
                *indexes,
                "        ]",
            ]
            if indexes
            else []
        ),
    ]


def models_file(context: dict) -> dict:
    imports = (
        Imports()
        .from_("beanie", "Document")
        .from_("pydantic", "BaseModel", "ConfigDict", "Field", "PlainValidator")
        .from_("bson.int64", "Int64")
        .from_("typing", "Annotated")
    )
    blocks = [line for info in context["tables"] for line in _document_block(info, imports)]
    return {
        "path": "app/models.py",
        "content": lines(
            '"""The Beanie document of every collection, as the database has them."""',
            "",
            imports.write("app"),
            "",
            "Long = Annotated[int, PlainValidator(Int64)]",
            '"""A whole number of 64 bits, stored as one whatever its value."""',
            *blocks,
            "",
            "",
            f"DOCUMENTS: list[type[Document]] = [{', '.join(document_class(info) for info in context['tables'])}]",
            '"""Every document, for `init_beanie`."""',
            "",
        ),
    }
