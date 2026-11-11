<?php

namespace App\Input;

use App\Enum\OrderStatus;
use Symfony\Component\Validator\Constraints as Assert;

/** Bodies of the requests that create, replace or change part of an order. */
final class OrderInput
{
    /** The body of a request that creates or replaces an order. */
    public static function create(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'customerId' => new Assert\Required([new Assert\NotNull(), new Assert\Type('integer')]),
            'lines' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Type('list'),
                new Assert\All([
                    new Assert\NotNull(),
                    new Assert\Type('array'),
                    new Assert\Collection(fields: [
                        'productId' => new Assert\Required([new Assert\NotNull(), new Assert\Type('integer')]),
                        'quantity' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
                        'unitPrice' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
                    ]),
                ]),
            ]),
            'status' => new Assert\Required([
                new Assert\NotNull(),
                new Assert\Choice(choices: array_column(OrderStatus::cases(), 'value')),
            ]),
            'total' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'notes' => new Assert\Optional([new Assert\Type('string')]),
        ]);
    }

    /** The body of a request that changes part of an order: only the fields sent change. */
    public static function update(): Assert\Collection
    {
        return new Assert\Collection(fields: [
            'customerId' => new Assert\Optional([new Assert\NotNull(), new Assert\Type('integer')]),
            'lines' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Type('list'),
                new Assert\All([
                    new Assert\NotNull(),
                    new Assert\Type('array'),
                    new Assert\Collection(fields: [
                        'productId' => new Assert\Required([new Assert\NotNull(), new Assert\Type('integer')]),
                        'quantity' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
                        'unitPrice' => new Assert\Required([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
                    ]),
                ]),
            ]),
            'status' => new Assert\Optional([
                new Assert\NotNull(),
                new Assert\Choice(choices: array_column(OrderStatus::cases(), 'value')),
            ]),
            'total' => new Assert\Optional([new Assert\NotNull(), new Assert\Type(['integer', 'float'])]),
            'notes' => new Assert\Optional([new Assert\Type('string')]),
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
