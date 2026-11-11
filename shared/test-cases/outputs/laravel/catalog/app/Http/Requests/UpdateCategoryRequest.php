<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that changes part of a category: only the fields sent change. */
final class UpdateCategoryRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', 'min:1', 'max:80', new BlankString(text: true, min: 1, max: 80)],
            'parentId' => ['sometimes', 'nullable', 'integer:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
