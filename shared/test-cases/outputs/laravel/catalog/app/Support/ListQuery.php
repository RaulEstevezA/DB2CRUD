<?php

namespace App\Support;

/** What a list asks a repository for: equality filters by JSON field name, an order and a window of items. */
final class ListQuery
{
    /** @param array<string, mixed> $filters */
    public function __construct(
        public readonly array $filters = [],
        public readonly ?string $sortField = null,
        public readonly bool $descending = false,
        public readonly int $offset = 0,
        public readonly ?int $limit = null,
    ) {
    }

    /**
     * "-createdAt" sorts by createdAt in descending order.
     *
     * @param  array<string, mixed>  $filters
     */
    public static function of(array $filters, ?string $sort, int $offset = 0, ?int $limit = null): self
    {
        if ($sort === null || $sort === '') {
            return new self($filters, null, false, $offset, $limit);
        }
        $descending = str_starts_with($sort, '-');

        return new self($filters, $descending ? substr($sort, 1) : $sort, $descending, $offset, $limit);
    }
}
