<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that changes part of an author: only the fields sent change. */
final class UpdateAuthorRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', 'min:2', 'max:120', new BlankString(text: true, min: 2, max: 120)],
            'email' => ['sometimes', 'nullable', 'string', 'email', new BlankString(text: true, format: true)],
            'born' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', new BlankString(text: true, format: true)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
