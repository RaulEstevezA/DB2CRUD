<?php

namespace App\Providers;

use App\Repositories\CategoryRepository;
use App\Repositories\InMemoryCategoryRepository;
use App\Repositories\InMemoryItemRepository;
use App\Repositories\ItemRepository;
use Illuminate\Support\ServiceProvider;

/** Wires the application: the storage each repository interface uses. */
final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Data kept in memory while the application runs; restarting it (or each test) starts empty
        $this->app->singleton(CategoryRepository::class, InMemoryCategoryRepository::class);
        $this->app->singleton(ItemRepository::class, InMemoryItemRepository::class);
    }
}
