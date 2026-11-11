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

/** Tests of the categories endpoints. */
@SpringBootTest(classes = CatalogApiApplication.class)
class CategoryApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createCategory() throws Exception {
        String payload = TestData.categoryPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/categories").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['name']").value(JsonPath.<Object>read(payload, "$['name']")))
                ;
    }

    @Test
    void rejectCategoryWithoutName() throws Exception {
        String payload = JsonPath.parse(TestData.categoryPayload(mvc, TestData.headers(), 0)).delete("$['name']").jsonString();
        mvc.perform(post("/categories").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getCategory() throws Exception {
        String created = TestData.createCategory(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/categories/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingCategory() throws Exception {
        mvc.perform(get("/categories/999999").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listCategories() throws Exception {
        TestData.createCategory(mvc, TestData.headers());
        mvc.perform(get("/categories").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listCategoriesByPage() throws Exception {
        TestData.createCategory(mvc, TestData.headers(), 0);
        TestData.createCategory(mvc, TestData.headers(), 1);
        mvc.perform(get("/categories").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListCategories() throws Exception {
        mvc.perform(get("/categories").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceCategory() throws Exception {
        String created = TestData.createCategory(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.categoryPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/categories/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateCategory() throws Exception {
        String created = TestData.createCategory(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/categories/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"name 2\"}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['name']").value("name 2"));
    }

    @Test
    void rejectNullForNameInCategory() throws Exception {
        String created = TestData.createCategory(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/categories/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteCategory() throws Exception {
        String created = TestData.createCategory(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/categories/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/categories/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
