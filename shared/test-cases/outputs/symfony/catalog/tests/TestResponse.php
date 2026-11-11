<?php

namespace App\Tests;

use PHPUnit\Framework\Assert;
use Symfony\Component\HttpFoundation\Response;

/** The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code"). */
final class TestResponse
{
    public function __construct(private readonly Response $response)
    {
    }

    public function assertStatus(int $status): void
    {
        Assert::assertSame($status, $this->response->getStatusCode(), (string) $this->response->getContent());
    }

    public function json(?string $path = null): mixed
    {
        $value = json_decode((string) $this->response->getContent(), true);
        foreach ($path === null ? [] : explode('.', $path) as $part) {
            $value = is_array($value) ? ($value[$part] ?? null) : null;
        }

        return $value;
    }
}
