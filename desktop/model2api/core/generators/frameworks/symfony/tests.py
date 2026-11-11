"""Tests of the Symfony project: the bootstrap, and a base test class on Symfony's WebTestCase with the same helpers
Laravel's tests have (postJson, getJson… answering with assertStatus and json), so the test data and the tests of
each resource are the ones every PHP framework shares (languages/php/tests.py). Mirrors
web/src/core/generators/frameworks/symfony/tests.ts.
"""

from ...common.text import file_text, lines
from ...languages.php.php import php_doc
from ...languages.php.tests import resource_test_file, test_data_file
from .context import SymfonyContext


def _bootstrap_file(context: SymfonyContext) -> dict:
    content = lines(
        "<?php",
        "",
        "use Symfony\\Component\\Dotenv\\Dotenv;",
        "",
        "require dirname(__DIR__).'/vendor/autoload.php';",
        "",
        "(new Dotenv())->bootEnv(dirname(__DIR__).'/.env');",
        context.doctrine
        and [
            "",
            "// TEST_DATABASE_URL (postgresql://, mysql://…) runs the tests on that database instead of SQLite in memory",
            "$url = getenv('TEST_DATABASE_URL');",
            "if (is_string($url) && $url !== '') {",
            "    $_SERVER['DATABASE_URL'] = $_ENV['DATABASE_URL'] = $url;",
            "}",
        ],
    )
    return {"path": "tests/bootstrap.php", "content": file_text(content)}


def _json_helper(method: str, verb: str, with_data: bool) -> list[str]:
    """A helper of the base test class that sends one HTTP method."""
    if not with_data:
        return [
            "    /** @param array<string, string> $headers */",
            f"    protected function {method}(string $uri, array $headers = []): TestResponse",
            "    {",
            f"        return $this->json('{verb}', $uri, [], $headers);",
            "    }",
        ]
    return [
        "    /**",
        "     * @param  array<string, mixed>  $data",
        "     * @param  array<string, string>  $headers",
        "     */",
        f"    protected function {method}(string $uri, array $data = [], array $headers = []): TestResponse",
        "    {",
        f"        return $this->json('{verb}', $uri, $data, $headers);",
        "    }",
    ]


def _api_test_case_files(context: SymfonyContext) -> list[dict]:
    content = lines(
        "<?php",
        "",
        "namespace App\\Tests;",
        "",
        context.doctrine and "use Doctrine\\ORM\\Tools\\SchemaTool;",
        "use Symfony\\Bundle\\FrameworkBundle\\KernelBrowser;",
        "use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;",
        "",
        php_doc("Base of the tests: a new application for each test, and helpers to call it with JSON."),
        "abstract class ApiTestCase extends WebTestCase",
        "{",
        "    private KernelBrowser $client;",
        "",
        "    protected function setUp(): void",
        "    {",
        "        parent::setUp();",
        "        $this->client = static::createClient();",
        "        // One application for the whole test, so what a request stores the next one reads",
        "        $this->client->disableReboot();",
        context.doctrine
        and [
            "        $manager = static::getContainer()->get('doctrine.orm.entity_manager');",
            "        $metadata = $manager->getMetadataFactory()->getAllMetadata();",
            "        $tool = new SchemaTool($manager);",
            "        // Empty tables for each test",
            "        $tool->dropSchema($metadata);",
            "        $tool->createSchema($metadata);",
        ],
        "    }",
        "",
        "    /**",
        "     * Sends a request with a JSON body.",
        "     *",
        "     * @param  array<string, mixed>  $data",
        "     * @param  array<string, string>  $headers",
        "     */",
        "    protected function json(string $method, string $uri, array $data = [], array $headers = []): TestResponse",
        "    {",
        "        $server = ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'];",
        "        foreach ($headers as $name => $value) {",
        "            $server['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;",
        "        }",
        "        $this->client->request($method, $uri, [], [], $server, json_encode($data, JSON_THROW_ON_ERROR));",
        "",
        "        return new TestResponse($this->client->getResponse());",
        "    }",
        "",
        _json_helper("getJson", "GET", False),
        "",
        _json_helper("postJson", "POST", True),
        "",
        _json_helper("putJson", "PUT", True),
        "",
        _json_helper("patchJson", "PATCH", True),
        "",
        _json_helper("deleteJson", "DELETE", True),
        "}",
    )
    response = lines(
        "<?php",
        "",
        "namespace App\\Tests;",
        "",
        "use PHPUnit\\Framework\\Assert;",
        "use Symfony\\Component\\HttpFoundation\\Response;",
        "",
        php_doc(
            'The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").'
        ),
        "final class TestResponse",
        "{",
        "    public function __construct(private readonly Response $response)",
        "    {",
        "    }",
        "",
        "    public function assertStatus(int $status): void",
        "    {",
        "        Assert::assertSame($status, $this->response->getStatusCode(), (string) $this->response->getContent());",
        "    }",
        "",
        "    public function json(?string $path = null): mixed",
        "    {",
        "        $value = json_decode((string) $this->response->getContent(), true);",
        "        foreach ($path === null ? [] : explode('.', $path) as $part) {",
        "            $value = is_array($value) ? ($value[$part] ?? null) : null;",
        "        }",
        "",
        "        return $value;",
        "    }",
        "}",
    )
    return [
        {"path": "tests/ApiTestCase.php", "content": file_text(content)},
        {"path": "tests/TestResponse.php", "content": file_text(response)},
    ]


def test_files(context: SymfonyContext) -> list[dict]:
    return [
        _bootstrap_file(context),
        *_api_test_case_files(context),
        test_data_file(context),
        *(resource_test_file(context, resource) for resource in context.spec["resources"]),
    ]
