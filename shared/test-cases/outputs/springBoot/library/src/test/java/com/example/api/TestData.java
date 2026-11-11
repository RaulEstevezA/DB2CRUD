package com.example.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/** Credentials, builders of valid request bodies, and helpers that create items through the API. */
final class TestData {

    /** Keys for items whose key the client chooses: new for every item, as tests share the application. */
    private static final AtomicLong NEXT_KEY = new AtomicLong(1000);

    private TestData() {
    }

    /** Headers of a client allowed to call every endpoint. */
    static HttpHeaders headers() throws Exception {
        HttpHeaders headers = new HttpHeaders();
        return headers;
    }

    /** The value of a field of a JSON answer. */
    static Object key(String json, String field) {
        return JsonPath.read(json, "$['" + field + "']");
    }

    /** A valid body to create an author, with the items it refers to created first. */
    static String authorPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"name\":\"name 1\",\"email\":\"user1@example.com\",\"born\":\"2024-01-15\"}" : "{\"name\":\"name 2\",\"email\":\"user2@example.com\",\"born\":\"2024-01-16\"}");
        return body.jsonString();
    }

    /** Creates an author and returns the JSON the API answers. */
    static String createAuthor(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createAuthor(mvc, headers, 0);
    }

    static String createAuthor(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/authors").headers(headers).contentType(MediaType.APPLICATION_JSON).content(authorPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }

    /** A valid body to create a book, with the items it refers to created first. */
    static String bookPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"title\":\"title 1\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"novel\",\"pages\":1,\"published\":\"2024-01-15\",\"available\":true}" : "{\"title\":\"title 2\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"essay\",\"pages\":2,\"published\":\"2024-01-16\",\"available\":false}");
        body.set("$['authorId']", key(createAuthor(mvc, headers), "id"));
        return body.jsonString();
    }

    /** Creates a book and returns the JSON the API answers. */
    static String createBook(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createBook(mvc, headers, 0);
    }

    static String createBook(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/books").headers(headers).contentType(MediaType.APPLICATION_JSON).content(bookPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }
}
