"""Classes every PHP project shares (Laravel and Symfony): the error the API answers with, the one for code still
to write, and what a list asks the repositories for and what they answer. Mirrors
web/src/core/generators/languages/php/support.ts.
"""

from ...common.text import file_text, lines
from .php import PhpImports, php_doc, php_header


def php_file(context, namespace: str, name: str, imports: PhpImports, body: list) -> dict:
    return {
        "path": context.class_path(namespace, name),
        "content": file_text(lines(*php_header(namespace, imports), *body)),
    }


def exception_files(context) -> list[dict]:
    """Errors with the format of openapi.yaml: the exception, and the one for code still to write."""
    namespace = context.exceptions
    exception = php_file(
        context,
        namespace,
        "ApiException",
        PhpImports(namespace).add("RuntimeException"),
        [
            php_doc("An error the API answers with a status, a code and a message (see openapi.yaml)."),
            "final class ApiException extends RuntimeException",
            "{",
            "    /** @param list<array{field: string, message: string}> $details */",
            "    public function __construct(",
            "        public readonly int $status,",
            "        public readonly string $errorCode,",
            "        string $message,",
            "        public readonly array $details = [],",
            "    ) {",
            "        parent::__construct($message);",
            "    }",
            "",
            "    public static function invalid(string $field, string $message): self",
            "    {",
            "        return new self(400, 'validation_error', 'The request is not valid', [['field' => $field, 'message' => $message]]);",
            "    }",
            "",
            "    public static function unauthorized(): self",
            "    {",
            "        return new self(401, 'unauthorized', 'Missing or invalid credentials');",
            "    }",
            "",
            "    public static function forbidden(): self",
            "    {",
            "        return new self(403, 'forbidden', 'The credentials do not allow this operation');",
            "    }",
            "",
            "    public static function notFound(string $what): self",
            "    {",
            "        return new self(404, 'not_found', \"No {$what} has this key\");",
            "    }",
            "",
            "    public static function conflict(string $message): self",
            "    {",
            "        return new self(409, 'conflict', $message);",
            "    }",
            "}",
        ],
    )
    not_implemented = php_file(
        context,
        namespace,
        "NotImplementedException",
        PhpImports(namespace).add("RuntimeException"),
        [
            php_doc("Thrown by code still to write: the API answers 501."),
            "final class NotImplementedException extends RuntimeException",
            "{",
            "}",
        ],
    )
    return [exception, not_implemented]


def listing_files(context) -> list[dict]:
    """What a list asks the repositories for, and what they answer."""
    namespace = context.support
    return [
        php_file(
            context,
            namespace,
            "ListQuery",
            PhpImports(namespace),
            [
                php_doc(
                    "What a list asks a repository for: equality filters by JSON field name, an order and a window of items."
                ),
                "final class ListQuery",
                "{",
                "    /** @param array<string, mixed> $filters */",
                "    public function __construct(",
                "        public readonly array $filters = [],",
                "        public readonly ?string $sortField = null,",
                "        public readonly bool $descending = false,",
                "        public readonly int $offset = 0,",
                "        public readonly ?int $limit = null,",
                "    ) {",
                "    }",
                "",
                "    /**",
                '     * "-createdAt" sorts by createdAt in descending order.',
                "     *",
                "     * @param  array<string, mixed>  $filters",
                "     */",
                "    public static function of(array $filters, ?string $sort, int $offset = 0, ?int $limit = null): self",
                "    {",
                "        if ($sort === null || $sort === '') {",
                "            return new self($filters, null, false, $offset, $limit);",
                "        }",
                "        $descending = str_starts_with($sort, '-');",
                "",
                "        return new self($filters, $descending ? substr($sort, 1) : $sort, $descending, $offset, $limit);",
                "    }",
                "}",
            ],
        ),
        php_file(
            context,
            namespace,
            "ListResult",
            PhpImports(namespace),
            [
                php_doc("A window of items and how many match, whatever the window."),
                "final class ListResult",
                "{",
                "    /** @param list<array<string, mixed>> $items */",
                "    public function __construct(",
                "        public readonly array $items,",
                "        public readonly int $total,",
                "    ) {",
                "    }",
                "}",
            ],
        ),
    ]
