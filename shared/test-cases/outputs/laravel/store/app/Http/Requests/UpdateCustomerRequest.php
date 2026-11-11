<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that changes part of a customer: only the fields sent change. */
final class UpdateCustomerRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', new BlankString(text: true)],
            'email' => ['sometimes', 'string', new BlankString(text: true)],
            'password' => ['sometimes', 'string', new BlankString(text: true)],
            'phone' => ['sometimes', 'string', new BlankString(text: true)],
            'address' => ['sometimes', 'array', new BlankString(text: false)],
            'address.street' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.city' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.postalCode' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.country' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
