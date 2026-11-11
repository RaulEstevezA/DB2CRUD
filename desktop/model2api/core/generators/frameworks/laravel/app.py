"""Files of the Laravel project that do not belong to one resource: the application bootstrap, the entry points,
the error format and its renderer, list queries, the base of request bodies, the rule that checks blank texts,
authentication middleware, configuration and the service provider that binds each repository. Mirrors
web/src/core/generators/frameworks/laravel/app.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.text import file_text, lines
from ...languages.php.php import PhpImports, php_doc, php_header, php_string
from .context import LaravelContext, class_path, names, qualified


def php_file(namespace: str, name: str, imports: PhpImports, body: list) -> dict:
    return {"path": class_path(namespace, name), "content": file_text(lines(*php_header(namespace, imports), *body))}


def bootstrap_files(context: LaravelContext) -> list[dict]:
    auth = context.settings["auth"]
    imports = [
        "use App\\Exceptions\\ApiErrors;",
        auth == "apiKey" and "use App\\Http\\Middleware\\RequireApiKey;",
        auth == "jwt" and "use App\\Http\\Middleware\\AuthenticateToken;",
        "use Illuminate\\Foundation\\Application;",
        "use Illuminate\\Foundation\\Configuration\\Exceptions;",
        "use Illuminate\\Foundation\\Configuration\\Middleware;",
        "use Illuminate\\Foundation\\Http\\Middleware\\ConvertEmptyStringsToNull;",
        "use Illuminate\\Foundation\\Http\\Middleware\\TrimStrings;",
    ]
    app = lines(
        "<?php",
        "",
        imports,
        "",
        "// Builds the application: the routes of routes/api.php at the root of the site, the middleware of each",
        "// protection, and one error format for every answer (see openapi.yaml).",
        "return Application::configure(basePath: dirname(__DIR__))",
        "    ->withRouting(",
        "        api: __DIR__.'/../routes/api.php',",
        "        apiPrefix: '',",
        "    )",
        "    ->withMiddleware(function (Middleware $middleware): void {",
        "        // Bodies are read as sent: an empty text stays empty and spaces are kept",
        "        $middleware->remove([ConvertEmptyStringsToNull::class, TrimStrings::class]);",
        auth == "apiKey" and "        $middleware->alias(['api.key' => RequireApiKey::class]);",
        auth == "jwt" and "        $middleware->alias(['token' => AuthenticateToken::class]);",
        "    })",
        "    ->withExceptions(function (Exceptions $exceptions): void {",
        "        $exceptions->render(fn (Throwable $error) => ApiErrors::render($error));",
        "    })->create();",
    )
    providers = lines(
        "<?php", "", "use App\\Providers\\AppServiceProvider;", "", "return [", "    AppServiceProvider::class,", "];"
    )
    artisan = lines(
        "#!/usr/bin/env php",
        "<?php",
        "",
        "use Illuminate\\Foundation\\Application;",
        "use Symfony\\Component\\Console\\Input\\ArgvInput;",
        "",
        "define('LARAVEL_START', microtime(true));",
        "",
        "require __DIR__.'/vendor/autoload.php';",
        "",
        "/** @var Application $app */",
        "$app = require_once __DIR__.'/bootstrap/app.php';",
        "",
        "exit($app->handleCommand(new ArgvInput));",
    )
    index = lines(
        "<?php",
        "",
        "use Illuminate\\Foundation\\Application;",
        "use Illuminate\\Http\\Request;",
        "",
        "define('LARAVEL_START', microtime(true));",
        "",
        "if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {",
        "    require $maintenance;",
        "}",
        "",
        "require __DIR__.'/../vendor/autoload.php';",
        "",
        "/** @var Application $app */",
        "$app = require_once __DIR__.'/../bootstrap/app.php';",
        "",
        "$app->handleRequest(Request::capture());",
    )

    # Folders Laravel writes to at run time; a .gitignore keeps each one in the project
    def keep(path: str, rules: str = "*\n!.gitignore") -> dict:
        return {"path": f"{path}/.gitignore", "content": file_text(rules)}

    return [
        {"path": "bootstrap/app.php", "content": file_text(app)},
        {"path": "bootstrap/providers.php", "content": file_text(providers)},
        keep("bootstrap/cache"),
        {"path": "artisan", "content": file_text(artisan)},
        {"path": "public/index.php", "content": file_text(index)},
        keep("storage/app"),
        keep("storage/framework/cache/data"),
        keep("storage/framework/sessions"),
        keep("storage/framework/testing"),
        keep("storage/framework/views"),
        keep("storage/logs"),
        *([keep("database", "*.sqlite*")] if context.eloquent else []),
    ]


def config_file(context: LaravelContext) -> dict:
    auth = context.settings["auth"]
    content = lines(
        "<?php",
        "",
        "// Settings of the API, read from the environment (see .env.example). Nothing secret has a default.",
        "return [",
        auth == "none" and "    //",
        auth == "apiKey"
        and [
            "    // Accepted API keys, separated by commas; without any, every protected request is rejected",
            "    'api_keys' => array_values(array_filter(array_map('trim', explode(',', (string) env('API_KEYS', ''))))),",
        ],
        auth == "jwt"
        and [
            "    // Secret that signs the tokens; without it, every protected request is rejected",
            "    'jwt' => [",
            "        'secret' => (string) env('JWT_SECRET', ''),",
            "        'algorithm' => (string) env('JWT_ALGORITHM', 'HS256'),",
            "        'audience' => env('JWT_AUDIENCE') ?: null,",
            "        'issuer' => env('JWT_ISSUER') ?: null,",
            "    ],",
        ],
        "];",
    )
    return {"path": "config/api.php", "content": file_text(content)}


def error_renderer_file() -> dict:
    """The renderer of errors with the format of openapi.yaml."""
    namespace = "App\\Exceptions"
    return php_file(
        namespace,
        "ApiErrors",
        PhpImports(namespace).add(
            "Illuminate\\Http\\JsonResponse",
            "Illuminate\\Validation\\ValidationException",
            "Symfony\\Component\\HttpKernel\\Exception\\MethodNotAllowedHttpException",
            "Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException",
        ),
        [
            php_doc('Answers every error with the body of openapi.yaml: {"error": {"code", "message", "details"}}.'),
            "final class ApiErrors",
            "{",
            "    public static function render(\\Throwable $error): JsonResponse",
            "    {",
            "        return match (true) {",
            "            $error instanceof ApiException => self::answer($error->status, $error->errorCode, $error->getMessage(), $error->details),",
            "            $error instanceof ValidationException => self::answer(400, 'validation_error', 'The request is not valid', self::details($error)),",
            "            $error instanceof NotImplementedException => self::answer(501, 'not_implemented', $error->getMessage() ?: 'The logic of this operation is not written yet'),",
            "            $error instanceof NotFoundHttpException => self::answer(404, 'not_found', 'No route matches this request'),",
            f"            $error instanceof MethodNotAllowedHttpException => self::answer(405, {php_string(GENERAL_ERROR_CODES[0])}, 'This path does not accept this method'),",
            "            default => self::unexpected($error),",
            "        };",
            "    }",
            "",
            "    /** @param list<array{field: string, message: string}> $details */",
            "    public static function answer(int $status, string $code, string $message, array $details = []): JsonResponse",
            "    {",
            "        $error = ['code' => $code, 'message' => $message];",
            "        if ($details !== []) {",
            "            $error['details'] = $details;",
            "        }",
            "",
            "        return response()->json(['error' => $error], $status);",
            "    }",
            "",
            "    /** @return list<array{field: string, message: string}> */",
            "    private static function details(ValidationException $error): array",
            "    {",
            "        $details = [];",
            "        foreach ($error->errors() as $field => $messages) {",
            "            foreach ($messages as $message) {",
            "                $details[] = ['field' => (string) $field, 'message' => $message];",
            "            }",
            "        }",
            "",
            "        return $details;",
            "    }",
            "",
            "    private static function unexpected(\\Throwable $error): JsonResponse",
            "    {",
            "        report($error);",
            "",
            f"        return self::answer(500, {php_string(GENERAL_ERROR_CODES[1])}, 'Something went wrong on the server');",
            "    }",
            "}",
        ],
    )


def api_request_file() -> dict:
    """The base of request bodies: a JSON object, without fields the contract does not describe."""
    namespace = "App\\Http\\Requests"
    return php_file(
        namespace,
        "ApiRequest",
        PhpImports(namespace).add(
            "App\\Exceptions\\ApiException",
            "Illuminate\\Foundation\\Http\\FormRequest",
            "Illuminate\\Validation\\Validator",
        ),
        [
            php_doc(
                "Base of request bodies. The body must be a JSON object, and a field the contract does not describe is an\n"
                "error, as in openapi.yaml (additionalProperties: false)."
            ),
            "abstract class ApiRequest extends FormRequest",
            "{",
            "    /**",
            '     * Paths whose content is free (maps and values of any shape): nothing under them is checked. A "*"',
            "     * stands for every item of a list.",
            "     *",
            "     * @var list<string>",
            "     */",
            "    protected array $open = [];",
            "",
            "    public function authorize(): bool",
            "    {",
            "        return true;",
            "    }",
            "",
            "    protected function prepareForValidation(): void",
            "    {",
            "        $content = $this->getContent();",
            "        $body = json_decode($content === '' ? 'null' : $content, true);",
            "        if (json_last_error() !== JSON_ERROR_NONE) {",
            "            throw new ApiException(400, 'validation_error', 'The body is not valid JSON');",
            "        }",
            "        if (! is_array($body) || (array_is_list($body) && $body !== [])) {",
            "            throw new ApiException(400, 'validation_error', 'The body must be a JSON object');",
            "        }",
            "    }",
            "",
            "    public function withValidator(Validator $validator): void",
            "    {",
            "        $validator->after(function (Validator $validator): void {",
            "            $known = array_keys($this->rules());",
            "            foreach ($this->unknownPaths($this->json()->all(), '', '', $known) as $path) {",
            "                $validator->errors()->add($path, 'This field is not part of the contract.');",
            "            }",
            "        });",
            "    }",
            "",
            "    /**",
            '     * Paths of the input that no rule describes. $pattern is the path with "*" for list items.',
            "     *",
            "     * @param  list<string>  $known",
            "     * @return list<string>",
            "     */",
            "    private function unknownPaths(mixed $value, string $path, string $pattern, array $known): array",
            "    {",
            "        if (! is_array($value) || ($pattern !== '' && in_array($pattern, $this->open, true))) {",
            "            return [];",
            "        }",
            "        $unknown = [];",
            "        foreach ($value as $key => $item) {",
            "            $itemPath = $path === '' ? (string) $key : \"{$path}.{$key}\";",
            "            $itemPattern = ($pattern === '' ? '' : \"{$pattern}.\").(array_is_list($value) ? '*' : (string) $key);",
            "            if (! in_array($itemPattern, $known, true)) {",
            "                $unknown[] = $itemPath;",
            "",
            "                continue;",
            "            }",
            "            array_push($unknown, ...$this->unknownPaths($item, $itemPath, $itemPattern, $known));",
            "        }",
            "",
            "        return $unknown;",
            "    }",
            "}",
        ],
    )


def blank_string_rule_file() -> dict:
    """A rule for blank texts, which Laravel's own rules let through without checking them."""
    namespace = "App\\Rules"
    return php_file(
        namespace,
        "BlankString",
        PhpImports(namespace).add("Closure", "Illuminate\\Contracts\\Validation\\ValidationRule"),
        [
            php_doc(
                'Laravel skips its rules when a value is an empty or blank text ("", "  "). This rule checks those texts\n'
                "against what the field declares: whether it is a text at all, its length, its pattern and its format."
            ),
            "final class BlankString implements ValidationRule",
            "{",
            "    /** Runs even for blank values, which is all it is for */",
            "    public bool $implicit = true;",
            "",
            "    public function __construct(",
            "        private readonly bool $text,",
            "        private readonly ?int $min = null,",
            "        private readonly ?int $max = null,",
            "        private readonly ?string $pattern = null,",
            "        private readonly bool $format = false,",
            "    ) {",
            "    }",
            "",
            "    public function validate(string $attribute, mixed $value, Closure $fail): void",
            "    {",
            "        if (! is_string($value) || trim($value) !== '') {",
            "            return;",
            "        }",
            "        $length = mb_strlen($value);",
            "        if (! $this->text) {",
            "            $fail('The :attribute field has the wrong type.');",
            "        } elseif ($this->format) {",
            "            $fail('The :attribute field must not be blank.');",
            "        } elseif ($this->min !== null && $length < $this->min) {",
            '            $fail("The :attribute field must be at least {$this->min} characters.");',
            "        } elseif ($this->max !== null && $length > $this->max) {",
            '            $fail("The :attribute field must not be greater than {$this->max} characters.");',
            "        } elseif ($this->pattern !== null && preg_match($this->pattern, $value) !== 1) {",
            "            $fail('The :attribute field format is invalid.');",
            "        }",
            "    }",
            "}",
        ],
    )


