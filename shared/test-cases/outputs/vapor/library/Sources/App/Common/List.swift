// What a list asks a repository for, and what it gets back.

/// A list: the filters of its resource, an order by a JSON field name and a window.
struct ListQuery<F: Sendable>: Sendable {
    let filters: F
    let sortField: String?
    let descending: Bool
    let offset: Int
    let limit: Int?

    /// "-createdAt" sorts by createdAt in descending order.
    init(filters: F, sort: String?, offset: Int, limit: Int?) {
        self.filters = filters
        descending = sort?.hasPrefix("-") ?? false
        sortField = sort.map { $0.hasPrefix("-") ? String($0.dropFirst()) : $0 }
        self.offset = offset
        self.limit = limit
    }
}

/// A window of items and how many match, whatever the window.
struct ListResult<T: Sendable>: Sendable {
    let items: [T]
    let total: Int
}

/// One page of a list, as the API returns it.
struct PageResponse<T: Encodable & Sendable>: Encodable, Sendable {
    let items: [T]
    let total: Int
    let page: Int
    let size: Int
}

/// Whether a value of a field goes before another: the ones without a value go last, whatever the order. Nil when
/// they are equal.
func comesFirst<T: Comparable>(_ a: T?, _ b: T?, descending: Bool) -> Bool? {
    switch (a, b) {
    case let (a?, b?):
        if a == b { return nil }
        return descending ? a > b : a < b
    case (.some, .none):
        return true
    case (.none, .some):
        return false
    case (.none, .none):
        return nil
    }
}
