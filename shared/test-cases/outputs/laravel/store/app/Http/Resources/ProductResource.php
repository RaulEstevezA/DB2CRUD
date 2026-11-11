<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** A product as the API returns it: everything but what clients only send. */
final class ProductResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        $item = $this->resource;

        return [
            'id' => $item['id'] ?? null,
            'sku' => $item['sku'] ?? null,
            'name' => $item['name'] ?? null,
            'description' => $this->when(isset($item['description']), fn () => $item['description'] ?? null),
            'price' => $item['price'] ?? null,
            'stock' => $item['stock'] ?? null,
            'active' => $item['active'] ?? null,
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
}
