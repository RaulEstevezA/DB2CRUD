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

    /** A valid body to create a customer, with the items it refers to created first. */
    static String customerPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"name\":\"name 1\",\"email\":\"email 1\",\"password\":\"password 1\",\"phone\":\"phone 1\",\"address\":{\"street\":\"street 1\",\"city\":\"city 1\",\"postalCode\":\"postalCode 1\",\"country\":\"country 1\"}}" : "{\"name\":\"name 2\",\"email\":\"email 2\",\"password\":\"password 2\",\"phone\":\"phone 2\",\"address\":{\"street\":\"street 2\",\"city\":\"city 2\",\"postalCode\":\"postalCode 2\",\"country\":\"country 2\"}}");
        return body.jsonString();
    }

    /** Creates a customer and returns the JSON the API answers. */
    static String createCustomer(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createCustomer(mvc, headers, 0);
    }

    static String createCustomer(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/customers").headers(headers).contentType(MediaType.APPLICATION_JSON).content(customerPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }

    /** A valid body to create a product, with the items it refers to created first. */
    static String productPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"sku\":\"sku 1\",\"name\":\"name 1\",\"description\":\"description 1\",\"price\":1.5,\"stock\":1.5,\"active\":true}" : "{\"sku\":\"sku 2\",\"name\":\"name 2\",\"description\":\"description 2\",\"price\":2,\"stock\":2,\"active\":false}");
        return body.jsonString();
    }

    /** Creates a product and returns the JSON the API answers. */
    static String createProduct(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createProduct(mvc, headers, 0);
    }

    static String createProduct(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/products").headers(headers).contentType(MediaType.APPLICATION_JSON).content(productPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }

    /** A valid body to create an order, with the items it refers to created first. */
    static String orderPayload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        DocumentContext body = JsonPath.parse(variant == 0 ? "{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":1.5,\"unitPrice\":1.5}],\"status\":\"pending\",\"total\":1.5,\"notes\":\"notes 1\"}" : "{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":2,\"unitPrice\":2}],\"status\":\"paid\",\"total\":2,\"notes\":\"notes 2\"}");
        body.set("$['customerId']", key(createCustomer(mvc, headers), "id"));
        body.set("$['lines'][0]['productId']", key(createProduct(mvc, headers), "id"));
        return body.jsonString();
    }

    /** Creates an order and returns the JSON the API answers. */
    static String createOrder(MockMvc mvc, HttpHeaders headers) throws Exception {
        return createOrder(mvc, headers, 0);
    }

    static String createOrder(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {
        return mvc.perform(post("/orders").headers(headers).contentType(MediaType.APPLICATION_JSON).content(orderPayload(mvc, headers, variant)))
                .andExpect(status().is(201))
                .andReturn().getResponse().getContentAsString();
    }
}
