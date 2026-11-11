<?php

namespace App\Input;

use App\Enum\Genre;
use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of a book. */
final class BookInput
{
    /** The body of a request that creates or replaces a book. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'title' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 1, max: 200),
            ]),
            'isbn' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Regex(pattern: '/^[0-9]{13}$/u'),
                new Assert\NotBlank(allowNull: true),
            ]),
            'authorId' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Uuid(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'genre' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Choice(choices: array_column(Genre::cases(), 'value')),
            ]),
            'pages' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('integer'),
                new Assert\GreaterThanOrEqual(1),
                new Assert\LessThanOrEqual(5000),
            ]),
            'published' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Date(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'available' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('bool')]),
        ]);
    }

    /** The body of a request that changes part of a book: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'title' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Length(min: 1, max: 200),
            ]),
            'isbn' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Regex(pattern: '/^[0-9]{13}$/u'),
                new Assert\NotBlank(allowNull: true),
            ]),
            'authorId' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('string'),
                new Assert\Uuid(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'genre' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Choice(choices: array_column(Genre::cases(), 'value')),
            ]),
            'pages' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('integer'),
                new Assert\GreaterThanOrEqual(1),
                new Assert\LessThanOrEqual(5000),
            ]),
            'published' => new Assert\Optional([
                new Assert\Type('string'),
                new Assert\Date(),
                new Assert\NotBlank(allowNull: true),
            ]),
            'available' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('bool')]),
        ]);
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed> The values of a creation, with the defaults of the fields left out.
     */
    public static function createValues(array $values): array
    {
        if (! array_key_exists('published', $values)) {
            $values['published'] = null;
        }
        if (! array_key_exists('available', $values)) {
            $values['available'] = true;
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
