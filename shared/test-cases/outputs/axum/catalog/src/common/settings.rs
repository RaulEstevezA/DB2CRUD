//! Settings of the API, read from the environment (see .env.example).

/// Settings of the API. The tests build their own.
#[derive(Clone, Debug, Default)]
pub struct Settings {}

impl Settings {
    pub fn from_env() -> Self {
        Self {}
    }
}
