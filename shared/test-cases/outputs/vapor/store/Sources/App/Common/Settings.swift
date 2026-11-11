// Settings of the API, read from the environment (see .env.example).

/// Settings of the API. The tests build their own.
struct Settings: Sendable {
    static func fromEnvironment() -> Settings {
        Settings()
    }
}
