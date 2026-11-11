// Wires the API: errors, storage, services and routes.

import Vapor

/// Builds the API with its settings: the app that the entry point runs and the tests call.
func configure(_ app: Application, settings: Settings) async throws {
    app.routes.defaultMaxBodySize = "1mb"
    // The error format of the API replaces Vapor's
    app.middleware = Middlewares()
    app.middleware.use(ApiErrorMiddleware())

    let customerRepository: any CustomerRepository = InMemoryCustomerRepository()
    let productRepository: any ProductRepository = InMemoryProductRepository()
    let orderRepository: any OrderRepository = InMemoryOrderRepository()
    let customerService = CustomerService(repository: customerRepository)
    let productService = ProductService(repository: productRepository)
    let orderService = OrderService(repository: orderRepository, customerRepository: customerRepository, productRepository: productRepository)
    try app.register(collection: CustomerController(service: customerService))
    try app.register(collection: ProductController(service: productService))
    try app.register(collection: OrderController(service: orderService))
}
