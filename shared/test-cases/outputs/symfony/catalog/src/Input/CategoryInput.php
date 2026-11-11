<?php

namespace App\Input;

use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of a category. */
final class CategoryInput
{
    /** The body of a request that creates or replaces a category. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 1, max: 80),
            ]),
            'parentId' => new Assert\Optional([new Assert\Type('integer')]),
        ]);
    }

    /** The body of a request that changes part of a category: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 1, max: 80),
            ]),
            'parentId' => new Assert\Optional([new Assert\Type('integer')]),
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
