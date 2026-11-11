package com.example.api.common

/** Settings of the API, read from the environment (see .env.example). The tests build their own. */
class Settings {
    companion object {
        fun fromEnvironment() = Settings()
    }
}
