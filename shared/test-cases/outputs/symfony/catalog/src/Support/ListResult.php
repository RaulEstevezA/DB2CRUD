<?php

namespace App\Support;

/** A window of items and how many match, whatever the window. */
final class ListResult
{
    /** @param list<array<string, mixed>> $items */
    public function __construct(
        public readonly array $items,
        public readonly int $total,
    ) {
    }
}
