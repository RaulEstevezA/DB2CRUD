// Reading request bodies: a JSON object that meets the rules of its type, checked before it is read.

import Foundation
import Vapor

/// A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).
struct Body<T: Sendable>: Sendable {
    let value: T
    let sent: Set<String>

    func has(_ field: String) -> Bool {
        sent.contains(field)
    }
}

/// The kinds of JSON value a field can hold.
enum JsonKind: String {
    case text
    case whole = "whole number"
    case number
    case boolean
    case list
    case object
}

/// The rules of a body or an embedded object, run on its JSON.
typealias Rules = (inout Checks, [String: JSONValue]) -> Void

/// The problems of a request body, by field. Embedded objects add their path: address.street.
struct Checks {
    private(set) var problems: [ErrorDetail] = []
    private var prefix = ""

    mutating func fail(_ field: String, _ message: String) {
        problems.append(ErrorDetail(field: prefix + field, message: message))
    }

    /// Every field is one the contract describes.
    mutating func only(_ json: [String: JSONValue], _ fields: Set<String>) {
        for field in json.keys.sorted() where !fields.contains(field) {
            fail(field, "The field is not part of the contract")
        }
    }

    mutating func required(_ json: [String: JSONValue], _ field: String) {
        if json[field] == nil {
            fail(field, "The field is required")
        }
    }

    mutating func notNull(_ json: [String: JSONValue], _ field: String) {
        if json[field] == .null {
            fail(field, "The field must not be null")
        }
    }

    /// The value has the kind of the field; null is left to notNull.
    mutating func kind(_ json: [String: JSONValue], _ field: String, _ kind: JsonKind) {
        guard let value = json[field], value != .null else { return }
        let valid: Bool
        switch (kind, value) {
        case (.text, .string), (.number, .number), (.boolean, .bool), (.list, .array), (.object, .object):
            valid = true
        case (.whole, .number(let number)):
            valid = number.rounded() == number
        default:
            valid = false
        }
        if !valid {
            fail(field, "Must be \(kind.rawValue)")
        }
    }

    mutating func length(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .string(let text)? = json[field] else { return }
        // Counted as JavaScript counts: in UTF-16 units
        let length = text.utf16.count
        if min.map({ length < $0 }) ?? false || max.map({ length > $0 }) ?? false {
            fail(field, "Has a length out of its limits")
        }
    }

    mutating func count(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .array(let list)? = json[field] else { return }
        if min.map({ list.count < $0 }) ?? false || max.map({ list.count > $0 }) ?? false {
            fail(field, "Has a number of items out of its limits")
        }
    }

    mutating func range(_ json: [String: JSONValue], _ field: String, min: Double?, max: Double?, minExclusive: Bool, maxExclusive: Bool) {
        guard case .number(let number)? = json[field] else { return }
        let below = min.map { number < $0 || (minExclusive && number == $0) } ?? false
        let above = max.map { number > $0 || (maxExclusive && number == $0) } ?? false
        if below || above {
            fail(field, "Is out of its range")
        }
    }

    /// The text matches the expression somewhere, as "pattern" reads it in openapi.yaml.
    mutating func pattern(_ json: [String: JSONValue], _ field: String, _ pattern: String) {
        // An expression this engine cannot read checks nothing, rather than reject every value
        guard case .string(let text)? = json[field], let regex = try? NSRegularExpression(pattern: pattern) else { return }
        if regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil {
            fail(field, "Has the wrong format")
        }
    }

    mutating func email(_ json: [String: JSONValue], _ field: String) {
        guard case .string(let text)? = json[field] else { return }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        let valid = parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty && !text.contains(where: \.isWhitespace)
        if !valid {
            fail(field, "Must be an email address")
        }
    }

    /// The rules of an embedded object, with its path before each field.
    mutating func nested(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        if case .object(let inner)? = json[field] {
            run(prefix + field + ".", inner, rules)
        }
    }

    /// The rules of each embedded object of a list.
    mutating func each(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        guard case .array(let list)? = json[field] else { return }
        for (index, item) in list.enumerated() {
            if case .object(let inner) = item {
                run(prefix + field + "[\(index)].", inner, rules)
            }
        }
    }

    private mutating func run(_ prefix: String, _ json: [String: JSONValue], _ rules: Rules) {
        var inner = Checks()
        inner.prefix = prefix
        rules(&inner, json)
        problems.append(contentsOf: inner.problems)
    }
}

/// Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the
/// contract does not describe.
func readBody<T: Decodable & Sendable>(_ request: Request, as type: T.Type, rules: Rules) throws -> Body<T> {
    let data = request.body.data.map { Data(buffer: $0) } ?? Data()
    guard let json = try? JSONCoding.decoder().decode(JSONValue.self, from: data) else {
        throw ApiError.invalid("", "The body is not valid JSON")
    }
    guard case .object(let object) = json else {
        throw ApiError.invalid("", "The body must be a JSON object")
    }
    var checks = Checks()
    rules(&checks, object)
    if !checks.problems.isEmpty {
        throw ApiError.invalidBody(checks.problems)
    }
    guard let value = try? JSONCoding.decoder().decode(type, from: data) else {
        throw ApiError.invalid("", "The body does not match its type")
    }
    return Body(value: value, sent: Set(object.keys))
}
