<?php

use App\Exceptions\ApiErrors;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull;
use Illuminate\Foundation\Http\Middleware\TrimStrings;

// Builds the application: the routes of routes/api.php at the root of the site, the middleware of each
// protection, and one error format for every answer (see openapi.yaml).
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        apiPrefix: '',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Bodies are read as sent: an empty text stays empty and spaces are kept
        $middleware->remove([ConvertEmptyStringsToNull::class, TrimStrings::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->render(fn (Throwable $error) => ApiErrors::render($error));
    })->create();
