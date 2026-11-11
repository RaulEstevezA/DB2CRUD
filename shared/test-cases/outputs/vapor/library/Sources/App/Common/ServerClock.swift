// The time the server writes, in UTC.

import Foundation

/// The time the server writes, in UTC.
enum ServerClock {
    /// Now, to the millisecond: what the API writes, so a later read gives the same value.
    static func now() -> Date {
        Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded(.down) / 1000)
    }

    /// Today as ISO 8601 text.
    static func today() -> String {
        Date().formatted(Date.ISO8601FormatStyle().year().month().day())
    }

    /// Now as ISO 8601 text, for a text field the server fills.
    static func text() -> String {
        formatDateTime(now())
    }
}
