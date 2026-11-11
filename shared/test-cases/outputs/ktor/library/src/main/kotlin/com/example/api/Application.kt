package com.example.api

import com.example.api.common.JsonFormat
import com.example.api.common.Settings
import com.example.api.common.installErrors
import com.example.api.repository.InMemoryAuthorRepository
import com.example.api.repository.InMemoryBookRepository
import com.example.api.routes.authorRoutes
import com.example.api.routes.bookRoutes
import com.example.api.service.AuthorService
import com.example.api.service.BookService
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing

/** Starts the API on PORT (8080 by default) with the settings of the environment. */
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    embeddedServer(Netty, port = port) { module(Settings.fromEnvironment()) }.start(wait = true)
}

/** The API: JSON, errors, authentication, storage and routes. */
fun Application.module(settings: Settings) {
    install(ContentNegotiation) { json(JsonFormat) }
    installErrors()

    // Data kept in memory while the application runs; restarting it (or each test) starts empty
    val authorRepository = InMemoryAuthorRepository()
    val bookRepository = InMemoryBookRepository()
    val authorService = AuthorService(authorRepository)
    val bookService = BookService(bookRepository, authorRepository)

    routing {
        authorRoutes(authorService)
        bookRoutes(bookService)
    }
}
