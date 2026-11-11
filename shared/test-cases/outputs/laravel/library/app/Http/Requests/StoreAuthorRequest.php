<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that creates or replaces an author. */
final class StoreAuthorRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['present', 'string', 'min:2', 'max:120', new BlankString(text: true, min: 2, max: 120)],
            'email' => ['sometimes', 'nullable', 'string', 'email', new BlankString(text: true, format: true)],
            'born' => ['sometimes', 'nullable', 'string', 'date_format:Y-m-d', new BlankString(text: true, format: true)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();
        if (! array_key_exists('email', $values)) {
            $values['email'] = null;
        }
        if (! array_key_exists('born', $values)) {
            $values['born'] = null;
        }

        return $values;
    }
}
