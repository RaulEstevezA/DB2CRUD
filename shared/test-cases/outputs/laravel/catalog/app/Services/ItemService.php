<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Repositories\CategoryRepository;
use App\Repositories\ItemRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of items: what each operation checks and changes. */
final class ItemService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id'];

    public function __construct(
        private readonly ItemRepository $repository,
        private readonly CategoryRepository $categoryRepository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(int $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('item');
    }

    /** A reference must point to a stored item. */
    private function require(object $repository, mixed $key, string $field, string $model): void
    {
        if ($key !== null && $repository->get($key) === null) {
            throw ApiException::invalid($field, "No {$model} has this key");
        }
    }

    /** @param array<string, mixed> $values */
    private function checkReferences(array $values): void
    {
        $this->require($this->categoryRepository, $values['categoryId'] ?? null, 'categoryId', 'Category');
    }

    /** List items. */
    public function listItems(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get an item. */
    public function getItem(int $key): array
    {
        return $this->find($key);
    }

    /**
     * Create an item.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createItem(array $values): array
    {
        $this->checkReferences($values);
        $item = $values;

        return $this->repository->add($item);
    }

    /**
     * Replace an item: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceItem(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of an item: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateItem(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete an item. */
    public function deleteItem(int $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
