import request from "supertest";
import app from "../server.js"; // Import your Express app

describe("Product API Tests", () => {
  const token =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbmdpbmVlcklkIjoiNjc4YzdkOGI2ZjM1MWU2YmY1MjkwN2ZlIiwic3VwZXJ2aXNvcklkIjpudWxsLCJyb2xlIjoiRW5naW5lZXIiLCJpYXQiOjE3Mzc2MDU4NDAsImV4cCI6MTczNzY0OTA0MH0.n-t-XuqGpH54OAzE6QMqiaHTeAEjNEg6xy4Q24EX2t8"; // Replace with a valid token
  const basePath = "/api/products"; // Replace with your actual base path
  const siteId = "678c8f02e48d91e3a85e8880"; // Replace with a valid siteId
  let createdProductId;

  /**
   * Helper function to log responses.
   */
  const logResponse = (endpoint, response) => {
    console.log(`Endpoint: ${endpoint}`);
    console.log(`Status: ${response.status}`);
    console.log(`Body:`, response.body);
  };

  /**
   * Test: Create Product
   */
  test("POST /create - Create Product", async () => {
    const response = await request(app)
      .post(`${basePath}/create?siteId=${siteId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Test Product",
        description: "This is a test product",
        category: "Test Category",
        unit: "Piece",
      });

    logResponse("/create", response);

    expect(response.status).toBe(201);
    expect(response.body.product).toHaveProperty("_id");
    createdProductId = response.body.product._id;
  });

  /**
   * Test: Create Product (Edge Case - Missing Fields)
   */
  test("POST /create - Missing Fields", async () => {
    const response = await request(app)
      .post(`${basePath}/create?siteId=${siteId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        description: "Missing name",
        category: "Test Category",
        unit: "Piece",
      });

    logResponse("/create - Missing Fields", response);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("All fields are required");
  });

  /**
   * Test: Update Product
   */
  //   test("PUT /update/:productId - Update Product", async () => {
  //     const response = await request(app)
  //       .put(`${basePath}/update/${createdProductId}?siteId=${siteId}`)
  //       .set("Authorization", `Bearer ${token}`)
  //       .send({
  //         name: "Updated Test Product",
  //         description: "Updated description",
  //       });

  //     logResponse(`/update/${createdProductId}`, response);

  //     expect(response.status).toBe(200);
  //     expect(response.body.product.name).toBe("Updated Test Product");
  //   });

  /**
   * Test: Update Product (Edge Case - Invalid ID)
   */
  test("PUT /update/:productId - Invalid ID", async () => {
    const response = await request(app)
      .put(`${basePath}/update/invalidId?siteId=${siteId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Updated Test Product",
      });

    logResponse(`/update/invalidId`, response);

    expect(response.status).toBe(500); // Expect server error for invalid ID
  });

  /**
   * Test: Get All Products
   */
  test("GET /getAll - Get All Products", async () => {
    const response = await request(app)
      .get(`${basePath}/getAll?siteId=${siteId}`)
      .set("Authorization", `Bearer ${token}`);

    logResponse("/getAll", response);

    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Array);
  });

  /**
   * Test: Get Product by ID
   */
  test("GET /getById/:productId - Get Product by ID", async () => {
    const response = await request(app)
      .get(`${basePath}/getById/${createdProductId}`)
      .set("Authorization", `Bearer ${token}`);

    logResponse(`/getById/${createdProductId}`, response);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("_id", createdProductId);
  });

  /**
   * Test: Get Product by ID (Edge Case - Invalid ID)
   */
  test("GET /getById/:productId - Invalid ID", async () => {
    const response = await request(app)
      .get(`${basePath}/getById/invalidId`)
      .set("Authorization", `Bearer ${token}`);

    logResponse(`/getById/invalidId`, response);

    expect(response.status).toBe(500); // Expect server error for invalid ID
  });

  /**
   * Test: Upload Products (Excel File)
   */
  test("POST /upload - Upload Products", async () => {
    const response = await request(app)
      .post(`${basePath}/upload?siteId=${siteId}`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", "__tests__/sample.xlsx"); // Replace with your test file path

    logResponse("/upload", response);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Products uploaded successfully");
  });

  /**
   * Test: Delete Product
   */
  test("DELETE /deleteproduct/:productId - Delete Product", async () => {
    const response = await request(app)
      .delete(`${basePath}/deleteproduct/${createdProductId}`)
      .set("Authorization", `Bearer ${token}`);

    logResponse(`/deleteproduct/${createdProductId}`, response);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Product deleted successfully");
  });

  /**
   * Test: Delete Product (Edge Case - Invalid ID)
   */
  test("DELETE /deleteproduct/:productId - Invalid ID", async () => {
    const response = await request(app)
      .delete(`${basePath}/deleteproduct/invalidId`)
      .set("Authorization", `Bearer ${token}`);

    logResponse(`/deleteproduct/invalidId`, response);

    expect(response.status).toBe(500); // Expect server error for invalid ID
  });
});
