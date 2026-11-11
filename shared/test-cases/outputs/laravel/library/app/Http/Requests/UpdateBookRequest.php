<?php

namespace App\Http\Requests;

use App\Enums\Genre;
use App\Rules\BlankString;
use Illuminate\Validation\Rule;

/** Body of a request that changes part of a book: only the fields sent change. */
final class UpdateBookRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'title' => ['sometimes', 'string', 'min:1', 'max:200', new BlankString(text: true, min: 1, max: 200)],
            'isbn' => ['sometimes', 'string', 'regex:/^[0-9]{13}$/u', new BlankString(text: true, pattern: '/^[0-9]{13}$/u')],
            'authorId' => ['sometimes', 'string', 'uuid', new BlankString(text: true, format: true)],
            'genre' => ['sometimes', Rule::enum(Genre::class), new BlankString(text: false)],
            'pages' => ['sometimes', 'integer:strict', 'min:1', 'max:5000', new BlankString(text: false)],
            'published' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', new BlankString(text: true, format: true)],
            'available' => ['sometimes', 'boolean:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
