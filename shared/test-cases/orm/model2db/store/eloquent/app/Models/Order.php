<?php

namespace App\Models;

use App\Enums\OrderStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Model written by Model2DB from Order. Review it before using it. */
// TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
class Order extends Model
{
    protected $table = 'orders';

    protected $primaryKey = 'id';
    public $incrementing = false;
    public $timestamps = false;

    protected $fillable = ['id', 'status', 'total', 'notes', 'created_at', 'updated_at', 'customer_id'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'status' => OrderStatus::class,
            'total' => 'float',
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
            'customer_id' => 'integer',
        ];
    }

    public function lines(): HasMany
    {
        return $this->hasMany(OrderLine::class, 'order_id', 'id');
    }

    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'customer_id', 'id');
    }
}