def security_files(context: LaravelContext) -> list[dict]:
    """Authentication middleware: an API key, or a bearer token with roles."""
    auth = context.settings["auth"]
    namespace = "App\\Http\\Middleware"
    if auth == "none":
        return []
    if auth == "apiKey":
        return [
            php_file(
                namespace,
                "RequireApiKey",
                PhpImports(namespace).add(
                    "App\\Exceptions\\ApiException",
                    "Closure",
                    "Illuminate\\Http\\Request",
                    "Symfony\\Component\\HttpFoundation\\Response",
                ),
                [
                    php_doc("API key authentication: the key in the X-API-Key header must be one of API_KEYS."),
                    "final class RequireApiKey",
                    "{",
                    "    /** Lets the request through only with a configured key. Without API_KEYS, every request is rejected. */",
                    "    public function handle(Request $request, Closure $next): Response",
                    "    {",
                    "        $key = (string) $request->header('X-API-Key', '');",
                    "        $valid = $key !== '' && collect(config('api.api_keys'))->contains(fn (string $known) => hash_equals($known, $key));",
                    "        if (! $valid) {",
                    "            throw ApiException::unauthorized();",
                    "        }",
                    "",
                    "        return $next($request);",
                    "    }",
                    "}",
                ],
            )
        ]
    return [
        php_file(
            namespace,
            "AuthenticateToken",
            PhpImports(namespace).add(
                "App\\Exceptions\\ApiException",
                "Closure",
                "Firebase\\JWT\\JWT",
                "Firebase\\JWT\\Key",
                "Illuminate\\Http\\Request",
                "Symfony\\Component\\HttpFoundation\\Response",
            ),
            [
                php_doc(
                    "Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them\n"
                    'with JWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set) and reads the roles from the "roles" claim.\n'
                    "With roles (token:admin,reader), the token must hold one of them."
                ),
                "final class AuthenticateToken",
                "{",
                "    public function handle(Request $request, Closure $next, string ...$roles): Response",
                "    {",
                "        $claims = $this->claims($request);",
                "        $granted = (array) ($claims->roles ?? []);",
                "        if ($roles !== [] && array_intersect($roles, array_map(strval(...), $granted)) === []) {",
                "            throw ApiException::forbidden();",
                "        }",
                "",
                "        return $next($request);",
                "    }",
                "",
                "    /** Verifies the token: signature, expiry (required) and, when configured, audience and issuer. */",
                "    private function claims(Request $request): object",
                "    {",
                "        $settings = config('api.jwt');",
                "        $token = (string) $request->bearerToken();",
                "        if ($token === '' || $settings['secret'] === '') {",
                "            throw ApiException::unauthorized();",
                "        }",
                "        try {",
                "            $claims = JWT::decode($token, new Key($settings['secret'], $settings['algorithm']));",
                "        } catch (\\Throwable) {",
                "            throw ApiException::unauthorized();",
                "        }",
                "        $audience = (array) ($claims->aud ?? []);",
                "        $wrong = ! isset($claims->exp)",
                "            || ($settings['audience'] !== null && ! in_array($settings['audience'], $audience, true))",
                "            || ($settings['issuer'] !== null && ($claims->iss ?? null) !== $settings['issuer']);",
                "        if ($wrong) {",
                "            throw ApiException::unauthorized();",
                "        }",
                "",
                "        return $claims;",
                "    }",
                "}",
            ],
        )
    ]


