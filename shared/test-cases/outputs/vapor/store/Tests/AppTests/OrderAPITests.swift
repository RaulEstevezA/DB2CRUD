// Tests of the orders endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Orders API")
struct OrderAPITests {
    @Test("creates an order")
    func createsAnOrder() async throws {
        try await withApi { api in
            let payload = try await api.orderPayload()

            let response = try await api.post("/orders", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["status"] == response.json["status"])
            #expect(payload["notes"] == response.json["notes"])
        }
    }

    @Test("rejects an order without lines")
    func rejectsAnOrderWithoutLines() async throws {
        try await withApi { api in
            let payload = without(try await api.orderPayload(), "lines")

            let response = try await api.post("/orders", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("lines") })
        }
    }

    @Test("gets an order")
    func getsAnOrder() async throws {
        try await withApi { api in
            let created = try await api.createOrder()
            let key = created["id"].text

            let response = try await api.get("/orders/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing order")
    func answers404ForAMissingOrder() async throws {
        try await withApi { api in
            let response = try await api.get("/orders/999999", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists orders")
    func listsOrders() async throws {
        try await withApi { api in
            _ = try await api.createOrder()
            _ = try await api.createOrder(1)

            let response = try await api.get("/orders", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists orders by page")
    func listsOrdersByPage() async throws {
        try await withApi { api in
            _ = try await api.createOrder()
            _ = try await api.createOrder(1)

            let response = try await api.get("/orders?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/orders?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces an order")
    func replacesAnOrder() async throws {
        try await withApi { api in
            let created = try await api.createOrder()
            let key = created["id"].text
            let payload = try await api.orderPayload(1)

            let response = try await api.put("/orders/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["status"] == response.json["status"])
            #expect(payload["notes"] == response.json["notes"])
        }
    }

    @Test("updates part of an order")
    func updatesPartOfAnOrder() async throws {
        try await withApi { api in
            let created = try await api.createOrder()
            let key = created["id"].text

            let response = try await api.patch("/orders/\(key)", parse("{\"total\":2}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"].number == 2.0)
        }
    }

    @Test("rejects null for total")
    func rejectsNullForTotal() async throws {
        try await withApi { api in
            let created = try await api.createOrder()
            let key = created["id"].text

            let response = try await api.patch("/orders/\(key)", parse("{\"total\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes an order")
    func deletesAnOrder() async throws {
        try await withApi { api in
            let created = try await api.createOrder()
            let key = created["id"].text

            let response = try await api.delete("/orders/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/orders/\(key)", headers()).status == 404)
        }
    }
}
