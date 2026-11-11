<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use Illuminate\Support\Str;

/** Base of the controllers: the key in a path, read with its type. A malformed key is a 400, not a missing item. */
abstract class Controller
{
    protected function integerKey(string $value, string $name): int
    {
        if (preg_match('/^-?\d+$/', $value) !== 1) {
            throw ApiException::invalid($name, 'Must be a whole number');
        }

        return (int) $value;
    }

    protected function uuidKey(string $value, string $name): string
    {
        if (! Str::isUuid($value)) {
            throw ApiException::invalid($name, 'Must be a UUID');
        }

        return $value;
    }
}
