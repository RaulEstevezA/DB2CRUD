<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** A customer as the API returns it: everything but what clients only send. */
final class CustomerResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        $item = $this->resource;

        return [
            'id' => $item['id'] ?? null,
            'name' => $item['name'] ?? null,
            'email' => $item['email'] ?? null,
            'phone' => $this->when(isset($item['phone']), fn () => $item['phone'] ?? null),
            'address' => self::object($item['address'] ?? null),
            'createdAt' => $item['createdAt'] ?? null,
        ];
    }

    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        return (new self($item))->resolve();
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    public static function many(array $items): array
    {
        return array_map(self::one(...), $items);
    }

    /** An empty array is an empty JSON object here, not a list. */
    private static function object(mixed $value): mixed
    {
        return $value === [] ? new \stdClass() : $value;
    }
}
