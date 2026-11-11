<?php

namespace App\Http\Requests;

use App\Enums\OrderStatus;
use App\Rules\BlankString;
use Illuminate\Validation\Rule;

/** Body of a request that creates or replaces an order. */
final class StoreOrderRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'customerId' => ['present', 'integer:strict', new BlankString(text: false)],
            'lines' => ['present', 'list', new BlankString(text: false)],
            'lines.*' => ['array', new BlankString(text: false)],
            'lines.*.productId' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'integer:strict', new BlankString(text: false)],
            'lines.*.quantity' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'numeric:strict', new BlankString(text: false)],
            'lines.*.unitPrice' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'numeric:strict', new BlankString(text: false)],
            'status' => ['present', Rule::enum(OrderStatus::class), new BlankString(text: false)],
            'total' => ['present', 'numeric:strict', new BlankString(text: false)],
            'notes' => ['sometimes', 'nullable', 'string', new BlankString(text: true)],
        ];
    }

    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
