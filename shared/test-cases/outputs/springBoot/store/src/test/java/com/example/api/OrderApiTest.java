package com.example.api;

import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/** Tests of the orders endpoints. */
@SpringBootTest(classes = ShopApiApplication.class)
class OrderApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createOrder() throws Exception {
        String payload = TestData.orderPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/orders").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['status']").value(JsonPath.<Object>read(payload, "$['status']")))
                .andExpect(jsonPath("$['notes']").value(JsonPath.<Object>read(payload, "$['notes']")))
                ;
    }

    @Test
    void rejectOrderWithoutLines() throws Exception {
        String payload = JsonPath.parse(TestData.orderPayload(mvc, TestData.headers(), 0)).delete("$['lines']").jsonString();
        mvc.perform(post("/orders").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getOrder() throws Exception {
        String created = TestData.createOrder(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/orders/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingOrder() throws Exception {
        mvc.perform(get("/orders/999999").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listOrders() throws Exception {
        TestData.createOrder(mvc, TestData.headers());
        mvc.perform(get("/orders").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listOrdersByPage() throws Exception {
        TestData.createOrder(mvc, TestData.headers(), 0);
        TestData.createOrder(mvc, TestData.headers(), 1);
        mvc.perform(get("/orders").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListOrders() throws Exception {
        mvc.perform(get("/orders").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceOrder() throws Exception {
        String created = TestData.createOrder(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.orderPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/orders/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateOrder() throws Exception {
        String created = TestData.createOrder(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/orders/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"total\":2}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['total']").value(2));
    }

    @Test
    void rejectNullForTotalInOrder() throws Exception {
        String created = TestData.createOrder(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/orders/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"total\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteOrder() throws Exception {
        String created = TestData.createOrder(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/orders/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/orders/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
