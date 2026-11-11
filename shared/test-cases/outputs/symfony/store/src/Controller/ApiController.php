<?php

namespace App\Controller;

use App\Exception\ApiException;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Uid\Uuid;

/**
 * Base of the controllers. Keys in paths and values in query strings are text: they are read with their type,
 * and a malformed one is a 400, not a missing item.
 */
abstract class ApiController
{
    protected function integerKey(Request $request, string $name): int
    {
        $value = (string) $request->attributes->get($name);
        if (preg_match('/^-?\d+$/', $value) !== 1) {
            throw ApiException::invalid($name, 'Must be a whole number');
        }

        return (int) $value;
    }

    protected function uuidKey(Request $request, string $name): string
    {
        $value = (string) $request->attributes->get($name);
        if (! Uuid::isValid($value)) {
            throw ApiException::invalid($name, 'Must be a UUID');
        }

        return $value;
    }

    protected function textKey(Request $request, string $name): string
    {
        return (string) $request->attributes->get($name);
    }

    /** A whole number of the query string, within its limits; the default when it is not there. */
    protected function integerQuery(Request $request, string $name, ?int $default = null, ?int $min = null, ?int $max = null): ?int
    {
        $value = $request->query->get($name);
        if ($value === null) {
            return $default;
        }
        if (preg_match('/^-?\d+$/', $value) !== 1 || ($min !== null && (int) $value < $min) || ($max !== null && (int) $value > $max)) {
            throw ApiException::invalid($name, 'Must be a whole number within its limits');
        }

        return (int) $value;
    }

    protected function numberQuery(Request $request, string $name): ?float
    {
        $value = $request->query->get($name);
        if ($value !== null && ! is_numeric($value)) {
            throw ApiException::invalid($name, 'Must be a number');
        }

        return $value === null ? null : (float) $value;
    }

    protected function booleanQuery(Request $request, string $name): ?bool
    {
        $value = $request->query->get($name);
        if ($value !== null && ! in_array($value, ['true', 'false'], true)) {
            throw ApiException::invalid($name, 'Must be true or false');
        }

        return $value === null ? null : $value === 'true';
    }

    /**
     * A value of the query string that must be one of $choices, compared as text.
     *
     * @param  list<string|int>  $choices
     */
    protected function choiceQuery(Request $request, string $name, array $choices): string|int|null
    {
        $value = $request->query->get($name);
        if ($value === null) {
            return null;
        }
        foreach ($choices as $choice) {
            if ((string) $choice === $value) {
                return $choice;
            }
        }
        throw ApiException::invalid($name, 'Must be one of: '.implode(', ', $choices));
    }

    /** Text of the query string that matches $pattern, when one is given. */
    protected function textQuery(Request $request, string $name, ?string $pattern = null): ?string
    {
        $value = $request->query->get($name);
        if ($value !== null && $pattern !== null && preg_match($pattern, $value) !== 1) {
            throw ApiException::invalid($name, 'Has the wrong format');
        }

        return $value;
    }

    protected function answer(mixed $data, int $status): JsonResponse
    {
        return new JsonResponse($data, $status);
    }

    protected function empty(int $status): Response
    {
        return new Response(null, $status);
    }
}
