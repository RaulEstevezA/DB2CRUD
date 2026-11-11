<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that changes part of an item: only the fields sent change. */
final class UpdateItemRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', 'min:3', 'max:120', new BlankString(text: true, min: 3, max: 120)],
            'price' => ['sometimes', 'numeric:strict', 'min:0', new BlankString(text: false)],
            'supplierEmail' => ['sometimes', 'string', 'email', new BlankString(text: true, format: true)],
            'categoryId' => ['sometimes', 'integer:strict', new BlankString(text: false)],
            'stock' => ['sometimes', 'integer:strict', 'min:0', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
