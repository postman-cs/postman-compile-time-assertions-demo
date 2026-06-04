// Local upstream mock: pricing service (UPSTREAM_MODE=http variant).
//
// Run either way:
//   postman mock run postman/mocks/pricing-service.json
//   node postman/mocks/pricing-service.js
//
// Binds 0.0.0.0 so a Docker container can reach it through
// host.docker.internal:host-gateway.
const http = require("http");

const PORT = Number(process.env.PORT || 9102);

const PRICING = {
  fiber_1g: { amount: 89.0, currency: "USD" },
  fiber_500m: { amount: 59.0, currency: "USD" },
  mobile_unlimited: { amount: 45.0, currency: "USD" },
};

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const match = /^\/prices\/([^/?]+)/.exec(req.url || "");
  if (req.method === "GET" && match) {
    const body = PRICING[match[1]] || { amount: 99.0, currency: "USD" };
    res.statusCode = 200;
    res.end(JSON.stringify(body));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "NOT_FOUND", message: "no mock route for " + (req.url || "") }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pricing-service mock listening on 0.0.0.0:${PORT}`);
});
