/**
 * Files of the Symfony project that do not belong to one resource: the kernel and its entry points, the
 * configuration, the error format and its subscriber, the reading of JSON bodies, the base controller and
 * the protection of the endpoints.
 */
import { GENERAL_ERROR_CODES } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpString } from '../../languages/php/php.ts'
import { classPath, names, qualified, type SymfonyContext } from './context.ts'

type Line = string | false | null | undefined | Line[]

function phpFile(namespace: string, name: string, imports: PhpImports, body: Line[]): GeneratedFile {
  return { path: classPath(namespace, name), content: fileText(lines(...phpHeader(namespace, imports), ...body)) }
}

export function kernelFiles(): GeneratedFile[] {
  const kernel = phpFile(
    'App',
    'Kernel',
    new PhpImports('App').add(
      'Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait',
      'Symfony\\Component\\HttpKernel\\Kernel as BaseKernel',
    ),
    [
      phpDoc('The application: bundles from config/bundles.php, configuration from config/packages/ and config/services.yaml.'),
      'final class Kernel extends BaseKernel',
      '{',
      '    use MicroKernelTrait;',
      '}',
    ],
  )
  const console = lines(
    '#!/usr/bin/env php',
    '<?php',
    '',
    'use App\\Kernel;',
    'use Symfony\\Bundle\\FrameworkBundle\\Console\\Application;',
    '',
    "require_once dirname(__DIR__).'/vendor/autoload_runtime.php';",
    '',
    'return static function (array $context): Application {',
    "    return new Application(new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']));",
    '};',
  )
  const index = lines(
    '<?php',
    '',
    'use App\\Kernel;',
    '',
    "require_once dirname(__DIR__).'/vendor/autoload_runtime.php';",
    '',
    'return static function (array $context): Kernel {',
    "    return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);",
    '};',
  )
  return [kernel, { path: 'bin/console', content: fileText(console) }, { path: 'public/index.php', content: fileText(index) }]
}

export function configFiles(context: SymfonyContext): GeneratedFile[] {
  const { auth } = context.settings
  const bundles = lines(
    '<?php',
    '',
    'return [',
    "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],",
    context.doctrine && "    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],",
    '];',
  )
  const framework = lines(
    'framework:',
    "    secret: '%env(APP_SECRET)%'",
    '    http_method_override: false',
    '    handle_all_throwables: true',
    '',
    'when@test:',
    '    framework:',
    '        test: true',
  )
  const doctrine = lines(
    'doctrine:',
    '    dbal:',
    "        url: '%env(resolve:DATABASE_URL)%'",
    // Without a version DBAL cannot pick the PostgreSQL platform before it connects; the URL's serverVersion wins
    context.settings.database === 'postgresql' && [
      '        # The version of the PostgreSQL server, which DBAL needs before it connects',
      "        server_version: '16'",
    ],
    '    orm:',
    '        mappings:',
    '            App:',
    '                type: attribute',
    "                dir: '%kernel.project_dir%/src'",
    "                prefix: 'App'",
  )
  const routes = lines('# Every #[Route] of the controllers in src/', 'controllers:', '    resource: routing.controllers')
  const aliases = context.spec.resources.map((resource) => {
    const name = names(resource)
    const implementation = context.pending ? name.pendingRepository : context.doctrine ? name.doctrineRepository : name.memory
    return `    ${qualified(context, resource, 'repository', name.repository)}: '@${qualified(context, resource, 'repository', implementation)}'`
  })
  const services = lines(
    '# Services of the API: every class of src/ is a service, wired by its constructor.',
    'parameters:',
    auth === 'apiKey' && "    env(API_KEYS): ''",
    auth === 'jwt' && [
      "    env(JWT_SECRET): ''",
      "    env(JWT_ALGORITHM): 'HS256'",
      "    env(JWT_AUDIENCE): ''",
      "    env(JWT_ISSUER): ''",
    ],
    '',
    'services:',
    '    _defaults:',
    '        autowire: true',
    '        autoconfigure: true',
    auth === 'apiKey' && ['        bind:', "            $apiKeys: '%env(API_KEYS)%'"],
    auth === 'jwt' && [
      '        bind:',
      "            $jwtSecret: '%env(JWT_SECRET)%'",
      "            $jwtAlgorithm: '%env(JWT_ALGORITHM)%'",
      "            $jwtAudience: '%env(JWT_AUDIENCE)%'",
      "            $jwtIssuer: '%env(JWT_ISSUER)%'",
    ],
    '',
    '    App\\:',
    "        resource: '../src/'",
    "        exclude: '../src/Kernel.php'",
    aliases.length > 0 && [
      '',
      context.pending
        ? '    # Storage to write: every repository answers 501 until it is implemented'
        : context.doctrine
          ? '    # Each repository keeps its items in the database with Doctrine'
          : '    # Data kept in memory while the application runs; restarting it (or each test) starts empty',
      aliases,
    ],
  )
  return [
    { path: 'config/bundles.php', content: fileText(bundles) },
    { path: 'config/packages/framework.yaml', content: fileText(framework) },
    ...(context.doctrine ? [{ path: 'config/packages/doctrine.yaml', content: fileText(doctrine) }] : []),
    { path: 'config/routes.yaml', content: fileText(routes) },
    { path: 'config/services.yaml', content: fileText(services) },
  ]
}

