// Local upstream mock: account-standing service (UPSTREAM_MODE=http variant).
//
// Run either way:
//   postman mock run postman/mocks/account-service.json
//   node postman/mocks/account-service.js
//
// Binds 0.0.0.0 so a Docker container can reach it through
// host.docker.internal:host-gateway. A mock bound to 127.0.0.1 would be
// unreachable from inside the container.
const http = require("http");

const PORT = Number(process.env.PORT || 9101);

const ACCOUNTS = {
  cust_123: { standing: "good", tenureMonths: 24 },
  cust_456: { standing: "delinquent", tenureMonths: 3 },
};

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const match = /^\/accounts\/([^/?]+)/.exec(req.url || "");
  if (req.method === "GET" && match) {
    const body = ACCOUNTS[match[1]] || { standing: "good", tenureMonths: 1 };
    res.statusCode = 200;
    res.end(JSON.stringify(body));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "NOT_FOUND", message: "no mock route for " + (req.url || "") }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`account-service mock listening on 0.0.0.0:${PORT}`);
});
