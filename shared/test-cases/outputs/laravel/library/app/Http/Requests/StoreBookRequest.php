<?php

namespace App\Http\Requests;

use App\Enums\Genre;
use App\Rules\BlankString;
use Illuminate\Validation\Rule;

/** Body of a request that creates or replaces a book. */
final class StoreBookRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'title' => ['present', 'string', 'min:1', 'max:200', new BlankString(text: true, min: 1, max: 200)],
            'isbn' => ['present', 'string', 'regex:/^[0-9]{13}$/u', new BlankString(text: true, pattern: '/^[0-9]{13}$/u')],
            'authorId' => ['present', 'string', 'uuid', new BlankString(text: true, format: true)],
            'genre' => ['present', Rule::enum(Genre::class), new BlankString(text: false)],
            'pages' => ['present', 'integer:strict', 'min:1', 'max:5000', new BlankString(text: false)],
            'published' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', new BlankString(text: true, format: true)],
            'available' => ['sometimes', 'boolean:strict', new BlankString(text: false)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();
        if (! array_key_exists('published', $values)) {
            $values['published'] = null;
        }
        if (! array_key_exists('available', $values)) {
            $values['available'] = true;
        }

        return $values;
    }
}
