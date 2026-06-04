"""Subscription Decision Service.

A deliberately small Flask service whose runtime responses are governed by
``openapi/openapi.yaml``. The point of the demo is the gate around it: CI builds
this service, runs it, and replays a Postman contract collection against the
running process. If a response stops matching the spec, the contract run fails
the pull request before anything is deployed.

Two upstream dependencies (account standing, pricing) are abstracted behind
``upstreams.py`` so the same service can run with deterministic in-process stubs
(``UPSTREAM_MODE=stub``, the default) or against real HTTP mocks
(``UPSTREAM_MODE=http``). See the README for the upstream-mocking variant.
"""

import os
import uuid

from flask import Flask, jsonify, request

from upstreams import get_account_status, get_pricing

app = Flask(__name__)

# In-memory decision store, reset on every process start. A fresh container
# always knows the seeded decision and nothing else, which keeps the demo
# reproducible across runs.
_DECISIONS: dict[str, dict] = {}

ALLOWED_SKUS = {"fiber_1g", "fiber_500m", "mobile_unlimited"}

# Stable id that the OpenAPI spec advertises as the decisionId path-parameter
# example, so the generated contract GET validates the 200 schema instead of a
# 404 branch.
SEED_DECISION_ID = "dec_demo_0001"


def _drop_currency() -> bool:
    """Negative-proof toggle.

    When DROP_CURRENCY=true the service omits the required price.currency field
    from its responses. The OpenAPI contract still requires currency, so the
    contract collection goes red while the curated smoke collection (which never
    asserts currency) stays green. This is the one-flag drift the demo shows.
    """
    return os.environ.get("DROP_CURRENCY", "false").lower() == "true"


def _build_decision(decision_id: str, customer_id: str, sku: str) -> dict:
    account = get_account_status(customer_id)
    pricing = get_pricing(sku)

    eligible = account["standing"] == "good"
    reasons = ["ACCOUNT_IN_GOOD_STANDING"] if eligible else ["ACCOUNT_NOT_ELIGIBLE"]
    if account["tenureMonths"] >= 12:
        reasons.append("TENURE_DISCOUNT_APPLIED")

    price = {"amount": pricing["amount"]}
    if not _drop_currency():
        price["currency"] = pricing["currency"]

    return {
        "decisionId": decision_id,
        "customerId": customer_id,
        "sku": sku,
        "eligible": eligible,
        "price": price,
        "reasons": reasons,
    }


def _seed() -> None:
    _DECISIONS[SEED_DECISION_ID] = _build_decision(SEED_DECISION_ID, "cust_123", "fiber_1g")


_seed()


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/decisions")
def create_decision():
    body = request.get_json(silent=True) or {}
    customer_id = body.get("customerId")
    sku = body.get("sku")

    if not customer_id or not sku:
        return jsonify({"code": "INVALID_REQUEST", "message": "customerId and sku are required"}), 400
    if sku not in ALLOWED_SKUS:
        return jsonify({"code": "UNKNOWN_SKU", "message": f"sku '{sku}' is not offered"}), 400

    decision_id = "dec_" + uuid.uuid4().hex[:12]
    decision = _build_decision(decision_id, customer_id, sku)
    _DECISIONS[decision_id] = decision
    return jsonify(decision), 200


@app.get("/decisions/<decision_id>")
def get_decision(decision_id: str):
    decision = _DECISIONS.get(decision_id)
    if decision is None:
        return jsonify({"code": "NOT_FOUND", "message": "decision not found"}), 404
    return jsonify(decision), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
