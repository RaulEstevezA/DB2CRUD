// Tests of the items endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Items API")
struct ItemAPITests {
    @Test("creates an item")
    func createsAnItem() async throws {
        try await withApi { api in
            let payload = try await api.itemPayload()

            let response = try await api.post("/items", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["name"] == response.json["name"])
            #expect(payload["stock"] == response.json["stock"])
        }
    }

    @Test("rejects an item without name")
    func rejectsAnItemWithoutName() async throws {
        try await withApi { api in
            let payload = without(try await api.itemPayload(), "name")

            let response = try await api.post("/items", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("name") })
        }
    }

    @Test("gets an item")
    func getsAnItem() async throws {
        try await withApi { api in
            let created = try await api.createItem()
            let key = created["id"].text

            let response = try await api.get("/items/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing item")
    func answers404ForAMissingItem() async throws {
        try await withApi { api in
            let response = try await api.get("/items/999999", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists items")
    func listsItems() async throws {
        try await withApi { api in
            _ = try await api.createItem()
            _ = try await api.createItem(1)

            let response = try await api.get("/items", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists items by page")
    func listsItemsByPage() async throws {
        try await withApi { api in
            _ = try await api.createItem()
            _ = try await api.createItem(1)

            let response = try await api.get("/items?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/items?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces an item")
    func replacesAnItem() async throws {
        try await withApi { api in
            let created = try await api.createItem()
            let key = created["id"].text
            let payload = try await api.itemPayload(1)

            let response = try await api.put("/items/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["name"] == response.json["name"])
            #expect(payload["stock"] == response.json["stock"])
        }
    }

    @Test("updates part of an item")
    func updatesPartOfAnItem() async throws {
        try await withApi { api in
            let created = try await api.createItem()
            let key = created["id"].text

            let response = try await api.patch("/items/\(key)", parse("{\"name\":\"name 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["name"] == parse("\"name 2\""))
        }
    }

    @Test("rejects null for name")
    func rejectsNullForName() async throws {
        try await withApi { api in
            let created = try await api.createItem()
            let key = created["id"].text

            let response = try await api.patch("/items/\(key)", parse("{\"name\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes an item")
    func deletesAnItem() async throws {
        try await withApi { api in
            let created = try await api.createItem()
            let key = created["id"].text

            let response = try await api.delete("/items/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/items/\(key)", headers()).status == 404)
        }
    }
}
