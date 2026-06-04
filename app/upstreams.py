"""Upstream dependency adapters for the Subscription Decision Service.

The decision logic depends on two upstreams: an account-standing service and a
pricing service. Both are abstracted here so the service can run two ways:

- ``UPSTREAM_MODE=stub`` (default): deterministic in-process data. No network,
  no external mocks. This is what CI uses, so a flaky upstream can never be
  mistaken for real schema drift.
- ``UPSTREAM_MODE=http``: real HTTP calls to ``ACCOUNT_API_BASE_URL`` and
  ``PRICING_API_BASE_URL``. The README points these at ``postman mock run``
  local mock servers to demonstrate upstream mocking.
"""

import os

import requests

_STUB_ACCOUNTS = {
    "cust_123": {"standing": "good", "tenureMonths": 24},
    "cust_456": {"standing": "delinquent", "tenureMonths": 3},
}

_STUB_PRICING = {
    "fiber_1g": {"amount": 89.0, "currency": "USD"},
    "fiber_500m": {"amount": 59.0, "currency": "USD"},
    "mobile_unlimited": {"amount": 45.0, "currency": "USD"},
}

_DEFAULT_ACCOUNT = {"standing": "good", "tenureMonths": 1}
_DEFAULT_PRICING = {"amount": 99.0, "currency": "USD"}


def _mode() -> str:
    return os.environ.get("UPSTREAM_MODE", "stub").lower()


def get_account_status(customer_id: str) -> dict:
    if _mode() == "http":
        base = os.environ["ACCOUNT_API_BASE_URL"].rstrip("/")
        resp = requests.get(f"{base}/accounts/{customer_id}", timeout=5)
        resp.raise_for_status()
        return resp.json()
    return dict(_STUB_ACCOUNTS.get(customer_id, _DEFAULT_ACCOUNT))


def get_pricing(sku: str) -> dict:
    if _mode() == "http":
        base = os.environ["PRICING_API_BASE_URL"].rstrip("/")
        resp = requests.get(f"{base}/prices/{sku}", timeout=5)
        resp.raise_for_status()
        return resp.json()
    return dict(_STUB_PRICING.get(sku, _DEFAULT_PRICING))
