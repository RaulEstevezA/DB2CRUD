// Tests of the customers endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Customers API")
struct CustomerAPITests {
    @Test("creates a customer")
    func createsACustomer() async throws {
        try await withApi { api in
            let payload = try await api.customerPayload()

            let response = try await api.post("/customers", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["name"] == response.json["name"])
            #expect(payload["email"] == response.json["email"])
            #expect(payload["phone"] == response.json["phone"])
        }
    }

    @Test("rejects a customer without name")
    func rejectsACustomerWithoutName() async throws {
        try await withApi { api in
            let payload = without(try await api.customerPayload(), "name")

            let response = try await api.post("/customers", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("name") })
        }
    }

    @Test("gets a customer")
    func getsACustomer() async throws {
        try await withApi { api in
            let created = try await api.createCustomer()
            let key = created["id"].text

            let response = try await api.get("/customers/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing customer")
    func answers404ForAMissingCustomer() async throws {
        try await withApi { api in
            let response = try await api.get("/customers/999999", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists customers")
    func listsCustomers() async throws {
        try await withApi { api in
            _ = try await api.createCustomer()
            _ = try await api.createCustomer(1)

            let response = try await api.get("/customers", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists customers by page")
    func listsCustomersByPage() async throws {
        try await withApi { api in
            _ = try await api.createCustomer()
            _ = try await api.createCustomer(1)

            let response = try await api.get("/customers?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/customers?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces a customer")
    func replacesACustomer() async throws {
        try await withApi { api in
            let created = try await api.createCustomer()
            let key = created["id"].text
            let payload = try await api.customerPayload(1)

            let response = try await api.put("/customers/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["name"] == response.json["name"])
            #expect(payload["email"] == response.json["email"])
            #expect(payload["phone"] == response.json["phone"])
        }
    }

    @Test("updates part of a customer")
    func updatesPartOfACustomer() async throws {
        try await withApi { api in
            let created = try await api.createCustomer()
            let key = created["id"].text

            let response = try await api.patch("/customers/\(key)", parse("{\"name\":\"name 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["name"] == parse("\"name 2\""))
        }
    }

    @Test("rejects null for name")
    func rejectsNullForName() async throws {
        try await withApi { api in
            let created = try await api.createCustomer()
            let key = created["id"].text

            let response = try await api.patch("/customers/\(key)", parse("{\"name\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes a customer")
    func deletesACustomer() async throws {
        try await withApi { api in
            let created = try await api.createCustomer()
            let key = created["id"].text

            let response = try await api.delete("/customers/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/customers/\(key)", headers()).status == 404)
        }
    }
}
