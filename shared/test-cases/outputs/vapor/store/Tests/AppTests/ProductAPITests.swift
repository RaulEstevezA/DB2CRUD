// Tests of the products endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Products API")
struct ProductAPITests {
    @Test("creates a product")
    func createsAProduct() async throws {
        try await withApi { api in
            let payload = try await api.productPayload()

            let response = try await api.post("/products", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["sku"] == response.json["sku"])
            #expect(payload["name"] == response.json["name"])
            #expect(payload["description"] == response.json["description"])
            #expect(payload["active"] == response.json["active"])
        }
    }

    @Test("rejects a product without sku")
    func rejectsAProductWithoutSku() async throws {
        try await withApi { api in
            let payload = without(try await api.productPayload(), "sku")

            let response = try await api.post("/products", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("sku") })
        }
    }

    @Test("gets a product")
    func getsAProduct() async throws {
        try await withApi { api in
            let created = try await api.createProduct()
            let key = created["id"].text

            let response = try await api.get("/products/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing product")
    func answers404ForAMissingProduct() async throws {
        try await withApi { api in
            let response = try await api.get("/products/999999", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists products")
    func listsProducts() async throws {
        try await withApi { api in
            _ = try await api.createProduct()
            _ = try await api.createProduct(1)

            let response = try await api.get("/products", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists products by page")
    func listsProductsByPage() async throws {
        try await withApi { api in
            _ = try await api.createProduct()
            _ = try await api.createProduct(1)

            let response = try await api.get("/products?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/products?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces a product")
    func replacesAProduct() async throws {
        try await withApi { api in
            let created = try await api.createProduct()
            let key = created["id"].text
            let payload = try await api.productPayload(1)

            let response = try await api.put("/products/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["sku"] == response.json["sku"])
            #expect(payload["name"] == response.json["name"])
            #expect(payload["description"] == response.json["description"])
            #expect(payload["active"] == response.json["active"])
        }
    }

    @Test("updates part of a product")
    func updatesPartOfAProduct() async throws {
        try await withApi { api in
            let created = try await api.createProduct()
            let key = created["id"].text

            let response = try await api.patch("/products/\(key)", parse("{\"sku\":\"sku 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["sku"] == parse("\"sku 2\""))
        }
    }

    @Test("rejects null for sku")
    func rejectsNullForSku() async throws {
        try await withApi { api in
            let created = try await api.createProduct()
            let key = created["id"].text

            let response = try await api.patch("/products/\(key)", parse("{\"sku\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes a product")
    func deletesAProduct() async throws {
        try await withApi { api in
            let created = try await api.createProduct()
            let key = created["id"].text

            let response = try await api.delete("/products/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/products/\(key)", headers()).status == 404)
        }
    }
}
