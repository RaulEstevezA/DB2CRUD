"""What every PHP project shares: the domain errors services throw (no HTTP codes), the pages lists are read in, Patch (a
field of an update: absent, or a value that may be null), new uuids, and the unit of work over the repositories, with
its in-memory version. Mirrors web/src/core/generators/php/common/support.ts."""

from ....schema.documents import is_object_id
from .context import (
    class_name,
    common_namespace,
    errors_namespace,
    ind,
    memory_repository_class,
    namespace_of,
    path_of,
    php_file,
    repository_type,
)
from .php import PhpUses


def _file(ns: str, name: str, body: list, uses: str = "") -> dict:
    return php_file(path_of(ns, name), ns, uses, [line for line in body if isinstance(line, str)])


def error_files(context: dict) -> list[dict]:
    ns = errors_namespace(context)
    return [
        _file(
            ns,
            "DomainException",
            [
                "/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the "
                "services translates them. */",
                "abstract class DomainException extends \\RuntimeException",
                "{",
                "}",
            ],
        ),
        _file(
            ns,
            "NotFoundException",
            [
                "/** No row has this key. */",
                "final class NotFoundException extends DomainException",
                "{",
                "    public function __construct(public readonly string $entity, public readonly mixed $key)",
                "    {",
                "        $text = fn (mixed $value) => $value instanceof \\DateTimeInterface ? $value->format('Y-m-d H:i:s') : strval($value);",
                "        parent::__construct(\"No {$entity} has the key \" . implode(', ', array_map($text, is_array($key) ? $key : [$key])));",
                "    }",
                "}",
            ],
        ),
        _file(
            ns,
            "ConflictException",
            [
                "/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */",
                "final class ConflictException extends DomainException",
                "{",
                "    /** @param list<string> $fields */",
                "    public function __construct(public readonly string $entity, public readonly string $reason, "
                "public readonly array $fields = [])",
                "    {",
                '        parent::__construct("{$entity}: {$reason}");',
                "    }",
                "}",
            ],
        ),
        _file(
            ns,
            "FieldError",
            [
                "/** What is wrong with one field. */",
                "final readonly class FieldError",
                "{",
                "    public function __construct(public string $field, public string $message)",
                "    {",
                "    }",
                "}",
            ],
        ),
        _file(
            ns,
            "ValidationFailedException",
            [
                "/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */",
                "final class ValidationFailedException extends DomainException",
                "{",
                "    /** @param list<FieldError> $errors */",
                "    public function __construct(public readonly string $entity, public readonly array $errors)",
                "    {",
                "        parent::__construct($entity . ': ' . implode('; ', array_map(fn (FieldError $error) => "
                '"{$error->field}: {$error->message}", $errors)));',
                "    }",
                "}",
            ],
        ),
    ]


def makes_uuids(context: dict) -> bool:
    """Whether a repository makes uuids before an insert: a column the database fills with one."""
    return any(
        column["column"].get("generated") == "uuid" and not is_object_id(column["column"]["type"])
        for info in context["tables"]
        for column in info["columns"]
    )


PAGE = [
    "/**",
    " * A page of a list: the rows from an offset, and how many there are in all.",
    " *",
    " * @template T",
    " */",
    "final readonly class Page",
    "{",
    "    /** @param list<T> $items */",
    "    public function __construct(public array $items, public int $total, public int $offset, public int $limit)",
    "    {",
    "    }",
    "",
    "    /**",
    "     * The same page with every row turned into something else.",
    "     *",
    "     * @template R",
    "     * @param callable(T): R $mapper",
    "     * @return Page<R>",
    "     */",
    "    public function map(callable $mapper): self",
    "    {",
    "        return new self(array_map($mapper, $this->items), $this->total, $this->offset, $this->limit);",
    "    }",
    "}",
]

CURSOR_PAGE = [
    "/**",
    " * A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the "
    "last page).",
    " *",
    " * @template T",
    " */",
    "final readonly class CursorPage",
    "{",
    "    /**",
    "     * @param list<T> $items",
    "     * @param list<mixed>|null $next",
    "     */",
    "    public function __construct(public array $items, public ?array $next)",
    "    {",
    "    }",
    "",
    "    /**",
    "     * The same page with every row turned into something else.",
    "     *",
    "     * @template R",
    "     * @param callable(T): R $mapper",
    "     * @return CursorPage<R>",
    "     */",
    "    public function map(callable $mapper): self",
    "    {",
    "        return new self(array_map($mapper, $this->items), $this->next);",
    "    }",
    "}",
]