/** The subscriber that answers every error with the format of openapi.yaml. */
export function errorSubscriberFile(): GeneratedFile {
  const namespace = 'App\\EventSubscriber'
  return phpFile(
    namespace,
    'ApiErrorSubscriber',
    new PhpImports(namespace).add(
      'App\\Exception\\ApiException',
      'App\\Exception\\NotImplementedException',
      'Psr\\Log\\LoggerInterface',
      'Symfony\\Component\\EventDispatcher\\EventSubscriberInterface',
      'Symfony\\Component\\HttpFoundation\\JsonResponse',
      'Symfony\\Component\\HttpKernel\\Event\\ExceptionEvent',
      'Symfony\\Component\\HttpKernel\\Exception\\MethodNotAllowedHttpException',
      'Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException',
      'Symfony\\Component\\HttpKernel\\KernelEvents',
    ),
    [
      phpDoc('Answers every error with the body of openapi.yaml: {"error": {"code", "message", "details"}}.'),
      'final class ApiErrorSubscriber implements EventSubscriberInterface',
      '{',
      '    public function __construct(private readonly ?LoggerInterface $logger = null)',
      '    {',
      '    }',
      '',
      '    public static function getSubscribedEvents(): array',
      '    {',
      "        return [KernelEvents::EXCEPTION => 'onException'];",
      '    }',
      '',
      '    public function onException(ExceptionEvent $event): void',
      '    {',
      '        $error = $event->getThrowable();',
      '        $event->setResponse(match (true) {',
      '            $error instanceof ApiException => self::answer($error->status, $error->errorCode, $error->getMessage(), $error->details),',
      "            $error instanceof NotImplementedException => self::answer(501, 'not_implemented', $error->getMessage() ?: 'The logic of this operation is not written yet'),",
      "            $error instanceof NotFoundHttpException => self::answer(404, 'not_found', 'No route matches this request'),",
      `            $error instanceof MethodNotAllowedHttpException => self::answer(405, ${phpString(GENERAL_ERROR_CODES[0])}, 'This path does not accept this method'),`,
      '            default => $this->unexpected($error),',
      '        });',
      '    }',
      '',
      '    /** @param list<array{field: string, message: string}> $details */',
      '    public static function answer(int $status, string $code, string $message, array $details = []): JsonResponse',
      '    {',
      "        $error = ['code' => $code, 'message' => $message];",
      '        if ($details !== []) {',
      "            $error['details'] = $details;",
      '        }',
      '',
      "        return new JsonResponse(['error' => $error], $status);",
      '    }',
      '',
      '    private function unexpected(\\Throwable $error): JsonResponse',
      '    {',
      "        $this->logger?->error($error->getMessage(), ['exception' => $error]);",
      '',
      `        return self::answer(500, ${phpString(GENERAL_ERROR_CODES[1])}, 'Something went wrong on the server');`,
      '    }',
      '}',
    ],
  )
}

