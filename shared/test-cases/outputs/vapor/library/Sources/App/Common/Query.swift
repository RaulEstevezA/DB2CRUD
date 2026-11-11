// Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.

import Foundation
import Vapor

/// A whole number key of the path.
func intKey(_ request: Request, _ name: String) throws -> Int64 {
    guard let value = request.parameters.get(name).flatMap({ Int64($0) }) else {
        throw ApiError.invalid(name, "Must be a whole number")
    }
    return value
}

func uuidKey(_ request: Request, _ name: String) throws -> UUID {
    guard let value = request.parameters.get(name).flatMap(parseUUID) else {
        throw ApiError.invalid(name, "Must be a UUID")
    }
    return value
}

func textKey(_ request: Request, _ name: String) throws -> String {
    guard let value = request.parameters.get(name) else {
        throw ApiError.invalid(name, "Is missing")
    }
    return value
}

/// A whole number of the query string within its limits; the default when it is not there.
func intQuery(_ request: Request, _ name: String, default value: Int, min: Int, max: Int?) throws -> Int {
    guard let text = request.query[String.self, at: name] else { return value }
    guard let number = Int(text), number >= min, max.map({ number <= $0 }) ?? true else {
        throw ApiError.invalid(name, "Must be a whole number within its limits")
    }
    return number
}

/// A filter of the query string read with its type, or nil when it is not there; a malformed one is a 400.
func queryFilter<T>(_ request: Request, _ name: String, _ parse: (String) -> T?) throws -> T? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard let value = parse(text) else {
        throw ApiError.invalid(name, "Has the wrong format")
    }
    return value
}

/// A value of the query string that must be one of the choices.
func choiceQuery(_ request: Request, _ name: String, _ choices: [String]) throws -> String? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard choices.contains(text) else {
        throw ApiError.invalid(name, "Must be one of: \(choices.joined(separator: ", "))")
    }
    return text
}

/// A UUID written as 8-4-4-4-12 hexadecimal digits.
func parseUUID(_ text: String) -> UUID? {
    let canonical = text.count == 36 && text.enumerated().allSatisfy { index, char in
        [8, 13, 18, 23].contains(index) ? char == "-" : char.isHexDigit
    }
    return canonical ? UUID(uuidString: text) : nil
}

/// A date without time: ISO 8601 text, kept as it is.
func parseDate(_ text: String) -> String? {
    text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? text : nil
}

func parseBool(_ text: String) -> Bool? {
    text == "true" ? true : text == "false" ? false : nil
}
