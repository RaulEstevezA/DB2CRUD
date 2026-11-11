// Tests of the authors endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Authors API")
struct AuthorAPITests {
    @Test("creates an author")
    func createsAnAuthor() async throws {
        try await withApi { api in
            let payload = try await api.authorPayload()

            let response = try await api.post("/authors", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["name"] == response.json["name"])
        }
    }

    @Test("rejects an author without name")
    func rejectsAnAuthorWithoutName() async throws {
        try await withApi { api in
            let payload = without(try await api.authorPayload(), "name")

            let response = try await api.post("/authors", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("name") })
        }
    }

    @Test("gets an author")
    func getsAnAuthor() async throws {
        try await withApi { api in
            let created = try await api.createAuthor()
            let key = created["id"].text

            let response = try await api.get("/authors/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing author")
    func answers404ForAMissingAuthor() async throws {
        try await withApi { api in
            let response = try await api.get("/authors/00000000-0000-0000-0000-000000000000", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists authors")
    func listsAuthors() async throws {
        try await withApi { api in
            _ = try await api.createAuthor()
            _ = try await api.createAuthor(1)

            let response = try await api.get("/authors", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists authors by page")
    func listsAuthorsByPage() async throws {
        try await withApi { api in
            _ = try await api.createAuthor()
            _ = try await api.createAuthor(1)

            let response = try await api.get("/authors?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/authors?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces an author")
    func replacesAnAuthor() async throws {
        try await withApi { api in
            let created = try await api.createAuthor()
            let key = created["id"].text
            let payload = try await api.authorPayload(1)

            let response = try await api.put("/authors/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["name"] == response.json["name"])
        }
    }

    @Test("updates part of an author")
    func updatesPartOfAnAuthor() async throws {
        try await withApi { api in
            let created = try await api.createAuthor()
            let key = created["id"].text

            let response = try await api.patch("/authors/\(key)", parse("{\"name\":\"name 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["name"] == parse("\"name 2\""))
        }
    }

    @Test("rejects null for name")
    func rejectsNullForName() async throws {
        try await withApi { api in
            let created = try await api.createAuthor()
            let key = created["id"].text

            let response = try await api.patch("/authors/\(key)", parse("{\"name\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes an author")
    func deletesAnAuthor() async throws {
        try await withApi { api in
            let created = try await api.createAuthor()
            let key = created["id"].text

            let response = try await api.delete("/authors/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/authors/\(key)", headers()).status == 404)
        }
    }
}