PATCH = [
    "/**",
    " * A field of an update: absent (it keeps its value), or present with a value, which may be null.",
    " *",
    " * @template T",
    " */",
    "final readonly class Patch",
    "{",
    "    /** An absent field; use Patch::of() for one with a value. */",
    "    public function __construct(public bool $isPresent = false, public mixed $value = null)",
    "    {",
    "    }",
    "",
    "    /**",
    "     * The field keeps its value.",
    "     *",
    "     * @return Patch<mixed>",
    "     */",
    "    public static function absent(): self",
    "    {",
    "        return new self();",
    "    }",
    "",
    "    /**",
    "     * The field takes this value, which may be null.",
    "     *",
    "     * @template V",
    "     * @param V $value",
    "     * @return Patch<V>",
    "     */",
    "    public static function of(mixed $value): self",
    "    {",
    "        return new self(true, $value);",
    "    }",
    "}",
]

UUID = [
    "/** New uuids, for the columns the database fills with one: not every database can, so they are made before the "
    "insert. */",
    "final class Uuid",
    "{",
    "    /** A random uuid (version 4). */",
    "    public static function v4(): string",
    "    {",
    "        $bytes = random_bytes(16);",
    "        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);",
    "        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);",
    "        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));",
    "    }",
    "}",
]


def common_files(context: dict) -> list[dict]:
    ns = common_namespace(context)
    settings = context["settings"]
    files = []
    if settings["paging"] == "offset":
        files.append(_file(ns, "Page", PAGE))
    if settings["paging"] == "cursor":
        files.append(_file(ns, "CursorPage", CURSOR_PAGE))
    if settings["services"] and settings["updates"] == "patch":
        files.append(_file(ns, "Patch", PATCH))
    if makes_uuids(context):
        files.append(_file(ns, "Uuid", UUID))
    return files


HOW = {
    "operation": "Each service operation runs in transaction(): committed when it ends, rolled back when it fails.",
    "caller": "Services never commit: whoever holds the connection opens and ends its transaction; transaction() only "
    "groups the code.",
    "repository": "Every repository write is committed at once; transaction() only groups the code.",
}


def repository_properties(context: dict, uses: PhpUses, value=None) -> list[str]:
    """The repositories a unit of work holds, with their uses."""
    result = []
    for info in context["tables"]:
        uses.add(class_name(namespace_of(context, info, "repository"), repository_type(context, info)))
        result.append(
            f"public readonly {repository_type(context, info)} ${info['attr']};"
            if value
            else f"public {repository_type(context, info)} ${info['attr']} {{ get; }}"
        )
    return result


def repository_assignments(context: dict, value) -> list[str]:
    """The assignments of a unit of work's constructor."""
    return [f"$this->{info['attr']} = {value(info)};" for info in context["tables"]]


def unit_of_work_files(context: dict) -> list[dict]:
    """UnitOfWork, SqlUnitOfWork (written by the ORM) and MemoryUnitOfWork, in the root namespace."""
    ns = context["base"]
    settings = context["settings"]
    interface_uses = PhpUses(ns)
    body = [
        f"/** What services depend on: a repository per table and a transaction. {HOW[settings['transactions']]} */",
        "interface UnitOfWork",
        "{",
        *ind(repository_properties(context, interface_uses)),
        "",
        "    /**",
        "     * Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws.",
        "     *",
        "     * @template T",
        "     * @param callable(UnitOfWork): T $work",
        "     * @return T",
        "     */",
        "    public function transaction(callable $work): mixed;",
        "}",
    ]
    files = [_file(ns, "UnitOfWork", body, interface_uses.write())]
    sql_uses = PhpUses(ns)
    sql = context["orm"]["unitOfWork"](context, sql_uses)
    files.append(_file(ns, "SqlUnitOfWork", sql, sql_uses.write()))
    if settings["memoryRepositories"]:
        uses = PhpUses(ns)
        properties = repository_properties(context, uses, lambda info: info["attr"])
        for info in context["tables"]:
            uses.add(class_name(namespace_of(context, info, "repository"), memory_repository_class(info)))
        body = [
            "/** The in-memory repositories, for tests and for trying the services without a database. */",
            "final class MemoryUnitOfWork implements UnitOfWork",
            "{",
            *ind(properties),
            "",
            "    public function __construct()",
            "    {",
            *ind(repository_assignments(context, lambda info: f"new {memory_repository_class(info)}()"), 8),
            "    }",
            "",
            "    /** Memory has no transactions: changes are kept as they are made. */",
            "    public function transaction(callable $work): mixed",
            "    {",
            "        return $work($this);",
            "    }",
            "}",
        ]
        files.append(_file(ns, "MemoryUnitOfWork", body, uses.write()))
    return files