/** Reading a JSON body: a JSON object, checked against the constraints of a request. */
export function jsonBodyFile(): GeneratedFile {
  const namespace = 'App\\Http'
  return phpFile(
    namespace,
    'JsonBody',
    new PhpImports(namespace).add(
      'App\\Exception\\ApiException',
      'Symfony\\Component\\HttpFoundation\\Request',
      'Symfony\\Component\\Validator\\Constraint',
      'Symfony\\Component\\Validator\\Validator\\ValidatorInterface',
    ),
    [
      phpDoc(
        'Reads the body of a request: it must be a JSON object and meet the constraints of the request, which reject\nfields the contract does not describe (openapi.yaml, additionalProperties: false).',
      ),
      'final class JsonBody',
      '{',
      '    public function __construct(private readonly ValidatorInterface $validator)',
      '    {',
      '    }',
      '',
      '    /** @return array<string, mixed> The body, checked */',
      '    public function read(Request $request, Constraint $constraint): array',
      '    {',
      '        $content = $request->getContent();',
      '        try {',
      "            $body = json_decode($content === '' ? 'null' : $content, true, 512, JSON_THROW_ON_ERROR);",
      '        } catch (\\JsonException) {',
      "            throw new ApiException(400, 'validation_error', 'The body is not valid JSON');",
      '        }',
      '        if (! is_array($body) || (array_is_list($body) && $body !== [])) {',
      "            throw new ApiException(400, 'validation_error', 'The body must be a JSON object');",
      '        }',
      '        $details = [];',
      '        foreach ($this->validator->validate($body, $constraint) as $violation) {',
      '            // [address][street] is address.street, as in the other answers',
      "            $field = trim(str_replace('][', '.', $violation->getPropertyPath()), '[]');",
      "            $details[] = ['field' => $field, 'message' => (string) $violation->getMessage()];",
      '        }',
      '        if ($details !== []) {',
      "            throw new ApiException(400, 'validation_error', 'The request is not valid', $details);",
      '        }',
      '',
      '        return $body;',
      '    }',
      '}',
    ],
  )
}

