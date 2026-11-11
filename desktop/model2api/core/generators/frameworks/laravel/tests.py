"""Tests of the Laravel project: the base test class, on Laravel's own HTTP testing. The test data and the tests of
each resource are shared with every PHP framework (languages/php/tests.py). Mirrors
web/src/core/generators/frameworks/laravel/tests.ts.
"""

from ...common.text import file_text, lines
from ...languages.php.php import php_doc
from ...languages.php.tests import resource_test_file, test_data_file
from .context import LaravelContext


def _test_case_file(context: LaravelContext) -> dict:
    content = lines(
        "<?php",
        "",
        "namespace Tests;",
        "",
        context.eloquent and "use Illuminate\\Foundation\\Testing\\RefreshDatabase;",
        "use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;",
        "",
        php_doc("Base of the tests: a new application for each test."),
        "abstract class TestCase extends BaseTestCase",
        "{",
        context.eloquent
        and [
            "    use RefreshDatabase;",
            "",
            "    protected function setUp(): void",
            "    {",
            "        // TEST_DATABASE_URL (postgresql://, mysql://, mariadb://…) runs the tests on that database",
            "        $url = getenv('TEST_DATABASE_URL');",
            "        if (is_string($url) && $url !== '') {",
            "            $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));",
            "            $connection = match ($scheme) {",
            "                'postgresql', 'postgres', 'pgsql' => 'pgsql',",
            "                'mariadb' => 'mariadb',",
            "                default => 'mysql',",
            "            };",
            "            foreach (['DB_CONNECTION' => $connection, 'DB_URL' => $url] as $name => $value) {",
            '                putenv("{$name}={$value}");',
            "                $_ENV[$name] = $_SERVER[$name] = $value;",
            "            }",
            "        }",
            "        parent::setUp();",
            "    }",
        ],
        not context.eloquent and "    //",
        "}",
    )
    return {"path": "tests/TestCase.php", "content": file_text(content)}


def test_files(context: LaravelContext) -> list[dict]:
    return [
        _test_case_file(context),
        test_data_file(context),
        *(resource_test_file(context, resource) for resource in context.spec["resources"]),
    ]
