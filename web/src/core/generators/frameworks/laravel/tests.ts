/**
 * Tests of the Laravel project: the base test class, on Laravel's own HTTP testing. The test data and the
 * tests of each resource are shared with every PHP framework (languages/php/tests.ts).
 */
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { phpDoc } from '../../languages/php/php.ts'
import { resourceTestFile, testDataFile } from '../../languages/php/tests.ts'
import type { LaravelContext } from './context.ts'

function testCaseFile(context: LaravelContext): GeneratedFile {
  const content = lines(
    '<?php',
    '',
    'namespace Tests;',
    '',
    context.eloquent && 'use Illuminate\\Foundation\\Testing\\RefreshDatabase;',
    'use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;',
    '',
    phpDoc('Base of the tests: a new application for each test.'),
    'abstract class TestCase extends BaseTestCase',
    '{',
    context.eloquent && [
      '    use RefreshDatabase;',
      '',
      '    protected function setUp(): void',
      '    {',
      '        // TEST_DATABASE_URL (postgresql://, mysql://, mariadb://…) runs the tests on that database',
      "        $url = getenv('TEST_DATABASE_URL');",
      "        if (is_string($url) && $url !== '') {",
      '            $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));',
      '            $connection = match ($scheme) {',
      "                'postgresql', 'postgres', 'pgsql' => 'pgsql',",
      "                'mariadb' => 'mariadb',",
      "                default => 'mysql',",
      '            };',
      "            foreach (['DB_CONNECTION' => $connection, 'DB_URL' => $url] as $name => $value) {",
      '                putenv("{$name}={$value}");',
      '                $_ENV[$name] = $_SERVER[$name] = $value;',
      '            }',
      '        }',
      '        parent::setUp();',
      '    }',
    ],
    !context.eloquent && '    //',
    '}',
  )
  return { path: 'tests/TestCase.php', content: fileText(content) }
}

export function testFiles(context: LaravelContext): GeneratedFile[] {
  return [testCaseFile(context), testDataFile(context), ...context.spec.resources.map((resource) => resourceTestFile(context, resource))]
}
