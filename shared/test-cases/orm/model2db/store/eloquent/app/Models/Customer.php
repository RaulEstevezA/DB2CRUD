<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Model written by Model2DB from Order. Review it before using it. */
class Customer extends Model
{
    protected $table = 'customers';

    protected $primaryKey = 'id';
    public $incrementing = false;
    public $timestamps = false;

    protected $fillable = ['id', 'name', 'email', 'password', 'phone', 'created_at', 'address_street', 'address_city', 'address_postal_code', 'address_country'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'created_at' => 'immutable_datetime',
        ];
    }
}
