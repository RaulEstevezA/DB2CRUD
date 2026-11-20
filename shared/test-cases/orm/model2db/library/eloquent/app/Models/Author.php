<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Model written by Model2DB from Book. Review it before using it. */
class Author extends Model
{
    protected $table = 'authors';

    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $fillable = ['id', 'name', 'email', 'born'];

    protected function casts(): array
    {
        return [
            'born' => 'immutable_date',
        ];
    }
}
