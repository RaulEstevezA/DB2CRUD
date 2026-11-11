<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Repositories\CategoryRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of categories: what each operation checks and changes. */
final class CategoryService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id'];

    public function __construct(
        private readonly CategoryRepository $repository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(int $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('category');
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
        $this->require($this->repository, $values['parentId'] ?? null, 'parentId', 'Category');
    }

    /** List categories. */
    public function listCategories(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get a category. */
    public function getCategory(int $key): array
    {
        return $this->find($key);
    }

    /**
     * Create a category.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createCategory(array $values): array
    {
        $this->checkReferences($values);
        $item = $values;

        return $this->repository->add($item);
    }

    /**
     * Replace a category: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceCategory(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of a category: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateCategory(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete a category. */
    public function deleteCategory(int $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
