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

/** Tests of the authors endpoints. */
@SpringBootTest(classes = LibraryApiApplication.class)
class AuthorApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createAuthor() throws Exception {
        String payload = TestData.authorPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/authors").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['name']").value(JsonPath.<Object>read(payload, "$['name']")))
                ;
    }

    @Test
    void rejectAuthorWithoutName() throws Exception {
        String payload = JsonPath.parse(TestData.authorPayload(mvc, TestData.headers(), 0)).delete("$['name']").jsonString();
        mvc.perform(post("/authors").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getAuthor() throws Exception {
        String created = TestData.createAuthor(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/authors/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingAuthor() throws Exception {
        mvc.perform(get("/authors/00000000-0000-0000-0000-000000000000").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listAuthors() throws Exception {
        TestData.createAuthor(mvc, TestData.headers());
        mvc.perform(get("/authors").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listAuthorsByPage() throws Exception {
        TestData.createAuthor(mvc, TestData.headers(), 0);
        TestData.createAuthor(mvc, TestData.headers(), 1);
        mvc.perform(get("/authors").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListAuthors() throws Exception {
        mvc.perform(get("/authors").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceAuthor() throws Exception {
        String created = TestData.createAuthor(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.authorPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/authors/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateAuthor() throws Exception {
        String created = TestData.createAuthor(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/authors/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"name 2\"}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['name']").value("name 2"));
    }

    @Test
    void rejectNullForNameInAuthor() throws Exception {
        String created = TestData.createAuthor(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/authors/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"name\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteAuthor() throws Exception {
        String created = TestData.createAuthor(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/authors/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/authors/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
