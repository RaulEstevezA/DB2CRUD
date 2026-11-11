<?php

namespace App\Http\Requests;

use App\Rules\BlankString;

/** Body of a request that creates or replaces a customer. */
final class StoreCustomerRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'name' => ['present', 'string', new BlankString(text: true)],
            'email' => ['present', 'string', new BlankString(text: true)],
            'password' => ['present', 'string', new BlankString(text: true)],
            'phone' => ['sometimes', 'string', new BlankString(text: true)],
            'address' => ['present', 'array', new BlankString(text: false)],
            'address.street' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.city' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.postalCode' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
            'address.country' => ['exclude_if:address,null', 'present_with:address', 'string', new BlankString(text: true)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
