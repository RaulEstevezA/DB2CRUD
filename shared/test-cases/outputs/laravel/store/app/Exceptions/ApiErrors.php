<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** Answers every error with the body of openapi.yaml: {"error": {"code", "message", "details"}}. */
final class ApiErrors
{
    public static function render(\Throwable $error): JsonResponse
    {
        return match (true) {
            $error instanceof ApiException => self::answer($error->status, $error->errorCode, $error->getMessage(), $error->details),
            $error instanceof ValidationException => self::answer(400, 'validation_error', 'The request is not valid', self::details($error)),
            $error instanceof NotImplementedException => self::answer(501, 'not_implemented', $error->getMessage() ?: 'The logic of this operation is not written yet'),
            $error instanceof NotFoundHttpException => self::answer(404, 'not_found', 'No route matches this request'),
            $error instanceof MethodNotAllowedHttpException => self::answer(405, 'method_not_allowed', 'This path does not accept this method'),
            default => self::unexpected($error),
        };
    }

    /** @param list<array{field: string, message: string}> $details */
    public static function answer(int $status, string $code, string $message, array $details = []): JsonResponse
    {
        $error = ['code' => $code, 'message' => $message];
        if ($details !== []) {
            $error['details'] = $details;
        }

        return response()->json(['error' => $error], $status);
    }

    /** @return list<array{field: string, message: string}> */
    private static function details(ValidationException $error): array
    {
        $details = [];
        foreach ($error->errors() as $field => $messages) {
            foreach ($messages as $message) {
                $details[] = ['field' => (string) $field, 'message' => $message];
            }
        }

        return $details;
    }

    private static function unexpected(\Throwable $error): JsonResponse
    {
        report($error);

        return self::answer(500, 'internal_error', 'Something went wrong on the server');
    }
}
