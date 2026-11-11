// Tests of the categories endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Categories API")
struct CategoryAPITests {
    @Test("creates a category")
    func createsACategory() async throws {
        try await withApi { api in
            let payload = try await api.categoryPayload()

            let response = try await api.post("/categories", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["name"] == response.json["name"])
        }
    }

    @Test("rejects a category without name")
    func rejectsACategoryWithoutName() async throws {
        try await withApi { api in
            let payload = without(try await api.categoryPayload(), "name")

            let response = try await api.post("/categories", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("name") })
        }
    }

    @Test("gets a category")
    func getsACategory() async throws {
        try await withApi { api in
            let created = try await api.createCategory()
            let key = created["id"].text

            let response = try await api.get("/categories/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing category")
    func answers404ForAMissingCategory() async throws {
        try await withApi { api in
            let response = try await api.get("/categories/999999", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists categories")
    func listsCategories() async throws {
        try await withApi { api in
            _ = try await api.createCategory()
            _ = try await api.createCategory(1)

            let response = try await api.get("/categories", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists categories by page")
    func listsCategoriesByPage() async throws {
        try await withApi { api in
            _ = try await api.createCategory()
            _ = try await api.createCategory(1)

            let response = try await api.get("/categories?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/categories?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces a category")
    func replacesACategory() async throws {
        try await withApi { api in
            let created = try await api.createCategory()
            let key = created["id"].text
            let payload = try await api.categoryPayload(1)

            let response = try await api.put("/categories/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["name"] == response.json["name"])
        }
    }

    @Test("updates part of a category")
    func updatesPartOfACategory() async throws {
        try await withApi { api in
            let created = try await api.createCategory()
            let key = created["id"].text

            let response = try await api.patch("/categories/\(key)", parse("{\"name\":\"name 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["name"] == parse("\"name 2\""))
        }
    }

    @Test("rejects null for name")
    func rejectsNullForName() async throws {
        try await withApi { api in
            let created = try await api.createCategory()
            let key = created["id"].text

            let response = try await api.patch("/categories/\(key)", parse("{\"name\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes a category")
    func deletesACategory() async throws {
        try await withApi { api in
            let created = try await api.createCategory()
            let key = created["id"].text

            let response = try await api.delete("/categories/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/categories/\(key)", headers()).status == 404)
        }
    }
}
