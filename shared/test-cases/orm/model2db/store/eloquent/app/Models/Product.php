<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Model written by Model2DB from Order. Review it before using it. */
class Product extends Model
{
    protected $table = 'products';

    protected $primaryKey = 'id';
    public $incrementing = false;
    public $timestamps = false;

    protected $fillable = ['id', 'sku', 'name', 'description', 'price', 'stock', 'active'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'price' => 'float',
            'stock' => 'integer',
            'active' => 'boolean',
        ];
    }
}
