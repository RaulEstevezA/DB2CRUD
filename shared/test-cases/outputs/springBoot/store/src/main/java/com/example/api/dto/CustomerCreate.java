package com.example.api.dto;

import com.example.api.common.Payload;
import com.example.api.model.Address;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

/** Body of a request that creates or replaces a customer. */
public class CustomerCreate extends Payload {

    @NotNull
    private String name;

    @NotNull
    private String email;

    @NotNull
    private String password;

    private String phone;

    @NotNull
    @Valid
    private Address address;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        mark("email");
        this.email = email;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        mark("password");
        this.password = password;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        mark("phone");
        this.phone = phone;
    }

    public Address getAddress() {
        return address;
    }

    public void setAddress(Address address) {
        mark("address");
        this.address = address;
    }
}