def provider_file(context: LaravelContext) -> dict:
    """The service provider: the only place that decides which storage each repository interface uses."""
    namespace = "App\\Providers"
    imports = PhpImports(namespace).add("Illuminate\\Support\\ServiceProvider")
    bindings: list[str] = []
    for resource in context.spec["resources"]:
        name = names(resource)
        if context.pending:
            implementation = name["pendingRepository"]
        elif context.eloquent:
            implementation = name["eloquentRepository"]
        else:
            implementation = name["memory"]
        imports.add(
            qualified(context, resource, "repository", name["repository"]),
            qualified(context, resource, "repository", implementation),
        )
        bindings.append(f"        $this->app->singleton({name['repository']}::class, {implementation}::class);")
    if context.pending:
        comment = "        // Storage to write: every repository answers 501 until it is implemented"
    elif context.eloquent:
        comment = "        // Each repository keeps its items in the database with Eloquent"
    else:
        comment = "        // Data kept in memory while the application runs; restarting it (or each test) starts empty"
    return php_file(
        namespace,
        "AppServiceProvider",
        imports,
        [
            php_doc("Wires the application: the storage each repository interface uses."),
            "final class AppServiceProvider extends ServiceProvider",
            "{",
            "    public function register(): void",
            "    {",
            [comment, bindings] if bindings else "        //",
            "    }",
            "}",
        ],
    )
