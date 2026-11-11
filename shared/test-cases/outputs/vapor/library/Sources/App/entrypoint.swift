// Starts the API on PORT (8080 by default) with the settings of the environment.

import Vapor

@main
enum Entrypoint {
    static func main() async throws {
        var environment = try Environment.detect()
        try LoggingSystem.bootstrap(from: &environment)
        let app = try await Application.make(environment)
        app.http.server.configuration.hostname = "0.0.0.0"
        app.http.server.configuration.port = Environment.get("PORT").flatMap(Int.init) ?? 8080
        do {
            try await configure(app, settings: .fromEnvironment())
            try await app.execute()
        } catch {
            app.logger.report(error: error)
            try? await app.asyncShutdown()
            throw error
        }
        try await app.asyncShutdown()
    }
}
