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

/** Tests of the books endpoints. */
@SpringBootTest(classes = LibraryApiApplication.class)
class BookApiTest {

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @Test
    void createBook() throws Exception {
        String payload = TestData.bookPayload(mvc, TestData.headers(), 0);
        mvc.perform(post("/books").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(201))
                .andExpect(jsonPath("$['id']").exists())
                .andExpect(jsonPath("$['title']").value(JsonPath.<Object>read(payload, "$['title']")))
                .andExpect(jsonPath("$['isbn']").value(JsonPath.<Object>read(payload, "$['isbn']")))
                .andExpect(jsonPath("$['genre']").value(JsonPath.<Object>read(payload, "$['genre']")))
                .andExpect(jsonPath("$['pages']").value(JsonPath.<Object>read(payload, "$['pages']")))
                .andExpect(jsonPath("$['available']").value(JsonPath.<Object>read(payload, "$['available']")))
                ;
    }

    @Test
    void rejectBookWithoutTitle() throws Exception {
        String payload = JsonPath.parse(TestData.bookPayload(mvc, TestData.headers(), 0)).delete("$['title']").jsonString();
        mvc.perform(post("/books").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(400))
                .andExpect(jsonPath("$.error.code").value("validation_error"));
    }

    @Test
    void getBook() throws Exception {
        String created = TestData.createBook(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(get("/books/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(content().json(created));
    }

    @Test
    void answerNotFoundForAMissingBook() throws Exception {
        mvc.perform(get("/books/00000000-0000-0000-0000-000000000000").headers(TestData.headers()))
                .andExpect(status().is(404))
                .andExpect(jsonPath("$.error.code").value("not_found"));
    }

    @Test
    void listBooks() throws Exception {
        TestData.createBook(mvc, TestData.headers());
        mvc.perform(get("/books").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.page").value(1));
    }

    @Test
    void listBooksByPage() throws Exception {
        TestData.createBook(mvc, TestData.headers(), 0);
        TestData.createBook(mvc, TestData.headers(), 1);
        mvc.perform(get("/books").param("page", "2").param("size", "1").headers(TestData.headers()))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(2));
    }

    @Test
    void rejectAPageThatDoesNotExistInListBooks() throws Exception {
        mvc.perform(get("/books").param("page", "0").headers(TestData.headers()))
                .andExpect(status().is(400));
    }

    @Test
    void replaceBook() throws Exception {
        String created = TestData.createBook(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        String payload = TestData.bookPayload(mvc, TestData.headers(), 1);
        mvc.perform(put("/books/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().is(200));
    }

    @Test
    void updateBook() throws Exception {
        String created = TestData.createBook(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/books/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"title 2\"}"))
                .andExpect(status().is(200))
                .andExpect(jsonPath("$['title']").value("title 2"));
    }

    @Test
    void rejectNullForTitleInBook() throws Exception {
        String created = TestData.createBook(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(patch("/books/" + key + "").headers(TestData.headers()).contentType(MediaType.APPLICATION_JSON).content("{\"title\":null}"))
                .andExpect(status().is(400));
    }

    @Test
    void deleteBook() throws Exception {
        String created = TestData.createBook(mvc, TestData.headers());
        Object key = TestData.key(created, "id");
        mvc.perform(delete("/books/" + key + "").headers(TestData.headers()))
                .andExpect(status().is(204));
        mvc.perform(get("/books/" + key + "").headers(TestData.headers())).andExpect(status().is(404));
    }
}
