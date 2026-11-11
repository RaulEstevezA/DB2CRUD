<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that creates or replaces a product. */
final class StoreProductRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'sku' => ['present', 'string', new BlankString(text: true)],
            'name' => ['present', 'string', new BlankString(text: true)],
            'description' => ['sometimes', 'string', new BlankString(text: true)],
            'price' => ['present', 'numeric:strict', new BlankString(text: false)],
            'stock' => ['present', 'numeric:strict', new BlankString(text: false)],
            'active' => ['present', 'boolean:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
