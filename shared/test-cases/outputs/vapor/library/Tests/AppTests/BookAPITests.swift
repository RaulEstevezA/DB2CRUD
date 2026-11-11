// Tests of the books endpoints.

@testable import App
import Testing
import VaporTesting

@Suite("Books API")
struct BookAPITests {
    @Test("creates a book")
    func createsABook() async throws {
        try await withApi { api in
            let payload = try await api.bookPayload()

            let response = try await api.post("/books", payload, headers())

            #expect(response.status == 201, "\(response.text)")
            #expect(response.json.has("id"))
            #expect(payload["title"] == response.json["title"])
            #expect(payload["isbn"] == response.json["isbn"])
            #expect(payload["genre"] == response.json["genre"])
            #expect(payload["pages"] == response.json["pages"])
            #expect(payload["available"] == response.json["available"])
        }
    }

    @Test("rejects a book without title")
    func rejectsABookWithoutTitle() async throws {
        try await withApi { api in
            let payload = without(try await api.bookPayload(), "title")

            let response = try await api.post("/books", payload, headers())

            #expect(response.status == 400, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("validation_error"))
            guard case .array(let details) = response.json["error"]["details"] else {
                Issue.record("The error has no details")
                return
            }
            #expect(details.contains { $0["field"] == .string("title") })
        }
    }

    @Test("gets a book")
    func getsABook() async throws {
        try await withApi { api in
            let created = try await api.createBook()
            let key = created["id"].text

            let response = try await api.get("/books/\(key)", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(created == response.json)
        }
    }

    @Test("answers 404 for a missing book")
    func answers404ForAMissingBook() async throws {
        try await withApi { api in
            let response = try await api.get("/books/00000000-0000-0000-0000-000000000000", headers())

            #expect(response.status == 404, "\(response.text)")
            #expect(response.json["error"]["code"] == .string("not_found"))
        }
    }

    @Test("lists books")
    func listsBooks() async throws {
        try await withApi { api in
            _ = try await api.createBook()
            _ = try await api.createBook(1)

            let response = try await api.get("/books", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["page"] == .number(1))
        }
    }

    @Test("lists books by page")
    func listsBooksByPage() async throws {
        try await withApi { api in
            _ = try await api.createBook()
            _ = try await api.createBook(1)

            let response = try await api.get("/books?page=2&size=1", headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["total"] == .number(2))
            #expect(response.json["items"].count == 1)
            #expect(response.json["page"] == .number(2))
        }
    }

    @Test("rejects a page that does not exist")
    func rejectsAPageThatDoesNotExist() async throws {
        try await withApi { api in
            let response = try await api.get("/books?page=0", headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("replaces a book")
    func replacesABook() async throws {
        try await withApi { api in
            let created = try await api.createBook()
            let key = created["id"].text
            let payload = try await api.bookPayload(1)

            let response = try await api.put("/books/\(key)", payload, headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(payload["title"] == response.json["title"])
            #expect(payload["isbn"] == response.json["isbn"])
            #expect(payload["genre"] == response.json["genre"])
            #expect(payload["pages"] == response.json["pages"])
            #expect(payload["available"] == response.json["available"])
        }
    }

    @Test("updates part of a book")
    func updatesPartOfABook() async throws {
        try await withApi { api in
            let created = try await api.createBook()
            let key = created["id"].text

            let response = try await api.patch("/books/\(key)", parse("{\"title\":\"title 2\"}"), headers())

            #expect(response.status == 200, "\(response.text)")
            #expect(response.json["title"] == parse("\"title 2\""))
        }
    }

    @Test("rejects null for title")
    func rejectsNullForTitle() async throws {
        try await withApi { api in
            let created = try await api.createBook()
            let key = created["id"].text

            let response = try await api.patch("/books/\(key)", parse("{\"title\":null}"), headers())

            #expect(response.status == 400, "\(response.text)")
        }
    }

    @Test("deletes a book")
    func deletesABook() async throws {
        try await withApi { api in
            let created = try await api.createBook()
            let key = created["id"].text

            let response = try await api.delete("/books/\(key)", headers())

            #expect(response.status == 204, "\(response.text)")
            #expect(try await api.get("/books/\(key)", headers()).status == 404)
        }
    }
}
