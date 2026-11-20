<?php

namespace App\Models;

use App\Enums\Genre;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Model written by Model2DB from Book. Review it before using it. */
// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
class Book extends Model
{
    protected $table = 'books';

    protected $primaryKey = 'id';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected $fillable = ['id', 'title', 'isbn', 'genre', 'pages', 'published', 'available', 'author_id'];

    protected function casts(): array
    {
        return [
            'genre' => Genre::class,
            'pages' => 'integer',
            'published' => 'immutable_date',
            'available' => 'boolean',
        ];
    }

    public function author(): BelongsTo
    {
        return $this->belongsTo(Author::class, 'author_id', 'id');
    }
}
