<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that creates or replaces a category. */
final class StoreCategoryRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['present', 'string', 'min:1', 'max:80', new BlankString(text: true, min: 1, max: 80)],
            'parentId' => ['sometimes', 'nullable', 'integer:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
