<?php

namespace App\Support;

/** Compares values as JSON does: a whole number equals the same number with decimals. */
final class Values
{
    public static function same(mixed $left, mixed $right): bool
    {
        if (is_numeric($left) && is_numeric($right) && ! is_string($left) && ! is_string($right)) {
            return $left == $right;
        }

        return $left === $right;
    }

    /** Texts in character order, numbers by value. */
    public static function compare(mixed $left, mixed $right): int
    {
        if (is_string($left) && is_string($right)) {
            return strcmp($left, $right);
        }

        return $left <=> $right;
    }
}
