<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that changes part of a product: only the fields sent change. */
final class UpdateProductRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'sku' => ['sometimes', 'string', new BlankString(text: true)],
            'name' => ['sometimes', 'string', new BlankString(text: true)],
            'description' => ['sometimes', 'string', new BlankString(text: true)],
            'price' => ['sometimes', 'numeric:strict', new BlankString(text: false)],
            'stock' => ['sometimes', 'numeric:strict', new BlankString(text: false)],
            'active' => ['sometimes', 'boolean:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