/** The base of the controllers: keys and query values read with their type, and JSON answers. */
export function baseControllerFile(): GeneratedFile {
  const namespace = 'App\\Controller'
  return phpFile(
    namespace,
    'ApiController',
    new PhpImports(namespace).add(
      'App\\Exception\\ApiException',
      'Symfony\\Component\\HttpFoundation\\JsonResponse',
      'Symfony\\Component\\HttpFoundation\\Request',
      'Symfony\\Component\\HttpFoundation\\Response',
      'Symfony\\Component\\Uid\\Uuid',
    ),
    [
      phpDoc(
        'Base of the controllers. Keys in paths and values in query strings are text: they are read with their type,\nand a malformed one is a 400, not a missing item.',
      ),
      'abstract class ApiController',
      '{',
      '    protected function integerKey(Request $request, string $name): int',
      '    {',
      '        $value = (string) $request->attributes->get($name);',
      "        if (preg_match('/^-?\\d+$/', $value) !== 1) {",
      "            throw ApiException::invalid($name, 'Must be a whole number');",
      '        }',
      '',
      '        return (int) $value;',
      '    }',
      '',
      '    protected function uuidKey(Request $request, string $name): string',
      '    {',
      '        $value = (string) $request->attributes->get($name);',
      '        if (! Uuid::isValid($value)) {',
      "            throw ApiException::invalid($name, 'Must be a UUID');",
      '        }',
      '',
      '        return $value;',
      '    }',
      '',
      '    protected function textKey(Request $request, string $name): string',
      '    {',
      '        return (string) $request->attributes->get($name);',
      '    }',
      '',
      '    /** A whole number of the query string, within its limits; the default when it is not there. */',
      '    protected function integerQuery(Request $request, string $name, ?int $default = null, ?int $min = null, ?int $max = null): ?int',
      '    {',
      '        $value = $request->query->get($name);',
      '        if ($value === null) {',
      '            return $default;',
      '        }',
      "        if (preg_match('/^-?\\d+$/', $value) !== 1 || ($min !== null && (int) $value < $min) || ($max !== null && (int) $value > $max)) {",
      "            throw ApiException::invalid($name, 'Must be a whole number within its limits');",
      '        }',
      '',
      '        return (int) $value;',
      '    }',
      '',
      '    protected function numberQuery(Request $request, string $name): ?float',
      '    {',
      '        $value = $request->query->get($name);',
      '        if ($value !== null && ! is_numeric($value)) {',
      "            throw ApiException::invalid($name, 'Must be a number');",
      '        }',
      '',
      '        return $value === null ? null : (float) $value;',
      '    }',
      '',
      '    protected function booleanQuery(Request $request, string $name): ?bool',
      '    {',
      '        $value = $request->query->get($name);',
      "        if ($value !== null && ! in_array($value, ['true', 'false'], true)) {",
      "            throw ApiException::invalid($name, 'Must be true or false');",
      '        }',
      '',
      "        return $value === null ? null : $value === 'true';",
      '    }',
      '',
      '    /**',
      '     * A value of the query string that must be one of $choices, compared as text.',
      '     *',
      '     * @param  list<string|int>  $choices',
      '     */',
      '    protected function choiceQuery(Request $request, string $name, array $choices): string|int|null',
      '    {',
      '        $value = $request->query->get($name);',
      '        if ($value === null) {',
      '            return null;',
      '        }',
      '        foreach ($choices as $choice) {',
      '            if ((string) $choice === $value) {',
      '                return $choice;',
      '            }',
      '        }',
      "        throw ApiException::invalid($name, 'Must be one of: '.implode(', ', $choices));",
      '    }',
      '',
      '    /** Text of the query string that matches $pattern, when one is given. */',
      '    protected function textQuery(Request $request, string $name, ?string $pattern = null): ?string',
      '    {',
      '        $value = $request->query->get($name);',
      '        if ($value !== null && $pattern !== null && preg_match($pattern, $value) !== 1) {',
      "            throw ApiException::invalid($name, 'Has the wrong format');",
      '        }',
      '',
      '        return $value;',
      '    }',
      '',
      '    protected function answer(mixed $data, int $status): JsonResponse',
      '    {',
      '        return new JsonResponse($data, $status);',
      '    }',
      '',
      '    protected function empty(int $status): Response',
      '    {',
      '        return new Response(null, $status);',
      '    }',
      '}',
    ],
  )
}

