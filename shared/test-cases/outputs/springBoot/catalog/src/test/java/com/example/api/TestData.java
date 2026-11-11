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

    /** A valid body to create a category, with the items it refers to created first. */
    static String categoryPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"name\":\"name 1\"}" : "{\"name\":\"name 2\"}");
        return body.jsonString();
    }

    /** Creates a category and returns the JSON the API answers. */
    static String createCategory(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createCategory(mvc, headers, 0);
    }

    static String createCategory(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/categories").headers(headers).contentType(MediaType.APPLICATION_JSON).content(categoryPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }

    /** A valid body to create an item, with the items it refers to created first. */
    static String itemPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"name\":\"name 1\",\"price\":0,\"supplierEmail\":\"user1@example.com\",\"categoryId\":null,\"stock\":0}" : "{\"name\":\"name 2\",\"price\":0.5,\"supplierEmail\":\"user2@example.com\",\"categoryId\":null,\"stock\":1}");
        body.set("$['categoryId']", key(createCategory(mvc, headers), "id"));
        return body.jsonString();
    }

    /** Creates an item and returns the JSON the API answers. */
    static String createItem(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createItem(mvc, headers, 0);
    }

    static String createItem(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/items").headers(headers).contentType(MediaType.APPLICATION_JSON).content(itemPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }
}
