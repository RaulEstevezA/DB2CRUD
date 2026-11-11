<?php

use App\Http\Controllers\CustomerController;
use App\Http\Controllers\OrderController;
use App\Http\Controllers\ProductController;
use Illuminate\Support\Facades\Route;

// Every route of the API, with its protection. The contract is in openapi.yaml.

// Customers
Route::get('/customers', [CustomerController::class, 'listCustomers']);
Route::get('/customers/{id}', [CustomerController::class, 'getCustomer']);
Route::post('/customers', [CustomerController::class, 'createCustomer']);
Route::put('/customers/{id}', [CustomerController::class, 'replaceCustomer']);
Route::patch('/customers/{id}', [CustomerController::class, 'updateCustomer']);
Route::delete('/customers/{id}', [CustomerController::class, 'deleteCustomer']);

// Products
Route::get('/products', [ProductController::class, 'listProducts']);
Route::get('/products/{id}', [ProductController::class, 'getProduct']);
Route::post('/products', [ProductController::class, 'createProduct']);
Route::put('/products/{id}', [ProductController::class, 'replaceProduct']);
Route::patch('/products/{id}', [ProductController::class, 'updateProduct']);
Route::delete('/products/{id}', [ProductController::class, 'deleteProduct']);

// Orders
Route::get('/orders', [OrderController::class, 'listOrders']);
Route::get('/orders/{id}', [OrderController::class, 'getOrder']);
Route::post('/orders', [OrderController::class, 'createOrder']);
Route::put('/orders/{id}', [OrderController::class, 'replaceOrder']);
Route::patch('/orders/{id}', [OrderController::class, 'updateOrder']);
Route::delete('/orders/{id}', [OrderController::class, 'deleteOrder']);
