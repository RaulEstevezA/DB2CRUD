<?php

namespace App\Input;

use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of a customer. */
final class CustomerInput
{
    /** The body of a request that creates or replaces a customer. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
            'email' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
            'password' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
            'phone' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'address' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('array'),
                new Assert\Collection(fields: [
                    'street' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'city' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'postalCode' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'country' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                ]),
            ]),
        ]);
    }

    /** The body of a request that changes part of a customer: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'email' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'password' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'phone' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('string')]),
            'address' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('array'),
                new Assert\Collection(fields: [
                    'street' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'city' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'postalCode' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                    'country' => new Assert\Required([new Assert\NotNull(), new Assert\Type('string')]),
                ]),
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
