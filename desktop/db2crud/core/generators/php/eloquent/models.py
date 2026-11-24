"""The model of each table for Eloquent 12 (without Laravel): the table, its key, the casts that give each column its PHP
type, the defaults the database would set, and a @property per column so editors know them. Eloquent keys a model by
one column: for a key of several columns, or none, the repositories read and write by every column of it, and the
model says so. Mirrors web/src/core/generators/php/eloquent/models.ts."""

from ..common.context import namespace_of, path_of, php_file
from ..common.php import php_string
from ..common.repositories import default_literal

DATE_TIME = "\\DateTimeImmutable"


def eloquent_php_type(column_type: dict) -> str:
    """The PHP type of a value as Eloquent gives it, with the casts of the model."""
    kind = column_type["kind"]
    if kind == "integer":
        return "int"
    if kind == "float":
        return "float"
    if kind == "boolean":
        return "bool"
    # CarbonImmutable, which is a DateTimeImmutable
    if kind in ("date", "datetime"):
        return DATE_TIME
    if kind in ("json", "array"):
        return "mixed"
    # A time of day has no cast of its own: its text
    return "string"


def _cast(context: dict, column: dict) -> str | None:
    """The cast of a column, when its value needs one."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    if kind == "integer":
        return "integer"
    if kind == "float":
        return "float"
    if kind == "boolean":
        return "boolean"
    if kind == "decimal":
        return f"decimal:{column_type['scale']}" if column_type.get("scale") is not None else None
    if kind == "date":
        return "immutable_date"
    if kind == "datetime":
        return "immutable_datetime"
    if kind == "array" and context["settings"]["database"] == "postgresql":
        return f"\\{context['base']}\\PgArray::class{_array_item(column_type)}"
    if kind in ("json", "array"):
        return "json"
    return None


def _array_item(column_type: dict) -> str:
    """The argument of the cast of an array: the PHP type of its items, when it is not text."""
    item = column_type["items"] if column_type["kind"] == "array" else column_type
    if item["kind"] == "array":
        return _array_item(item)
    php = {"integer": "int", "float": "float", "boolean": "bool"}.get(item["kind"])
    return f" . ':{php}'" if php else ""


def pg_array_file(context: dict) -> dict | None:
    """PgArray.php, when a model has an array of PostgreSQL: its cast."""
    if context["settings"]["database"] != "postgresql" or not any(
        info["writesEntity"] and any(column["column"]["type"]["kind"] == "array" for column in info["columns"])
        for info in context["tables"]
    ):
        return None
    return php_file(
        path_of(context["base"], "PgArray"),
        context["base"],
        "use Illuminate\\Contracts\\Database\\Eloquent\\CastsAttributes;",
        [
            "/**",
            " * An array of PostgreSQL ({a,b}) as a PHP array; its items are text, or of the type the cast names.",
            " *",
            " * @implements CastsAttributes<array<int, mixed>, array<int, mixed>>",
            " */",
            "final class PgArray implements CastsAttributes",
            "{",
            "    public function __construct(private readonly string $item = 'string')",
            "    {",
            "    }",
            "",
            "    public function get($model, string $key, mixed $value, array $attributes): ?array",
            "    {",
            "        if ($value === null) {",
            "            return null;",
            "        }",
            "        $at = 0;",
            "        return $this->read((string) $value, $at);",
            "    }",
            "",
            "    public function set($model, string $key, mixed $value, array $attributes): ?string",
            "    {",
            "        return is_array($value) ? $this->write($value) : $value;",
            "    }",
            "",
            "    /** The array that starts at a position of the text, which is left after it. */",
            "    private function read(string $text, int &$at): array",
            "    {",
            "        $items = [];",
            "        $at++;",
            "        while ($text[$at] !== '}') {",
            "            if ($text[$at] === ',') {",
            "                $at++;",
            "            } elseif ($text[$at] === '{') {",
            "                $items[] = $this->read($text, $at);",
            "            } elseif ($text[$at] === '\"') {",
            "                $item = '';",
            "                for ($at++; $text[$at] !== '\"'; $at++) {",
            "                    if ($text[$at] === '\\\\') {",
            "                        $at++;",
            "                    }",
            "                    $item .= $text[$at];",
            "                }",
            "                $at++;",
            "                $items[] = $this->item($item);",
            "            } else {",
            "                $length = strcspn($text, ',}', $at);",
            "                $item = substr($text, $at, $length);",
            "                $at += $length;",
            "                $items[] = $item === 'NULL' ? null : $this->item($item);",
            "            }",
            "        }",
            "        $at++;",
            "        return $items;",
            "    }",
            "",
            "    private function item(string $text): int|float|bool|string",
            "    {",
            "        return match ($this->item) {",
            "            'int' => (int) $text,",
            "            'float' => (float) $text,",
            "            'bool' => $text === 't',",
            "            default => $text,",
            "        };",
            "    }",
            "",
            "    private function write(array $items): string",
            "    {",
            "        $written = array_map(fn (mixed $item): string => match (true) {",
            "            $item === null => 'NULL',",
            "            is_array($item) => $this->write($item),",
            "            is_bool($item) => $item ? 't' : 'f',",
            "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
            "        }, $items);",
            "        return '{' . implode(',', $written) . '}';",
            "    }",
            "}",
        ],
    )


def single_key(info: dict) -> bool:
    """Whether Eloquent can key the model by its primary key: one column."""
    return info["table"]["primaryKey"] is not None and len(info["table"]["primaryKey"]) == 1


def eloquent_model_file(context: dict, info: dict) -> dict:
    ns = namespace_of(context, info, "entity")
    table = info["table"]
    key = info["key"][0] if single_key(info) else None
    casts = [(column, _cast(context, column)) for column in info["columns"] if _cast(context, column) is not None]

    def literal(column: dict) -> bool:
        default = column["column"].get("default")
        return bool(
            default and default["kind"] == "literal" and default["value"] is not None and column["php"] != DATE_TIME
        )

    defaults = [column for column in info["columns"] if literal(column)]
    notes = []
    for item in table["foreignKeys"]:
        on_delete = f", on delete {item['onDelete']}" if item.get("onDelete") else ""
        notes.append(
            f" * Foreign key: {', '.join(item['columns'])} → {item['references']['table']}"
            f"({', '.join(item['references']['columns'])}){on_delete}."
        )
    notes.extend(
        f" * CHECK ({check['sql']}): the service checks what it understands of it." for check in table["checks"]
    )
    if not key:
        if table["primaryKey"] is not None:
            notes.append(
                f" * Its key has several columns ({', '.join(table['primaryKey'])}): Eloquent keys a model by one, so the "
                "repository reads and writes it by all of them."
            )
        else:
            notes.append(" * The table has no primary key: the repository tells its rows apart by all their columns.")
    comment = f": {table['comment']}" if table.get("comment") else ""
    name = f"{table['schema']}.{table['name']}" if table.get("schema") else table["name"]
    incrementing = "true" if key and key["column"].get("generated") == "identity" else "false"
    unknown = [column for column in info["columns"] if column["column"]["type"]["kind"] == "unknown"]
    body = [
        "/**",
        f' * A row of the "{table["name"]}" table{comment}.',
        *([" *", *notes] if notes else []),
        " *",
        # Any attribute may be unset until the row is stored
        *(
            f" * @property {column['php']}{'' if column['php'] == 'mixed' else '|null'} ${column['prop']}"
            for column in info["columns"]
        ),
        " */",
        f"class {info['entity']} extends Model",
        "{",
        f"    protected $table = {php_string(name)};",
        "",
        f"    protected $primaryKey = {php_string(key['column']['name'])};"
        if key
        else "    protected $primaryKey = null;",
        "",
        f"    public $incrementing = {incrementing};",
        *(["", "    protected $keyType = 'string';"] if key and key["php"] == "string" else []),
        "",
        "    /** The table has no created_at and updated_at of Eloquent's own */",
        "    public $timestamps = false;",
        "",
        "    /** How dates are written to the database */",
        "    protected $dateFormat = 'Y-m-d H:i:s';",
    ]
    if defaults:
        body.extend(
            [
                "",
                "    /** The values the database sets when a row leaves them out */",
                "    protected $attributes = [",
                *(
                    f"        {php_string(column['column']['name'])} => "
                    f"{default_literal(column, column['column']['default']['value'])},"
                    for column in defaults
                ),
                "    ];",
            ]
        )
    if casts:
        body.extend(
            [
                "",
                "    /** @var array<string, string> */",
                "    protected $casts = [",
                *(
                    f"        {php_string(column['column']['name'])} => {item if '::class' in item else php_string(item)},"
                    for column, item in casts
                ),
                "    ];",
            ]
        )
    if unknown:
        listed = ", ".join(f'"{column["column"]["type"]["sql"]}"' for column in unknown)
        body.extend(["", f"    // TODO: {listed} has no cast here; kept as text"])
    body.append("}")
    return php_file(path_of(ns, info["entity"]), ns, "use Illuminate\\Database\\Eloquent\\Model;", body)
