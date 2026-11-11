<?php

namespace App\Exception;

use RuntimeException;

/** An error the API answers with a status, a code and a message (see openapi.yaml). */
final class ApiException extends RuntimeException
{
    /** @param list<array{field: string, message: string}> $details */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $details = [],
    ) {
        parent::__construct($message);
    }

    public static function invalid(string $field, string $message): self
    {
        return new self(400, 'validation_error', 'The request is not valid', [['field' => $field, 'message' => $message]]);
    }

    public static function unauthorized(): self
    {
        return new self(401, 'unauthorized', 'Missing or invalid credentials');
    }

    public static function forbidden(): self
    {
        return new self(403, 'forbidden', 'The credentials do not allow this operation');
    }

    public static function notFound(string $what): self
    {
        return new self(404, 'not_found', "No {$what} has this key");
    }

    public static function conflict(string $message): self
    {
        return new self(409, 'conflict', $message);
    }
}
