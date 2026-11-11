<?php

namespace App\Http\Requests;

use App\Enums\OrderStatus;
use App\Rules\BlankString;
use Illuminate\Validation\Rule;

/** Body of a request that changes part of an order: only the fields sent change. */
final class UpdateOrderRequest extends ApiRequest
{
    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'customerId' => ['sometimes', 'integer:strict', new BlankString(text: false)],
            'lines' => ['sometimes', 'list', new BlankString(text: false)],
            'lines.*' => ['array', new BlankString(text: false)],
            'lines.*.productId' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'integer:strict', new BlankString(text: false)],
            'lines.*.quantity' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'numeric:strict', new BlankString(text: false)],
            'lines.*.unitPrice' => ['exclude_if:lines.*,null', 'present_with:lines.*', 'numeric:strict', new BlankString(text: false)],
            'status' => ['sometimes', Rule::enum(OrderStatus::class), new BlankString(text: false)],
            'total' => ['sometimes', 'numeric:strict', new BlankString(text: false)],
            'notes' => ['sometimes', 'nullable', 'string', new BlankString(text: true)],
        ];
    }

    /** @return array<string, mixed> The values sent. */
    public function values(): array
    {
        $values = $this->validated();

        return $values;
    }
}
