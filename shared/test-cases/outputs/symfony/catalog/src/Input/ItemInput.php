<?php

namespace App\Input;

use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of an item. */
final class ItemInput
{
    /** The body of a request that creates or replaces an item. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 3, max: 120),
            ]),
            'price' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type(['integer', 'float']),
                new Assert\GreaterThanOrEqual(0),
            ]),
            'supplierEmail' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Email(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'categoryId' => new Assert\Required([new Assert\NotNull(), new Assert\Type('integer')]),
            'stock' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('integer'),
                new Assert\GreaterThanOrEqual(0),
            ]),
        ]);
    }

    /** The body of a request that changes part of an item: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 3, max: 120),
            ]),
            'price' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type(['integer', 'float']),
                new Assert\GreaterThanOrEqual(0),
            ]),
            'supplierEmail' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Email(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'categoryId' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('integer')]),
            'stock' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('integer'),
                new Assert\GreaterThanOrEqual(0),
            ]),
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
