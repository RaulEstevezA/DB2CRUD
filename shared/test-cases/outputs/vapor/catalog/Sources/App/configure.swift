// Wires the API: errors, storage, services and routes.

import Vapor

/// Builds the API with its settings: the app that the entry point runs and the tests call.
func configure(_ app: Application, settings: Settings) async throws {
    app.routes.defaultMaxBodySize = "1mb"
    // The error format of the API replaces Vapor's
    app.middleware = Middlewares()
    app.middleware.use(ApiErrorMiddleware())

    let categoryRepository: any CategoryRepository = InMemoryCategoryRepository()
    let itemRepository: any ItemRepository = InMemoryItemRepository()
    let categoryService = CategoryService(repository: categoryRepository)
    let itemService = ItemService(repository: itemRepository, categoryRepository: categoryRepository)
    try app.register(collection: CategoryController(service: categoryService))
    try app.register(collection: ItemController(service: itemService))
}
