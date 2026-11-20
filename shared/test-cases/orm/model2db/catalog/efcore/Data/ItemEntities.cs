// Entities written by Model2DB from Item. Review them before using them.
using System;
using System.Collections.Generic;

namespace Example.Data;

public class Category
{
    public long Id { get; set; }
    public string Name { get; set; } = null!;
    public long ParentId { get; set; }
    public Category Parent { get; set; } = null!;
}

public class Item
{
    public long Id { get; set; }
    public string Name { get; set; } = null!;
    public decimal Price { get; set; }
    public string SupplierEmail { get; set; } = null!;
    public int Stock { get; set; }
    public long CategoryId { get; set; }
    public Category Category { get; set; } = null!;
}
