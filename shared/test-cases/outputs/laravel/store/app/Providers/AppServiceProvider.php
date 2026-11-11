<?php

namespace App\Providers;

use App\Repositories\CustomerRepository;
use App\Repositories\InMemoryCustomerRepository;
use App\Repositories\InMemoryOrderRepository;
use App\Repositories\InMemoryProductRepository;
use App\Repositories\OrderRepository;
use App\Repositories\ProductRepository;
use Illuminate\Support\ServiceProvider;

/** Wires the application: the storage each repository interface uses. */
final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Data kept in memory while the application runs; restarting it (or each test) starts empty
        $this->app->singleton(CustomerRepository::class, InMemoryCustomerRepository::class);
        $this->app->singleton(ProductRepository::class, InMemoryProductRepository::class);
        $this->app->singleton(OrderRepository::class, InMemoryOrderRepository::class);
    }
}
