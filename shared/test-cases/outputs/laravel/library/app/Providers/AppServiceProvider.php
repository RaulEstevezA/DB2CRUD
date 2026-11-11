<?php

namespace App\Providers;

use App\Repositories\AuthorRepository;
use App\Repositories\BookRepository;
use App\Repositories\InMemoryAuthorRepository;
use App\Repositories\InMemoryBookRepository;
use Illuminate\Support\ServiceProvider;

/** Wires the application: the storage each repository interface uses. */
final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Data kept in memory while the application runs; restarting it (or each test) starts empty
        $this->app->singleton(AuthorRepository::class, InMemoryAuthorRepository::class);
        $this->app->singleton(BookRepository::class, InMemoryBookRepository::class);
    }
}
