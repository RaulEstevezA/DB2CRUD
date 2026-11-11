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

/** Tests of the products endpoints. */
@SpringBootTest(classes = ShopApiApplication.class)
class ProductApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createProduct() throws Exception {
        String payload = TestData.productPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/products").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['sku']").value(JsonPath.<Object>read(payload, "$['sku']")))
                .andExpect(jsonPath("$['name']").value(JsonPath.<Object>read(payload, "$['name']")))
                .andExpect(jsonPath("$['description']").value(JsonPath.<Object>read(payload, "$['description']")))
                .andExpect(jsonPath("$['active']").value(JsonPath.<Object>read(payload, "$['active']")))
                ;
    }

    @Test
    void rejectProductWithoutSku() throws Exception {
        String payload = JsonPath.parse(TestData.productPayload(mvc, TestData.headers(), 0)).delete("$['sku']").jsonString();
        mvc.perform(post("/products").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getProduct() throws Exception {
        String created = TestData.createProduct(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/products/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingProduct() throws Exception {
        mvc.perform(get("/products/999999").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listProducts() throws Exception {
        TestData.createProduct(mvc, TestData.headers());
        mvc.perform(get("/products").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listProductsByPage() throws Exception {
        TestData.createProduct(mvc, TestData.headers(), 0);
        TestData.createProduct(mvc, TestData.headers(), 1);
        mvc.perform(get("/products").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListProducts() throws Exception {
        mvc.perform(get("/products").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceProduct() throws Exception {
        String created = TestData.createProduct(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.productPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/products/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateProduct() throws Exception {
        String created = TestData.createProduct(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/products/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"sku\":\"sku 2\"}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['sku']").value("sku 2"));
    }

    @Test
    void rejectNullForSkuInProduct() throws Exception {
        String created = TestData.createProduct(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/products/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"sku\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteProduct() throws Exception {
        String created = TestData.createProduct(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/products/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/products/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
