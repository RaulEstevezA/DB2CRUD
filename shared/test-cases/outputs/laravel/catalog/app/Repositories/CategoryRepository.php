<?php

namespace App\Repositories;

use App\Support\ListQuery;
use App\Support\ListResult;

/** Where categories are kept. The service depends only on this interface; items are arrays keyed by JSON name. */
interface CategoryRepository
{
    /** Items equal to every filter, in order, within the window; and how many match. */
    public function list(ListQuery $query): ListResult;

    /** @return array<string, mixed>|null The item with this key, or null. */
    public function get(int $key): ?array;

    /**
     * Stores a new item and assigns its key.
     *
     * @param  array<string, mixed>  $item
     * @return array<string, mixed> The item as stored.
     */
    public function add(array $item): array;

    /**
     * Stores the new state of an existing item: every field, as given.
     *
     * @param  array<string, mixed>  $item
     * @return array<string, mixed> The item as stored.
     */
    public function save(int $key, array $item): array;

    /** Removes an existing item. */
    public function delete(int $key): void;
}
