<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that creates or replaces an item. */
final class StoreItemRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['present', 'string', 'min:3', 'max:120', new BlankString(text: true, min: 3, max: 120)],
            'price' => ['present', 'numeric:strict', 'min:0', new BlankString(text: false)],
            'supplierEmail' => ['present', 'string', 'email', new BlankString(text: true, format: true)],
            'categoryId' => ['present', 'integer:strict', new BlankString(text: false)],
            'stock' => ['present', 'integer:strict', 'min:0', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