/** Protection of the endpoints: the attribute a controller method declares, and the subscriber that checks it. */
export function securityFiles(context: SymfonyContext): GeneratedFile[] {
  const { auth } = context.settings
  if (auth === 'none') return []
  const namespace = 'App\\Security'
  const attribute = phpFile(namespace, 'RequiresAccess', new PhpImports(namespace).add('Attribute'), [
    phpDoc(
      auth === 'jwt'
        ? 'Marks an endpoint that needs a valid token; with roles, the token must hold one of them.'
        : 'Marks an endpoint that needs a valid API key.',
    ),
    '#[Attribute(Attribute::TARGET_METHOD)]',
    'final class RequiresAccess',
    '{',
    '    /** @param list<string> $roles */',
    '    public function __construct(public readonly array $roles = [])',
    '    {',
    '    }',
    '}',
  ])
  const imports = new PhpImports(namespace).add(
    'App\\Exception\\ApiException',
    'Symfony\\Component\\EventDispatcher\\EventSubscriberInterface',
    'Symfony\\Component\\HttpKernel\\Event\\ControllerEvent',
    'Symfony\\Component\\HttpKernel\\KernelEvents',
  )
  if (auth === 'jwt') imports.add('Firebase\\JWT\\JWT', 'Firebase\\JWT\\Key', 'Symfony\\Component\\HttpFoundation\\Request')
  const check =
    auth === 'apiKey'
      ? [
          "        $key = (string) $event->getRequest()->headers->get('X-API-Key', '');",
          "        $valid = array_filter(array_map('trim', explode(',', $this->apiKeys)), fn (string $known) => $known !== '' && hash_equals($known, $key));",
          "        if ($key === '' || $valid === []) {",
          '            throw ApiException::unauthorized();',
          '        }',
        ]
      : [
          '        $claims = $this->claims($event->getRequest());',
          '        $granted = array_map(strval(...), (array) ($claims->roles ?? []));',
          '        foreach ($attributes as $access) {',
          '            if ($access->roles !== [] && array_intersect($access->roles, $granted) === []) {',
          '                throw ApiException::forbidden();',
          '            }',
          '        }',
        ]
  const subscriber = phpFile(namespace, 'AccessSubscriber', imports, [
    phpDoc(
      auth === 'apiKey'
        ? 'API key authentication: the key in the X-API-Key header must be one of API_KEYS. Without API_KEYS, every\nprotected request is rejected.'
        : 'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\nJWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set) and reads the roles from the "roles" claim.',
    ),
    'final class AccessSubscriber implements EventSubscriberInterface',
    '{',
    auth === 'apiKey'
      ? ['    public function __construct(private readonly string $apiKeys)', '    {', '    }']
      : [
          '    public function __construct(',
          '        private readonly string $jwtSecret,',
          '        private readonly string $jwtAlgorithm,',
          '        private readonly string $jwtAudience,',
          '        private readonly string $jwtIssuer,',
          '    ) {',
          '    }',
        ],
    '',
    '    public static function getSubscribedEvents(): array',
    '    {',
    "        return [KernelEvents::CONTROLLER => 'onController'];",
    '    }',
    '',
    '    public function onController(ControllerEvent $event): void',
    '    {',
    '        $attributes = $event->getAttributes(RequiresAccess::class);',
    '        if ($attributes === []) {',
    '            return;',
    '        }',
    check,
    '    }',
    auth === 'jwt' && [
      '',
      '    /** Verifies the token: signature, expiry (required) and, when configured, audience and issuer. */',
      '    private function claims(Request $request): object',
      '    {',
      "        $header = (string) $request->headers->get('Authorization', '');",
      "        $token = str_starts_with($header, 'Bearer ') ? substr($header, 7) : '';",
      "        if ($token === '' || $this->jwtSecret === '') {",
      '            throw ApiException::unauthorized();',
      '        }',
      '        try {',
      '            $claims = JWT::decode($token, new Key($this->jwtSecret, $this->jwtAlgorithm));',
      '        } catch (\\Throwable) {',
      '            throw ApiException::unauthorized();',
      '        }',
      '        $audience = (array) ($claims->aud ?? []);',
      '        $wrong = ! isset($claims->exp)',
      "            || ($this->jwtAudience !== '' && ! in_array($this->jwtAudience, $audience, true))",
      "            || ($this->jwtIssuer !== '' && ($claims->iss ?? null) !== $this->jwtIssuer);",
      '        if ($wrong) {',
      '            throw ApiException::unauthorized();',
      '        }',
      '',
      '        return $claims;',
      '    }',
    ],
    '}',
  ])
  return [attribute, subscriber]
}
