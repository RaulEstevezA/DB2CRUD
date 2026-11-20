<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Model written by Model2DB from Item. Review it before using it. */
class Item extends Model
{
    protected $table = 'items';

    protected $primaryKey = 'id';
    public $timestamps = false;

    protected $fillable = ['name', 'price', 'supplier_email', 'stock', 'category_id'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'price' => 'decimal:2',
            'stock' => 'integer',
            'category_id' => 'integer',
        ];
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class, 'category_id', 'id');
    }
}
