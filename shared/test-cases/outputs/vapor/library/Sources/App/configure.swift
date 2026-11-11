// Wires the API: errors, storage, services and routes.

import Vapor

/// Builds the API with its settings: the app that the entry point runs and the tests call.
func configure(_ app: Application, settings: Settings) async throws {
    app.routes.defaultMaxBodySize = "1mb"
    // The error format of the API replaces Vapor's
    app.middleware = Middlewares()
    app.middleware.use(ApiErrorMiddleware())

    let authorRepository: any AuthorRepository = InMemoryAuthorRepository()
    let bookRepository: any BookRepository = InMemoryBookRepository()
    let authorService = AuthorService(repository: authorRepository)
    let bookService = BookService(repository: bookRepository, authorRepository: authorRepository)
    try app.register(collection: AuthorController(service: authorService))
    try app.register(collection: BookController(service: bookService))
}
