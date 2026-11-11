<?php

namespace App\Input;

use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of an author. */
final class AuthorInput
{
    /** The body of a request that creates or replaces an author. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 2, max: 120),
            ]),
            'email' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Email(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'born' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Date(),
                new Assert\NotBlank(allowNull: true),
            ]),
        ]);
    }

    /** The body of a request that changes part of an author: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'name' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 2, max: 120),
            ]),
            'email' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Email(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'born' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Date(),
                new Assert\NotBlank(allowNull: true),
            ]),
        ]);
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed> The values of a creation, with the defaults of the fields left out.
     */
    public static function createValues(array $values): array
    {
        if (! array_key_exists('email', $values)) {
            $values['email'] = null;
        }
        if (! array_key_exists('born', $values)) {
            $values['born'] = null;
        }

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
