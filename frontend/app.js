const form = document.getElementById("stockForm");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const data = Object.fromEntries(formData);

  try {
    const response = await fetch("/api/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to save product");
    }

    alert("Product saved successfully!");
    form.reset();

    await loadProducts();

  } catch (error) {
    console.error(error);
    alert(error.message || "Could not save product. Check the backend.");
  }
});


const saleForm = document.getElementById("saleForm");

saleForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(saleForm);
  const data = Object.fromEntries(formData);

  data.product_id = Number(data.product_id);
  data.quantity = Number(data.quantity);

  try {
    const response = await fetch("/api/sales", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to record sale");
    }

    alert("Sale recorded successfully!");
    saleForm.reset();

    await loadProducts();

  } catch (error) {
    console.error(error);
    alert(error.message || "Could not record sale. Check the backend.");
  }
});


const saleProduct = document.getElementById("saleProduct");

async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    const products = await response.json();

    if (!response.ok) {
      throw new Error("Failed to load products");
    }

    saleProduct.innerHTML = "";
    saleProduct.add(new Option("Select a product", ""));

    if (products.length === 0) {
      saleProduct.add(new Option("No products available", ""));
      return;
    }

    products.forEach((product) => {
      const option = new Option(
        product.product_name,
        product.id
      );

      saleProduct.add(option);
    });

  } catch (error) {
    console.error("Error loading products:", error);

    saleProduct.innerHTML =
      '<option value="">Failed to load products</option>';
  }
}

loadProducts();


async function loadInventorySummary() {
  try {
    const response = await fetch("/api/stock-summary");

    if (!response.ok) {
      throw new Error("Could not load summary");
    }

    const data = await response.json();

    document.getElementById("totalAdded").textContent =
      data.total_added;

    document.getElementById("totalSold").textContent =
      data.total_sold;

    document.getElementById("remaining").textContent =
      data.remaining;
  } catch (error) {
    console.error("Summary error:", error);
  }
}

async function loadStockDetails() {
  const tbody = document.getElementById("stockRows");

  try {
    const response = await fetch("/api/stock-details");

    if (!response.ok) {
      throw new Error("Could not load stock details");
    }

    const products = await response.json();
    tbody.replaceChildren();

    if (products.length === 0) {
      const row = tbody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 4;
      cell.textContent = "No products added yet.";
      return;
    }

    products.forEach((product) => {
      const row = tbody.insertRow();

      row.insertCell().textContent = product.product_name;
      row.insertCell().textContent = product.total;
      row.insertCell().textContent = product.sold;
      row.insertCell().textContent = product.left;
    });
  } catch (error) {
    console.error("Stock details error:", error);

    tbody.replaceChildren();

    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.textContent = "Unable to load inventory.";
  }
}

async function loadInventory() {
  await Promise.all([
    loadInventorySummary(),
    loadStockDetails()
  ]);
}

document.addEventListener("DOMContentLoaded", loadInventory);
setInterval(loadInventory, 10000);


const refreshBtn = document.getElementById("refreshBtn");

if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    if (
      !confirm(
        "This will permanently delete all products and sales. Continue?"
      )
    ) {
      return;
    }

    refreshBtn.disabled = true;
    refreshBtn.textContent = "Clearing...";

    try {
      const response = await fetch("/api/inventory", {
        method: "DELETE"
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not clear inventory");
      }

      await Promise.all([
        loadInventorySummary(),
        loadStockDetails()
      ]);

      alert("All inventory data cleared successfully.");
    } catch (err) {
      console.error("Clear inventory error:", err);
      alert(err.message);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh data";
    }
  });
}