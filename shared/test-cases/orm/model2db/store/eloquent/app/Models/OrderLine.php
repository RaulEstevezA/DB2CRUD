<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Model written by Model2DB from Order. Review it before using it. */
class OrderLine extends Model
{
    protected $table = 'order_lines';

    protected $primaryKey = 'id';
    public $timestamps = false;

    protected $fillable = ['quantity', 'unit_price', 'product_id', 'order_id'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'quantity' => 'integer',
            'unit_price' => 'float',
            'product_id' => 'integer',
            'order_id' => 'integer',
        ];
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id', 'id');
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'order_id', 'id');
    }
}
