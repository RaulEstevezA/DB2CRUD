package com.example.api.dto;

import java.util.List;

import com.example.api.common.Payload;
import com.example.api.model.OrderLine;
import com.example.api.model.OrderStatus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

/** Body of a request that creates or replaces an order. */
public class OrderCreate extends Payload {

    @NotNull
    private Long customerId;

    @NotNull
    @Valid
    private List<OrderLine> lines;

    @NotNull
    private OrderStatus status;

    @NotNull
    private Double total;

    private String notes;

    public Long getCustomerId() {
        return customerId;
    }

    public void setCustomerId(Long customerId) {
        mark("customerId");
        this.customerId = customerId;
    }

    public List<OrderLine> getLines() {
        return lines;
    }

    public void setLines(List<OrderLine> lines) {
        mark("lines");
        this.lines = lines;
    }

    public OrderStatus getStatus() {
        return status;
    }

    public void setStatus(OrderStatus status) {
        mark("status");
        this.status = status;
    }

    public Double getTotal() {
        return total;
    }

    public void setTotal(Double total) {
        mark("total");
        this.total = total;
    }

    public String getNotes() {
        return notes;
    }

    public void setNotes(String notes) {
        mark("notes");
        this.notes = notes;
    }
}
