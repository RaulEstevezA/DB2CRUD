<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Repositories\ProductRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of products: what each operation checks and changes. */
final class ProductService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id'];

    public function __construct(
        private readonly ProductRepository $repository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(int $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('product');
    }

    /** List products. */
    public function listProducts(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get a product. */
    public function getProduct(int $key): array
    {
        return $this->find($key);
    }

    /**
     * Create a product.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createProduct(array $values): array
    {
        $item = $values;

        return $this->repository->add($item);
    }

    /**
     * Replace a product: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceProduct(int $key, array $values): array
    {
        $current = $this->find($key);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of a product: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateProduct(int $key, array $values): array
    {
        $current = $this->find($key);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete a product. */
    public function deleteProduct(int $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
