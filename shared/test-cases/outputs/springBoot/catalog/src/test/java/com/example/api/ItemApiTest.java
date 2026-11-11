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

/** Tests of the items endpoints. */
@SpringBootTest(classes = CatalogApiApplication.class)
class ItemApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createItem() throws Exception {
        String payload = TestData.itemPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/items").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['name']").value(JsonPath.<Object>read(payload, "$['name']")))
                .andExpect(jsonPath("$['stock']").value(JsonPath.<Object>read(payload, "$['stock']")))
                ;
    }

    @Test
    void rejectItemWithoutName() throws Exception {
        String payload = JsonPath.parse(TestData.itemPayload(mvc, TestData.headers(), 0)).delete("$['name']").jsonString();
        mvc.perform(post("/items").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getItem() throws Exception {
        String created = TestData.createItem(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/items/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingItem() throws Exception {
        mvc.perform(get("/items/999999").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listItems() throws Exception {
        TestData.createItem(mvc, TestData.headers());
        mvc.perform(get("/items").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listItemsByPage() throws Exception {
        TestData.createItem(mvc, TestData.headers(), 0);
        TestData.createItem(mvc, TestData.headers(), 1);
        mvc.perform(get("/items").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListItems() throws Exception {
        mvc.perform(get("/items").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceItem() throws Exception {
        String created = TestData.createItem(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.itemPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/items/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateItem() throws Exception {
        String created = TestData.createItem(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/items/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"name 2\"}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['name']").value("name 2"));
    }

    @Test
    void rejectNullForNameInItem() throws Exception {
        String created = TestData.createItem(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/items/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteItem() throws Exception {
        String created = TestData.createItem(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/items/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/items/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
