<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Model written by Model2DB from Item. Review it before using it. */
class Category extends Model
{
    protected $table = 'categories';

    protected $primaryKey = 'id';
    public $timestamps = false;

    protected $fillable = ['name', 'parent_id'];

    protected function casts(): array
    {
        return [
            'id' => 'integer',
            'parent_id' => 'integer',
        ];
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(Category::class, 'parent_id', 'id');
    }
}
