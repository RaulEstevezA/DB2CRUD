<?php

namespace App\Input;

use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of a product. */
final class ProductInput
{
    /** The body of a request that creates or replaces a product. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'sku' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
            'name' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
            'description' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'price' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'stock' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'active' => new Assert\Required([new Assert\NotNull(), new Assert\Type('bool')]),
        ]);
    }

    /** The body of a request that changes part of a product: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'sku' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'name' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'description' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'price' => new Assert\Optional([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'stock' => new Assert\Optional([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'active' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('bool')]),
        ]);
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed> The values of a creation, with the defaults of the fields left out.
     */
    public static function createValues(array $values): array
    {
        return $values;
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed> The values of a change, with the defaults inside the objects sent.
     */
    public static function updateValues(array $values): array
    {
        return $values;
    }
}
